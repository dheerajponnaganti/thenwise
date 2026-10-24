// Postgres backend (spec 04 §4). Same behaviour as the Files store; the database is the truth.
// Every query filters by scope. Every write is one transaction that also appends to `events`.
// Search ranks with ts_rank_cd over weighted fields. That is not BM25: scores differ from Files mode.

import type { Pool, PoolClient } from 'pg'

import { cryptoRandom, newId } from '../core/ids.ts'
import { resolveLinks } from '../core/graph.ts'
import { ID_PREFIX, SCHEMA_VERSION } from '../core/model.ts'
import type { Edge, EdgeType, ParsedNote, Status } from '../core/model.ts'
import { parseNote } from '../core/note.ts'
import { applyStatusRules } from '../core/status-rules.ts'
import { StoreError } from '../core/store.ts'
import type { LinksQuery, ManifestData, Neighbour, NodeInput, NodeRecord, Scored, SearchQuery, Store, StoreStats } from '../core/store.ts'
import { queryTerms } from '../core/tokenize.ts'
import { DEFAULT_CONFIG, normPath, normUrl } from '../core/vault-index.ts'
import type { IndexConfig, VaultIndex } from '../core/vault-index.ts'
import { serializeNote, slug, TYPE_FOLDER } from '../store-files/files-store.ts'

export interface Scope {
  kind: string
  key: string
}

export interface PgStoreOptions {
  /** Set on every transaction as app.principal, so row-level security applies when the role is not a superuser. */
  principal?: string
  /** Recorded on events that have no author of their own. */
  actor?: string
  hubs?: IndexConfig['hubs']
}

export interface ChangeEvent {
  seq: string
  id: string
  at: string
  actor: string
  op: string
  target: string
  payload: unknown
  idempotencyKey: string
}

type Row = Record<string, unknown>

const COLS = 'id, type, path, title, summary, body, aliases, tags, headings, links, status, confidence, origin, version, author, paths, urls, done, due, extra'
/** ts_rank_cd weights in the order {D, C, B, A}: body, headings, summary, title and aliases. */
const RANK_WEIGHTS = '{0.2,0.4,0.7,1.0}'
const MAX_TERMS = 24

const json = (v: unknown) => JSON.stringify(v)
const iso = (s: string | null | undefined): string | null => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null)
const num = (v: unknown) => Number(v)

