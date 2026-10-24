// SQLite backend (spec 04 §3): one file is the truth. Search is FTS5 with bm25(); the graph (hubs, supersede
// heads, traversal) is computed in TypeScript from the edges table and cached until the data changes.

import { DatabaseSync } from 'node:sqlite'

import type { Source } from '../core/model.ts'
import { ID_PREFIX, SCHEMA_VERSION } from '../core/model.ts'
import type { EdgeType, ParsedNote, Status } from '../core/model.ts'
import { adjacency, findHubs, resolveLinks, supersedeHeads, walkLinks } from '../core/graph.ts'
import type { Adjacency } from '../core/graph.ts'
import type { Edge } from '../core/model.ts'
import { FIELD_WEIGHTS, FIELDS } from '../core/lexicon.ts'
import { parseNote } from '../core/note.ts'
import { applyStatusRules } from '../core/status-rules.ts'
import { StoreError } from '../core/store.ts'
import type { LinksQuery, ManifestData, Neighbour, NodeInput, NodeRecord, Scored, SearchQuery, Store, StoreStats } from '../core/store.ts'
import { queryTerms, tokenize } from '../core/tokenize.ts'
import { DEFAULT_CONFIG, normPath, normUrl } from '../core/vault-index.ts'
import type { IndexConfig } from '../core/vault-index.ts'
import { serializeNote, slug, TYPE_FOLDER } from '../store-files/files-store.ts'

// Rows are read dynamically from node:sqlite; the columns are fixed by the schema below.
type Row = Record<string, any>
type Param = string | number | null

// Numbered by PRAGMA user_version. The FTS table keeps its own copy of the text: it is rebuilt from `nodes` if ever lost.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  body_lines INTEGER NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  headings TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  origin TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT, recorded_at TEXT, updated_at TEXT,
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  urls TEXT NOT NULL DEFAULT '[]',
  done INTEGER,
  due TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  issues TEXT NOT NULL DEFAULT '[]',
  has_front_matter INTEGER NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS nodes_type_status ON nodes(type, status);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_path ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  type TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  PRIMARY KEY (from_id, type, to_id)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id, type);
CREATE TABLE IF NOT EXISTS unresolved (from_id TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sources (node_id TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT, at TEXT, PRIMARY KEY (node_id, ord));
-- Normalised file paths and urls a node cites (its sources and its urls): the lookup for matchExact.
CREATE TABLE IF NOT EXISTS source_keys (key TEXT NOT NULL, node_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS source_keys_key ON source_keys(key);
CREATE TABLE IF NOT EXISTS entity_paths (prefix TEXT NOT NULL, node_id TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, started_at TEXT, ended_at TEXT, title TEXT,
  steps_done INTEGER, steps_total INTEGER, files_written TEXT, urls_fetched TEXT, commands TEXT, commits TEXT, outcome TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL,
  target TEXT NOT NULL, payload TEXT, idempotency_key TEXT UNIQUE NOT NULL, schema_version INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(title, aliases, summary, headings, body, tokenize = 'unicode61');
`

/** Column order of nodes_fts is FIELDS, so the weights line up with bm25()'s arguments. */
const BM25 = `bm25(nodes_fts, ${FIELDS.map(f => FIELD_WEIGHTS[f]).join(', ')})`

const json = (v: unknown) => JSON.stringify(v)
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** Each term as a quoted phrase, joined with OR: operators and punctuation in user text are inert. */
export function ftsQuery(text: string): string {
  return queryTerms(text)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ')
}

interface Graph {
  adj: Adjacency
  hubs: Set<string>
  heads: Map<string, string>
  ids: Set<string>
  edgeCount: number
}

/** A node as stored, plus front-matter fields this version does not know (kept on write, spec 02 §9). */
export interface Stored {
  record: NodeRecord
  extra: Record<string, unknown>
}

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const
  private db: DatabaseSync
  private config: IndexConfig
  private cache: Graph | null = null
  private cacheVersion = -1
  private stale = true

  /** `file` is a path or ':memory:'. */
  constructor(file: string, config: IndexConfig = DEFAULT_CONFIG) {
    this.db = new DatabaseSync(file)
    this.config = config
    const version = (this.get1('PRAGMA user_version') as Row).user_version as number
    if (version > SCHEMA_VERSION) throw new StoreError('unavailable', `${file} has schema ${version}; this build reads up to ${SCHEMA_VERSION}`)
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  get hubConfig(): IndexConfig {
    return this.config
  }

  close(): void {
    this.db.close()
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get1(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: Param[]): void {
    this.db.prepare(sql).run(...params)
  }

  /** All-or-nothing; IMMEDIATE takes the write lock first, so a version check cannot race another process. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')

      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.stale = true
    }
  }

  // ---- reading -------------------------------------------------------------------------------------------

  private load(ids: string[], withBody: boolean): Map<string, NodeRecord> {
    const out = new Map<string, NodeRecord>()
    if (ids.length === 0) return out
    const cols = `id, path, type, title, summary, ${withBody ? 'body' : "'' AS body"}, body_lines, aliases, tags, headings, status, confidence, origin, valid_from, valid_to, recorded_at, updated_at, version, author, paths, urls, done, due, links, issues, has_front_matter`
    const sources = new Map<string, Source[]>()
    for (const s of this.all(`SELECT node_id, kind, ref, hash, at FROM sources WHERE node_id IN (${marks(ids.length)}) ORDER BY node_id, ord`, ...ids)) {
      const list = sources.get(s.node_id) ?? []
      list.push({ kind: s.kind, ref: s.ref, hash: s.hash, at: s.at })
      sources.set(s.node_id, list)
    }
    for (const r of this.all(`SELECT ${cols} FROM nodes WHERE id IN (${marks(ids.length)})`, ...ids)) {
      out.set(r.id, {
        path: r.path, id: r.id, type: r.type, title: r.title, summary: r.summary, body: r.body, bodyLines: r.body_lines,
        aliases: JSON.parse(r.aliases), tags: JSON.parse(r.tags), headings: JSON.parse(r.headings),
        status: r.status, confidence: r.confidence, origin: r.origin,
        validFrom: r.valid_from, validTo: r.valid_to, recordedAt: r.recorded_at, updatedAt: r.updated_at,
        version: r.version, author: r.author, sources: sources.get(r.id) ?? [],
        paths: JSON.parse(r.paths), urls: JSON.parse(r.urls), done: r.done === null ? null : r.done === 1, due: r.due,
        links: JSON.parse(r.links), issues: JSON.parse(r.issues), hasFrontMatter: r.has_front_matter === 1,
      })
    }

    return out
  }

  async get(id: string): Promise<NodeRecord | null> {
    return this.load([id], true).get(id) ?? null
  }

  /** Without bodies (the interface's contract); `bodyLines` is kept. */
  async getMany(ids: string[]): Promise<Map<string, NodeRecord>> {
    return this.load(ids, false)
  }

  /** Every node with its unknown fields, in insertion order: the input of `memory export`. */
  dump(): Stored[] {
    const ids = this.all('SELECT id FROM nodes ORDER BY rowid').map(r => r.id as string)
    const records = this.load(ids, true)
    const extra = new Map(this.all('SELECT id, extra FROM nodes').map(r => [r.id as string, JSON.parse(r.extra) as Record<string, unknown>]))

    return ids.map(id => ({ record: records.get(id)!, extra: extra.get(id) ?? {} }))
  }

  private graph(): Graph {
    const version = (this.get1('PRAGMA data_version') as Row).data_version as number
    if (this.cache && !this.stale && version === this.cacheVersion) return this.cache
    const nodes = this.all('SELECT id, path, title FROM nodes ORDER BY rowid')
    const edges = this.all('SELECT type, from_id, to_id FROM edges ORDER BY rowid').map((r): Edge => ({ type: r.type, from: r.from_id, to: r.to_id }))
    const adj = adjacency(edges)
    const ids = nodes.map(n => n.id as string)
    const exclude = this.config.hubs.exclude.map(p => nodes.find(n => n.path === p || n.title === p)?.id as string | undefined).filter((x): x is string => !!x)
    this.cache = { adj, ids: new Set(ids), hubs: findHubs(ids, adj, { ...this.config.hubs, exclude }), heads: supersedeHeads(edges).head, edgeCount: edges.length }
    this.cacheVersion = version
    this.stale = false

    return this.cache
  }

  async search(q: SearchQuery): Promise<Scored[]> {
    const match = ftsQuery(q.text)
    if (!match) return []
    const types = q.types?.length ? ` AND n.type IN (${marks(q.types.length)})` : ''
    const inbox = q.includeInbox ? '' : " AND n.status != 'inbox'"
    // Seeds are over-fetched so that dropped and redirected hits do not leave the result short.
    const rows = this.all(
      `SELECT n.id, -${BM25} AS score, n.title, n.aliases, n.summary, n.headings, n.body
       FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH ? AND n.status NOT IN ('rejected', 'archived')${inbox}${types}
       ORDER BY score DESC, n.id LIMIT ?`,
      match,
      ...(q.types ?? []),
      Math.max(q.limit * 3, 10),
    )
    const terms = queryTerms(q.text)
    const hits = rows.map(r => {
      const text: Record<string, string> = { title: r.title, aliases: (JSON.parse(r.aliases) as string[]).join(' '), summary: r.summary, headings: (JSON.parse(r.headings) as string[]).join(' '), body: r.body }
      const why: string[] = []
      for (const f of FIELDS) {
        const have = new Set(tokenize(text[f]!))
        const found = terms.filter(t => have.has(t))
        if (found.length) why.push(`${f}: ${found.join(', ')}`)
      }

      return { id: r.id as string, score: r.score as number, why }
    })

    return applyStatusRules(hits, {
      includeInbox: q.includeInbox,
      limit: q.limit,
      lookup: async ids => {
        const info = new Map<string, { status: Status; title: string }>()
        if (ids.length) for (const r of this.all(`SELECT id, status, title FROM nodes WHERE id IN (${marks(ids.length)})`, ...ids)) info.set(r.id, { status: r.status, title: r.title })

        return info
      },
      head: id => this.supersedeHead(id),
    })
  }

  async matchExact(key: { path?: string; url?: string }): Promise<{ bySource: string[]; byEntity: string[] }> {
    const k = key.path ? normPath(key.path) : key.url ? normUrl(key.url) : null
    const bySource = k === null ? [] : this.all('SELECT DISTINCT node_id FROM source_keys WHERE key = ? ORDER BY rowid', k).map(r => r.node_id as string)
    const p = key.path ? normPath(key.path) : null
    // A prefix matches the path itself or a folder above it, never half a folder name.
    const byEntity = p === null ? [] : this.all("SELECT node_id FROM entity_paths WHERE ? = prefix OR substr(?, 1, length(prefix) + 1) = prefix || '/' ORDER BY length(prefix) DESC, node_id", p, p).map(r => r.node_id as string)

    return { bySource, byEntity }
  }

  async links(q: LinksQuery): Promise<Neighbour[]> {
    const g = this.graph()

    return walkLinks(g.adj, g.hubs, id => g.ids.has(id), q.ids, { depth: q.depth, limit: q.limit, ...(q.types ? { types: q.types } : {}) })
  }

  async edgesOf(ids: string[], types: EdgeType[]): Promise<{ type: EdgeType; from: string; to: string }[]> {
    if (ids.length === 0 || types.length === 0) return []
    const rows = this.all(
      `SELECT type, from_id, to_id FROM edges WHERE type IN (${marks(types.length)}) AND (from_id IN (${marks(ids.length)}) OR to_id IN (${marks(ids.length)})) ORDER BY rowid`,
      ...types, ...ids, ...ids,
    )

    return rows.map(r => ({ type: r.type, from: r.from_id, to: r.to_id }))
  }

  async supersedeHead(id: string): Promise<string> {
    return this.graph().heads.get(id) ?? id
  }

  async isHub(id: string): Promise<boolean> {
    return this.graph().hubs.has(id)
  }

  private byType(): Record<string, number> {
    return Object.fromEntries(this.all('SELECT type, count(*) AS n FROM nodes GROUP BY type').map(r => [r.type, r.n as number]))
  }

  private noteCount(): number {
    return (this.get1('SELECT count(*) AS n FROM nodes') as Row).n
  }

  async manifestData(opts: { maxTopics: number }): Promise<ManifestData> {
    const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)
    const live = (type: string) => this.all("SELECT id FROM nodes WHERE type = ? AND status = 'active'", type).map(r => r.id as string)
    const rules = [...this.load(live('rule'), true).values()].sort(byTitle)
    const open = [...this.load(live('task'), true).values()].filter(n => n.done !== true)
    const tasks = open.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || byTitle(a, b))
    const counts = new Map(
      this.all("SELECT e.to_id AS id, count(*) AS n FROM edges e JOIN nodes f ON f.id = e.from_id WHERE e.type = 'about' AND f.status = 'active' AND f.type != 'entity' GROUP BY e.to_id").map(r => [r.id as string, r.n as number]),
    )
    const entities = this.all("SELECT id, title FROM nodes WHERE type = 'entity' AND status = 'active'")
      .map(r => ({ id: r.id as string, title: r.title as string, count: counts.get(r.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || byTitle(a, b))
      .slice(0, opts.maxTopics)
    const records = this.load(entities.map(e => e.id), true)
    const topics = entities.map(e => ({ node: records.get(e.id)!, count: e.count }))

    return { rules, tasks, topics, notes: this.noteCount(), byType: this.byType() }
  }

  async stats(): Promise<StoreStats> {
    const g = this.graph()

    return { notes: this.noteCount(), byType: this.byType(), edges: g.edgeCount, hubs: g.hubs.size, unresolved: (this.get1('SELECT count(*) AS n FROM unresolved') as Row).n }
  }

  // ---- writing -------------------------------------------------------------------------------------------

  /** Removes a node and everything derived from it (not the edges: `relink` rebuilds those). */
  private removeNode(id: string): void {
    const row = this.get1('SELECT rowid FROM nodes WHERE id = ?', id)
    if (!row) return
    this.run('DELETE FROM nodes_fts WHERE rowid = ?', row.rowid)
    for (const t of ['sources', 'source_keys', 'entity_paths']) this.run(`DELETE FROM ${t} WHERE node_id = ?`, id)
    this.run('DELETE FROM nodes WHERE id = ?', id)
  }

  /** Inserts one node with its sources, lookup keys and search text. Must run inside `tx`. */
  addNode(rec: NodeRecord, extra: Record<string, unknown>): void {
    const r = this.db
      .prepare(
        `INSERT INTO nodes (id, path, type, title, summary, body, body_lines, aliases, tags, headings, status, confidence, origin, valid_from, valid_to, recorded_at, updated_at, version, author, paths, urls, done, due, links, issues, has_front_matter, extra)
         VALUES (${marks(27)})`,
      )
      .run(
        rec.id, rec.path, rec.type, rec.title, rec.summary, rec.body, rec.bodyLines, json(rec.aliases), json(rec.tags), json(rec.headings), rec.status, rec.confidence, rec.origin,
        rec.validFrom, rec.validTo, rec.recordedAt, rec.updatedAt, rec.version, rec.author, json(rec.paths), json(rec.urls), rec.done === null ? null : rec.done ? 1 : 0, rec.due,
        json(rec.links), json(rec.issues), rec.hasFrontMatter ? 1 : 0, json(extra),
      )
    this.run('INSERT INTO nodes_fts (rowid, title, aliases, summary, headings, body) VALUES (?, ?, ?, ?, ?, ?)', r.lastInsertRowid as number, rec.title, rec.aliases.join(' '), rec.summary, rec.headings.join(' '), rec.body)
    rec.sources.forEach((s, i) => this.run('INSERT INTO sources (node_id, ord, kind, ref, hash, at) VALUES (?, ?, ?, ?, ?, ?)', rec.id, i, s.kind, s.ref, s.hash, s.at))
    const keys = new Set<string>()
    for (const s of rec.sources) if (s.kind === 'file') keys.add(normPath(s.ref))
    else if (s.kind === 'url') keys.add(normUrl(s.ref))
    for (const u of rec.urls) keys.add(normUrl(u))
    for (const k of keys) this.run('INSERT INTO source_keys (key, node_id) VALUES (?, ?)', k, rec.id)
    if (rec.type === 'entity') for (const p of rec.paths) this.run('INSERT INTO entity_paths (prefix, node_id) VALUES (?, ?)', normPath(p), rec.id)
  }

  /** Replaces the stored graph. Must run inside `tx`. */
  setGraph(edges: Edge[], unresolved: { from: string; type: string; target: string; reason: string }[]): void {
    this.run('DELETE FROM edges')
    this.run('DELETE FROM unresolved')
    for (const e of edges) this.run('INSERT OR IGNORE INTO edges (type, from_id, to_id) VALUES (?, ?, ?)', e.type, e.from, e.to)
    for (const u of unresolved) this.run('INSERT INTO unresolved (from_id, type, target, reason) VALUES (?, ?, ?, ?)', u.from, u.type, u.target, u.reason)
  }

  /**
   * Re-resolves every stored link, as Files mode does on each change, so a new note can complete an old dangling link.
   * shortcut: O(nodes) per write; resolve only the changed node and the links naming its title once past ~100k nodes.
   */
  private relink(): void {
    const rows = this.all('SELECT id, path, title, aliases, links FROM nodes ORDER BY rowid')
    const { edges, unresolved } = resolveLinks(rows.map(r => ({ id: r.id, path: r.path, title: r.title, aliases: JSON.parse(r.aliases), links: JSON.parse(r.links) })))
    this.setGraph(edges, unresolved)
  }

  private event(op: 'node.put' | 'node.patch', target: string, actor: string, at: string, payload: unknown, id: string): void {
    // The event id doubles as the idempotency key: callers cannot supply one yet.
    this.run('INSERT INTO events (id, at, actor, op, target, payload, idempotency_key, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, at, actor, op, target, json(payload), id, SCHEMA_VERSION)
  }

  /** Same rules as the Files store: human-written notes are never rewritten; a stale `expectedVersion` is a conflict. */
  async put(input: NodeInput, opts: { id?: string; expectedVersion?: number; now: string; newId: (prefix: string) => string }): Promise<NodeRecord> {
    const id = this.tx(() => {
      const old = opts.id ? this.get1('SELECT path, title, confidence, version, recorded_at, extra FROM nodes WHERE id = ?', opts.id) : undefined
      if (opts.id && !old) throw new StoreError('not_found', `no node ${opts.id}`)
      if (old) {
        if (old.confidence !== 'agent') throw new StoreError('invalid', `"${old.title}" was written by ${old.confidence === 'human' ? 'a person' : 'an import'}; propose a new note that supersedes it`)
        if (opts.expectedVersion !== undefined && opts.expectedVersion !== old.version) throw new StoreError('conflict', `"${old.title}" is at version ${old.version}, not ${opts.expectedVersion}`)
      }
      const id = opts.id ?? opts.newId(ID_PREFIX[input.type])
      let path: string = old?.path
      if (!old) {
        const base = `${TYPE_FOLDER[input.type]}/${slug(input.title)}`
        path = `${base}.md`
        for (let n = 2; this.get1('SELECT 1 FROM nodes WHERE path = ?', path); n++) path = `${base}-${n}.md`
      }
      const version = old ? old.version + 1 : 1
      // Round trip through the note format, so a stored note is exactly what the Files store would parse back.
      const note: ParsedNote = parseNote(path, serializeNote(id, input, { now: opts.now, version, recordedAt: old?.recorded_at ?? opts.now }))
      this.removeNode(id)
      this.addNode({ ...note, id }, old ? JSON.parse(old.extra) : {})
      this.relink()
      this.event('node.put', id, input.author, opts.now, { input, version }, opts.newId('evt'))

      return id
    })

    return (await this.get(id))!
  }

  async setStatus(id: string, status: Status, opts: { now: string; validTo?: string }): Promise<NodeRecord> {
    this.tx(() => {
      if (!this.get1('SELECT 1 FROM nodes WHERE id = ?', id)) throw new StoreError('not_found', `no node ${id}`)
      this.run('UPDATE nodes SET status = ?, updated_at = ?, valid_to = coalesce(?, valid_to) WHERE id = ?', status, opts.now, opts.validTo ?? null, id)
      this.event('node.patch', id, 'memory-v2', opts.now, { status, ...(opts.validTo ? { validTo: opts.validTo } : {}) }, `evt_patch_${(this.get1('SELECT coalesce(max(seq), 0) + 1 AS n FROM events') as Row).n}`)
    })

    return (await this.get(id))!
  }

  /** Runs `fn` as one transaction (used by the importer). */
  transaction<T>(fn: () => T): T {
    return this.tx(fn)
  }

  isEmpty(): boolean {
    return this.noteCount() === 0
  }
}