function newEventId(): string {
  return newId('evt', Date.now(), cryptoRandom)
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const
  readonly pool: Pool
  readonly scope: Scope
  private readonly opts: PgStoreOptions
  private readonly hubConfig: IndexConfig['hubs']

  constructor(pool: Pool, scope: Scope, opts: PgStoreOptions = {}) {
    this.pool = pool
    this.scope = scope
    this.opts = opts
    this.hubConfig = opts.hubs ?? DEFAULT_CONFIG.hubs
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>, write = false): Promise<T> {
    const c = await this.pool.connect()
    try {
      await c.query(write ? 'begin' : 'begin read only')
      if (this.opts.principal !== undefined) await c.query("select set_config('app.principal', $1, true)", [this.opts.principal])
      if (write) {
        // One writer per scope at a time: edges are derived from the whole scope, and events must commit in order.
        await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${this.scope.kind}:${this.scope.key}`])
      }
      const out = await fn(c)
      await c.query('commit')

      return out
    } catch (e) {
      await c.query('rollback').catch(() => undefined)
      throw e
    } finally {
      c.release()
    }
  }

  // ---- reading -----------------------------------------------------------------------------

  private async hydrate(c: PoolClient, rows: Row[]): Promise<NodeRecord[]> {
    if (rows.length === 0) return []
    const src = await c.query('select node_id, kind, ref, at, hash from sources where scope_kind = $1 and scope_key = $2 and node_id = any($3) order by node_id, ord', [this.scope.kind, this.scope.key, rows.map(r => r.id)])
    const byNode = new Map<string, ParsedNote['sources']>()
    for (const s of src.rows) {
      const list = byNode.get(s.node_id as string) ?? []
      list.push({ kind: s.kind, ref: s.ref, hash: s.hash ?? null, at: s.at ?? null })
      byNode.set(s.node_id as string, list)
    }

    return rows.map(r => {
      const x = (r.extra ?? {}) as { raw?: Record<string, string | null>; issues?: string[]; hasFrontMatter?: boolean; bodyLines?: number }

      return {
        path: r.path as string,
        id: r.id as string,
        type: r.type,
        title: r.title,
        summary: r.summary,
        aliases: r.aliases,
        tags: r.tags,
        status: r.status,
        confidence: r.confidence,
        origin: r.origin,
        validFrom: x.raw?.validFrom ?? null,
        validTo: x.raw?.validTo ?? null,
        recordedAt: x.raw?.recordedAt ?? null,
        updatedAt: x.raw?.updatedAt ?? null,
        version: r.version,
        author: r.author,
        sources: byNode.get(r.id as string) ?? [],
        paths: r.paths,
        urls: r.urls,
        done: r.done ?? null,
        due: r.due ?? null,
        headings: r.headings,
        body: r.body,
        bodyLines: x.bodyLines ?? (r.body as string).split('\n').length,
        links: r.links,
        issues: x.issues ?? [],
        hasFrontMatter: x.hasFrontMatter ?? false,
      } as NodeRecord
    })
  }

  private async load(c: PoolClient, ids: string[]): Promise<NodeRecord[]> {
    if (ids.length === 0) return []
    const r = await c.query(`select ${COLS} from nodes where scope_kind = $1 and scope_key = $2 and id = any($3)`, [this.scope.kind, this.scope.key, ids])

    return this.hydrate(c, r.rows)
  }

  async get(id: string): Promise<NodeRecord | null> {
    return this.tx(async c => (await this.load(c, [id]))[0] ?? null)
  }

  async getMany(ids: string[]): Promise<Map<string, NodeRecord>> {
    // Bodies are included: they are already in the row, and the Files store returns them too.
    return this.tx(async c => new Map((await this.load(c, ids)).map(n => [n.id, n])))
  }

  async search(q: SearchQuery): Promise<Scored[]> {
    const terms = queryTerms(q.text).slice(0, MAX_TERMS)
    if (terms.length === 0) return []

    return this.tx(async c => {
      const s = this.scope
      const seeds = Math.max(q.limit * 3, 10)
      // Terms are OR-ed like the Files lexicon; plainto_tsquery keeps user text from becoming query syntax.
      const tsq = terms.map((_, i) => `plainto_tsquery('english', $${i + 6})`).join(' || ')
      const visible = `n.scope_kind = $1 and n.scope_key = $2 and ($3::text[] is null or n.type = any($3)) and n.status not in ('rejected', 'archived') and ($4 or n.status <> 'inbox')`
      const types = q.types ?? null
      let hits = (
        await c.query<{ id: string; score: number }>(
          `select n.id, ts_rank_cd('${RANK_WEIGHTS}', n.tsv, query.q, 32) as score from nodes n, (select ${tsq} as q) query
           where ${visible} and n.tsv @@ query.q order by score desc, n.id limit $5`,
          [s.kind, s.key, types, q.includeInbox, seeds, ...terms],
        )
      ).rows.map(r => ({ id: r.id, score: Number(r.score), why: [] as string[] }))
      let fuzzy = false
      if (hits.length === 0) {
        // Typos and near names: trigram similarity on the lowercased title (served by the GIN index).
        fuzzy = true
        hits = (
          await c.query<{ id: string; score: number }>(
            `select n.id, similarity(lower(n.title), lower($6)) * 0.5 as score from nodes n
             where ${visible} and lower(n.title) % lower($6) order by score desc, n.id limit $5`,
            [s.kind, s.key, types, q.includeInbox, seeds, q.text],
          )
        ).rows.map(r => ({ id: r.id, score: Number(r.score), why: ['title: similar name'] }))
      }
      if (hits.length === 0) return []
      if (!fuzzy) {
        // ts_filter keeps one weight class of the stored vector: A is title and aliases, B summary, C headings, D body.
        const why = await c.query<{ id: string; field: string; term: string }>(
          `select n.id, f.field, t.term from nodes n
           cross join unnest($4::text[]) as t(term)
           cross join (values ('title', '{a}'), ('summary', '{b}'), ('headings', '{c}'), ('body', '{d}')) as f(field, w)
           where n.scope_kind = $1 and n.scope_key = $2 and n.id = any($3)
             and ts_filter(n.tsv, f.w::"char"[]) @@ plainto_tsquery('english', t.term)`,
          [s.kind, s.key, hits.map(h => h.id), terms],
        )
        const by = new Map<string, Map<string, string[]>>()
        for (const r of why.rows) {
          const fields = by.get(r.id) ?? new Map<string, string[]>()
          fields.set(r.field, [...(fields.get(r.field) ?? []), r.term])
          by.set(r.id, fields)
        }
        for (const h of hits) {
          const fields = by.get(h.id)
          h.why = ['title', 'summary', 'headings', 'body'].filter(f => fields?.has(f)).map(f => `${f}: ${fields!.get(f)!.join(', ')}`)
        }
      }

      return applyStatusRules(hits, {
        includeInbox: q.includeInbox,
        limit: q.limit,
        lookup: async ids => {
          const r = await c.query<{ id: string; status: Status; title: string }>('select id, status, title from nodes where scope_kind = $1 and scope_key = $2 and id = any($3)', [s.kind, s.key, ids])

          return new Map(r.rows.map(x => [x.id, { status: x.status, title: x.title }]))
        },
        head: id => this.headIn(c, id),
      })
    })
  }

  async matchExact(key: { path?: string; url?: string }): Promise<{ bySource: string[]; byEntity: string[] }> {
    const s = this.scope

    return this.tx(async c => {
      const norm = key.path ? normPath(key.path) : key.url ? normUrl(key.url) : ''
      const bySource = norm ? (await c.query<{ node_id: string }>("select node_id from match_keys where scope_kind = $1 and scope_key = $2 and kind = 'source' and key = $3 order by node_id", [s.kind, s.key, norm])).rows.map(r => r.node_id) : []
      // A prefix must end at a folder boundary; the longest prefix comes first.
      const byEntity = key.path
        ? (
            await c.query<{ node_id: string }>(
              `select node_id from match_keys where scope_kind = $1 and scope_key = $2 and kind = 'entity' and ($3 = key or starts_with($3, key || '/'))
               order by length(key) desc, node_id`,
              [s.kind, s.key, norm],
            )
          ).rows.map(r => r.node_id)
        : []

      return { bySource, byEntity: [...new Set(byEntity)] }
    })
  }

  // ---- graph -------------------------------------------------------------------------------

  /** Degree at or above which a node is a hub: max(minDegree, the percentile of all nodes' degrees), as in findHubs. */
  private async hubCut(c: PoolClient): Promise<number> {
    const { kind, key } = this.scope
    const { minDegree, percentile } = this.hubConfig
    const n = num((await c.query('select count(*) as n from nodes where scope_kind = $1 and scope_key = $2', [kind, key])).rows[0].n)
    if (n === 0) return minDegree
    const rank = Math.min(n, Math.max(1, Math.ceil((percentile / 100) * n)))
    const r = await c.query(
      `select coalesce(d.deg, 0) as deg from nodes nd
       left join (select id, count(*) as deg from (
         select from_id as id from edges where scope_kind = $1 and scope_key = $2 and valid_to is null
         union all select to_id from edges where scope_kind = $1 and scope_key = $2 and valid_to is null) x group by id) d on d.id = nd.id
       where nd.scope_kind = $1 and nd.scope_key = $2 order by deg offset $3 limit 1`,
      [kind, key, rank - 1],
    )

    return Math.max(minDegree, num(r.rows[0]?.deg ?? 0))
  }

  /** Ids of nodes the config lists by path or title. */
  private async excludedHubs(c: PoolClient): Promise<string[]> {
    const out: string[] = []
    for (const p of this.hubConfig.exclude) {
      const r = await c.query('select id from nodes where scope_kind = $1 and scope_key = $2 and (path = $3 or title = $3) order by id limit 1', [this.scope.kind, this.scope.key, p])
      if (r.rows[0]) out.push(r.rows[0].id)
    }

    return out
  }

  async links(q: LinksQuery): Promise<Neighbour[]> {
    if (q.ids.length === 0) return []

    return this.tx(async c => {
      const cut = await this.hubCut(c)
      const excluded = await this.excludedHubs(c)
      // Edges are walked in both directions. Hubs are reached but not expanded past hop 1 (a hub seed is expanded).
      const r = await c.query<{ id: string; hop: number; via: EdgeType; from_id: string }>(
        `with recursive live as (
           select from_id, to_id, type from edges where scope_kind = $1 and scope_key = $2 and valid_to is null
         ), e as (
           select from_id as a, to_id as b, type from live where $4::text[] is null or type = any($4)
           union all
           select to_id, from_id, type from live where $4::text[] is null or type = any($4)
         ), hubs as (
           select id from (select from_id as id from live union all select to_id from live) d group by id having count(*) >= $6
           union select unnest($7::text[])
         ), walk(id, hop, via, from_id) as (
           select n.id, 0, 'mentions'::text, n.id from nodes n where n.scope_kind = $1 and n.scope_key = $2 and n.id = any($3)
           union all
           select e.b, w.hop + 1, e.type, w.id from walk w join e on e.a = w.id
           where w.hop < $5 and (w.hop = 0 or not exists (select 1 from hubs h where h.id = w.id))
         ) cycle id set is_cycle using path
         select * from (
           select distinct on (id) id, hop, via, from_id from walk where hop > 0 and not is_cycle and not (id = any($3)) order by id, hop, from_id, via
         ) found order by hop, id limit $8`,
        [this.scope.kind, this.scope.key, q.ids, q.types ?? null, q.depth, cut, excluded, q.limit],
      )

      return r.rows.map(x => ({ id: x.id, hop: x.hop, via: x.via, from: x.from_id }))
    })
  }

  async edgesOf(ids: string[], types: EdgeType[]): Promise<{ type: EdgeType; from: string; to: string }[]> {
    if (ids.length === 0 || types.length === 0) return []
    const r = await this.tx(c =>
      c.query<{ type: EdgeType; from_id: string; to_id: string }>(
        `select type, from_id, to_id from edges where scope_kind = $1 and scope_key = $2 and valid_to is null and type = any($3) and (from_id = any($4) or to_id = any($4)) order by from_id, to_id, type`,
        [this.scope.kind, this.scope.key, types, ids],
      ),
    )

    return r.rows.map(x => ({ type: x.type, from: x.from_id, to: x.to_id }))
  }

  /** Follows the newest superseding node (the lexically last id when several); a loop maps the node to itself. */
  private async headIn(c: PoolClient, id: string): Promise<string> {
    const r = await c.query<{ cyc: boolean | null; head: string }>(
      `with recursive chain(id, n) as (
         select ($3::text collate "C"), 0
         union all
         select l.next, ch.n + 1 from chain ch, lateral (
           select max(e.from_id collate "C") as next from edges e
           where e.scope_kind = $1 and e.scope_key = $2 and e.type = 'supersedes' and e.valid_to is null and e.to_id = ch.id) l
         where l.next is not null
       ) cycle id set is_cycle using path
       select (select bool_or(is_cycle) from chain) as cyc, (select id from chain order by n desc limit 1) as head`,
      [this.scope.kind, this.scope.key, id],
    )
    const row = r.rows[0]!

    return row.cyc ? id : row.head
  }

  async supersedeHead(id: string): Promise<string> {
    return this.tx(c => this.headIn(c, id))
  }

  private async degreeIn(c: PoolClient, id: string): Promise<number> {
    const r = await c.query("select count(*) as n from edges where scope_kind = $1 and scope_key = $2 and valid_to is null and (from_id = $3 or to_id = $3)", [this.scope.kind, this.scope.key, id])

    return num(r.rows[0].n)
  }

  async isHub(id: string): Promise<boolean> {
    return this.tx(async c => {
      if (!(await c.query('select 1 from nodes where scope_kind = $1 and scope_key = $2 and id = $3', [this.scope.kind, this.scope.key, id])).rows[0]) return false
      if ((await this.excludedHubs(c)).includes(id)) return true

      return (await this.degreeIn(c, id)) >= (await this.hubCut(c))
    })
  }

  // ---- summaries ---------------------------------------------------------------------------

  private async statsIn(c: PoolClient): Promise<StoreStats> {
    const { kind, key } = this.scope
    const byType: Record<string, number> = {}
    let notes = 0
    for (const r of (await c.query('select type, count(*) as n from nodes where scope_kind = $1 and scope_key = $2 group by type', [kind, key])).rows) {
      byType[r.type] = num(r.n)
      notes += num(r.n)
    }
    const edges = num((await c.query('select count(*) as n from edges where scope_kind = $1 and scope_key = $2 and valid_to is null', [kind, key])).rows[0].n)
    const cut = await this.hubCut(c)
    const excluded = await this.excludedHubs(c)
    const hubs = num(
      (
        await c.query(
          `select count(*) as n from nodes nd left join (select id, count(*) as deg from (
             select from_id as id from edges where scope_kind = $1 and scope_key = $2 and valid_to is null
             union all select to_id from edges where scope_kind = $1 and scope_key = $2 and valid_to is null) x group by id) d on d.id = nd.id
           where nd.scope_kind = $1 and nd.scope_key = $2 and (coalesce(d.deg, 0) >= $3 or nd.id = any($4))`,
          [kind, key, cut, excluded],
        )
      ).rows[0].n,
    )
    // Unresolved links are not stored; resolving them again is the same work the Files index does on every change.
    const nodes = await this.linkables(c)
    const unresolved = resolveLinks(nodes).unresolved.length

    return { notes, byType, edges, hubs, unresolved }
  }

  async stats(): Promise<StoreStats> {
    return this.tx(c => this.statsIn(c))
  }

  async manifestData(opts: { maxTopics: number }): Promise<ManifestData> {
    const { kind, key } = this.scope
    const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)

    return this.tx(async c => {
      const live = async (type: string, extra = '') =>
        this.hydrate(c, (await c.query(`select ${COLS} from nodes where scope_kind = $1 and scope_key = $2 and type = $3 and status = 'active' ${extra}`, [kind, key, type])).rows)
      const rules = (await live('rule')).sort(byTitle)
      const tasks = (await live('task', 'and done is distinct from true')).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || byTitle(a, b))
      // Entities ranked by how many live decisions, findings, rules and tasks are about them.
      // shortcut: ranks in JS over all live entities, fine to tens of thousands of entities; push into SQL beyond that.
      const counts = await c.query<{ id: string; n: string }>(
        `select en.id, count(f.id) as n from nodes en
         left join edges e on e.scope_kind = en.scope_kind and e.scope_key = en.scope_key and e.to_id = en.id and e.type = 'about' and e.valid_to is null
         left join nodes f on f.scope_kind = e.scope_kind and f.scope_key = e.scope_key and f.id = e.from_id and f.status = 'active' and f.type <> 'entity'
         where en.scope_kind = $1 and en.scope_key = $2 and en.type = 'entity' and en.status = 'active' group by en.id`,
        [kind, key],
      )
      const entities = new Map((await live('entity')).map(n => [n.id, n]))
      const topics = counts.rows
        .map(r => ({ node: entities.get(r.id)!, count: num(r.n) }))
        .sort((a, b) => b.count - a.count || byTitle(a.node, b.node))
        .slice(0, opts.maxTopics)
      const st = await this.statsIn(c)

      return { rules, tasks, topics, notes: st.notes, byType: st.byType }
    })
  }

  // ---- writing -----------------------------------------------------------------------------

  private async linkables(c: PoolClient) {
    const r = await c.query('select id, path, title, aliases, links from nodes where scope_kind = $1 and scope_key = $2', [this.scope.kind, this.scope.key])

    return r.rows.map(x => ({ id: x.id as string, path: x.path as string, title: x.title as string, aliases: x.aliases as string[], links: x.links as ParsedNote['links'] }))
  }

  private async insertEdges(c: PoolClient, edges: Edge[]): Promise<void> {
    if (edges.length === 0) return
    const at = new Date().toISOString()
    await c.query(
      `insert into edges (scope_kind, scope_key, id, type, from_id, to_id, valid_from, recorded_at, confidence)
       select $1, $2, x.id, x.type, x.f, x.t, coalesce(n.valid_from, n.recorded_at, $3::timestamptz), $3::timestamptz, n.confidence
       from unnest($4::text[], $5::text[], $6::text[], $7::text[]) as x(id, type, f, t)
       join nodes n on n.scope_kind = $1 and n.scope_key = $2 and n.id = x.f`,
      [this.scope.kind, this.scope.key, at, edges.map(() => newId('edg', Date.now(), cryptoRandom)), edges.map(e => e.type), edges.map(e => e.from), edges.map(e => e.to)],
    )
  }

  /**
   * Recomputes the scope's edges from the raw links, with the same resolver as Files mode, and applies the difference.
   * shortcut: re-resolves the whole scope on each write (one query of titles and links); incremental resolution when scopes pass ~50k notes.
   */
  private async rebuildEdges(c: PoolClient): Promise<void> {
    const want = resolveLinks(await this.linkables(c)).edges
    const sig = (e: Edge) => `${e.type}\u0000${e.from}\u0000${e.to}`
    const have = (await c.query('select type, from_id, to_id from edges where scope_kind = $1 and scope_key = $2', [this.scope.kind, this.scope.key])).rows.map(r => ({ type: r.type as EdgeType, from: r.from_id as string, to: r.to_id as string }))
    const wantSigs = new Set(want.map(sig))
    const haveSigs = new Set(have.map(sig))
    const gone = have.filter(e => !wantSigs.has(sig(e)))
    if (gone.length > 0) {
      await c.query(
        `delete from edges e using unnest($3::text[], $4::text[], $5::text[]) as x(type, f, t)
         where e.scope_kind = $1 and e.scope_key = $2 and e.type = x.type and e.from_id = x.f and e.to_id = x.t`,
        [this.scope.kind, this.scope.key, gone.map(e => e.type), gone.map(e => e.from), gone.map(e => e.to)],
      )
    }
    await this.insertEdges(c, want.filter(e => !haveSigs.has(sig(e))))
  }

  /** Inserts or replaces one node with its sources and exact-match keys. */
  private async upsertNode(c: PoolClient, id: string, n: ParsedNote): Promise<void> {
    const { kind, key } = this.scope
    const extra = { raw: { validFrom: n.validFrom, validTo: n.validTo, recordedAt: n.recordedAt, updatedAt: n.updatedAt }, issues: n.issues, hasFrontMatter: n.hasFrontMatter, bodyLines: n.bodyLines }
    await c.query(
      `insert into nodes (scope_kind, scope_key, id, type, path, title, summary, body, aliases, tags, headings, links, status, confidence, origin,
                          valid_from, valid_to, recorded_at, updated_at, version, author, paths, urls, done, due, extra)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23::jsonb, $24, $25, $26::jsonb)
       on conflict (scope_kind, scope_key, id) do update set
         type = excluded.type, path = excluded.path, title = excluded.title, summary = excluded.summary, body = excluded.body,
         aliases = excluded.aliases, tags = excluded.tags, headings = excluded.headings, links = excluded.links,
         status = excluded.status, confidence = excluded.confidence, origin = excluded.origin,
         valid_from = excluded.valid_from, valid_to = excluded.valid_to, recorded_at = excluded.recorded_at, updated_at = excluded.updated_at,
         version = excluded.version, author = excluded.author, paths = excluded.paths, urls = excluded.urls, done = excluded.done, due = excluded.due, extra = excluded.extra`,
      [kind, key, id, n.type, n.path, n.title, n.summary, n.body, json(n.aliases), json(n.tags), json(n.headings), json(n.links), n.status, n.confidence, n.origin,
        iso(n.validFrom), iso(n.validTo), iso(n.recordedAt), iso(n.updatedAt), n.version, n.author, json(n.paths), json(n.urls), n.done, n.due, json(extra)],
    )
    await c.query('delete from sources where scope_kind = $1 and scope_key = $2 and node_id = $3', [kind, key, id])
    if (n.sources.length > 0) {
      await c.query(
        `insert into sources (scope_kind, scope_key, node_id, ord, kind, ref, at, hash)
         select $1, $2, $3, x.ord, x.kind, x.ref, x.at, x.hash from unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::text[]) as x(ord, kind, ref, at, hash)`,
        [kind, key, id, n.sources.map((_, i) => i), n.sources.map(s => s.kind), n.sources.map(s => s.ref), n.sources.map(s => s.at), n.sources.map(s => s.hash)],
      )
    }
    await c.query('delete from match_keys where scope_kind = $1 and scope_key = $2 and node_id = $3', [kind, key, id])
    const cited = new Set<string>()
    for (const s of n.sources) if (s.kind === 'file') cited.add(normPath(s.ref))
    else if (s.kind === 'url') cited.add(normUrl(s.ref))
    for (const u of n.urls) cited.add(normUrl(u))
    const covers = new Set(n.type === 'entity' ? n.paths.map(normPath) : [])
    cited.delete('')
    covers.delete('')
    const keys = [...[...cited].map(k => ['source', k]), ...[...covers].map(k => ['entity', k])]
    if (keys.length > 0) {
      await c.query('insert into match_keys (scope_kind, scope_key, kind, key, node_id) select $1, $2, x.kind, x.key, $3 from unnest($4::text[], $5::text[]) as x(kind, key)', [kind, key, id, keys.map(k => k[0]), keys.map(k => k[1])])
    }
  }

  /** The id of an earlier write with this idempotency key, or null. */
  private async seenKey(c: PoolClient, key: string): Promise<string | null> {
    const r = await c.query('select target from events where scope_kind = $1 and scope_key = $2 and idempotency_key = $3', [this.scope.kind, this.scope.key, key])

    return (r.rows[0]?.target as string | undefined) ?? null
  }

  private async appendEvent(c: PoolClient, e: { at: string; actor: string; op: string; target: string; payload: unknown; key: string }): Promise<void> {
    await c.query(
      'insert into events (scope_kind, scope_key, id, at, actor, op, target, payload, idempotency_key, schema_version) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)',
      [this.scope.kind, this.scope.key, newEventId(), iso(e.at) ?? new Date().toISOString(), e.actor, e.op, e.target, e.payload === null ? null : json(e.payload), e.key, SCHEMA_VERSION],
    )
  }

  /**
   * Writes a new node, or a new version of an agent-written one. Human-written and imported nodes are never rewritten:
   * a change to one is a new node that supersedes it (spec 06 §3). A repeated `idempotencyKey` returns the earlier result.
   */
  async put(input: NodeInput, opts: { id?: string; expectedVersion?: number; now: string; newId: (prefix: string) => string; idempotencyKey?: string }): Promise<NodeRecord> {
    return this.tx(async c => {
      if (opts.idempotencyKey) {
        const seen = await this.seenKey(c, opts.idempotencyKey)
        if (seen) return (await this.load(c, [seen]))[0]!
      }
      const existing = opts.id ? (await this.load(c, [opts.id]))[0] : undefined
      if (opts.id && !existing) throw new StoreError('not_found', `no node ${opts.id}`)
      let id: string
      let text: string
      let path: string
      if (existing) {
        if (existing.confidence !== 'agent') throw new StoreError('invalid', `"${existing.title}" was written by ${existing.confidence === 'human' ? 'a person' : 'an import'}; propose a new note that supersedes it`)
        if (opts.expectedVersion !== undefined && opts.expectedVersion !== existing.version) throw new StoreError('conflict', `"${existing.title}" is at version ${existing.version}, not ${opts.expectedVersion}`)
        id = existing.id
        path = existing.path
        text = serializeNote(id, input, { now: opts.now, version: existing.version + 1, recordedAt: existing.recordedAt ?? opts.now })
      } else {
        id = opts.newId(ID_PREFIX[input.type])
        const base = `${TYPE_FOLDER[input.type]}/${slug(input.title)}`
        const taken = new Set((await c.query<{ path: string }>('select path from nodes where scope_kind = $1 and scope_key = $2 and path like $3', [this.scope.kind, this.scope.key, `${base}%`])).rows.map(r => r.path))
        path = `${base}.md`
        for (let n = 2; taken.has(path); n++) path = `${base}-${n}.md`
        text = serializeNote(id, input, { now: opts.now, version: 1, recordedAt: opts.now })
      }
      // Parsing the text a Files store would write keeps the two backends' records identical.
      const note = parseNote(path, text)
      await this.upsertNode(c, id, note)
      await this.rebuildEdges(c)
      await this.appendEvent(c, { at: opts.now, actor: input.author || this.opts.actor || 'system', op: existing ? 'node.patch' : 'node.put', target: id, payload: { node: input, version: note.version }, key: opts.idempotencyKey ?? `put:${newEventId()}` })

      return (await this.load(c, [id]))[0]!
    }, true)
  }

  /** Changes a node's status in place (accept, reject, retire). Version and every other field stay. */
  async setStatus(id: string, status: Status, opts: { now: string; validTo?: string; actor?: string; idempotencyKey?: string }): Promise<NodeRecord> {
    return this.tx(async c => {
      if (opts.idempotencyKey) {
        const seen = await this.seenKey(c, opts.idempotencyKey)
        if (seen) return (await this.load(c, [seen]))[0]!
      }
      const row = (await c.query('select extra, valid_to from nodes where scope_kind = $1 and scope_key = $2 and id = $3 for update', [this.scope.kind, this.scope.key, id])).rows[0]
      if (!row) throw new StoreError('not_found', `no node ${id}`)
      const extra = row.extra as { raw: Record<string, string | null> }
      extra.raw = { ...extra.raw, updatedAt: opts.now, ...(opts.validTo ? { validTo: opts.validTo } : {}) }
      await c.query(
        'update nodes set status = $4, updated_at = $5, valid_to = case when $6::text is null then valid_to else $7::timestamptz end, extra = $8::jsonb where scope_kind = $1 and scope_key = $2 and id = $3',
        [this.scope.kind, this.scope.key, id, status, iso(opts.now), opts.validTo ?? null, iso(opts.validTo), json(extra)],
      )
      await this.appendEvent(c, { at: opts.now, actor: opts.actor ?? this.opts.actor ?? 'system', op: status === 'archived' || status === 'superseded' ? 'node.retire' : 'node.patch', target: id, payload: { status, ...(opts.validTo ? { validTo: opts.validTo } : {}) }, key: opts.idempotencyKey ?? `status:${newEventId()}` })

      return (await this.load(c, [id]))[0]!
    }, true)
  }

  /** Events of this scope after `cursor` (a previous result's cursor, or null for the start), oldest first. */
  async changesSince(cursor: string | null, limit: number): Promise<{ events: ChangeEvent[]; cursor: string }> {
    const after = cursor && /^\d+$/.test(cursor) ? cursor : '0'
    const r = await this.tx(c =>
      c.query('select seq, id, at, actor, op, target, payload, idempotency_key from events where scope_kind = $1 and scope_key = $2 and seq > $3 order by seq limit $4', [this.scope.kind, this.scope.key, after, limit]),
    )
    const events = r.rows.map(x => ({ seq: String(x.seq), id: x.id, at: (x.at as Date).toISOString(), actor: x.actor, op: x.op, target: x.target, payload: x.payload, idempotencyKey: x.idempotency_key }))

    return { events, cursor: events.at(-1)?.seq ?? after }
  }

  /**
   * Loads a parsed vault: every note by its id (provisional for notes without one) and the edges the Files index resolved.
   * Re-running updates the notes in place. Notes already in the scope but not in the vault are left alone.
   */
  async importIndex(index: VaultIndex, opts: { now?: string } = {}): Promise<{ notes: number; edges: number; unresolved: number }> {
    index.refreshGraph()
    const now = opts.now ?? new Date().toISOString()
    const run = newEventId()

    return this.tx(async c => {
      await c.query('insert into scopes (scope_kind, scope_key) values ($1, $2) on conflict do nothing', [this.scope.kind, this.scope.key])
      for (const [id, n] of index.byId) {
        await this.upsertNode(c, id, n)
        await this.appendEvent(c, { at: now, actor: this.opts.actor ?? 'import', op: 'node.put', target: id, payload: { via: 'import', path: n.path }, key: `import:${run}:${id}` })
      }
      await c.query('delete from edges where scope_kind = $1 and scope_key = $2', [this.scope.kind, this.scope.key])
      await this.insertEdges(c, index.edges)

      return { notes: index.byId.size, edges: index.edges.length, unresolved: index.unresolved.length }
    }, true)
  }
}
