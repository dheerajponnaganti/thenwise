// HTTP API in front of any Store (spec 07 §5), with an optional MCP endpoint (see mcp.ts).
// JSON in and out, Bearer tokens checked by SHA-256 hash, Idempotency-Key on writes, If-Match on PATCH.
// Fields are the Store's camelCase names (NodeInput in, NodeRecord out), not the snake_case of the Markdown front matter.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { cryptoRandom, newId } from '../core/ids.ts'
import { buildManifest, DEFAULT_MANIFEST } from '../core/manifest.ts'
import { CONFIDENCES, EDGE_TYPES, FRONT_MATTER_EDGES, NODE_TYPES, ORIGINS, SCHEMA_VERSION, SOURCE_KINDS, STATUSES } from '../core/model.ts'
import type { EdgeType, NodeType, Status } from '../core/model.ts'
import { hashToken } from '../host/token.ts'
import { StoreError } from '../core/store.ts'
import type { NodeInput, NodeRecord, Scored, Store } from '../core/store.ts'
import { handleMcp, NODE_BODY_CAP } from './mcp.ts'

export interface Principal {
  id: string
}

/** Maps the SHA-256 hex of a bearer token to who it belongs to, or null (unknown or revoked). */
export type Verifier = (tokenHash: string) => Promise<Principal | null>

/** A fixed token table (tests, single-user local use). Tokens are hashed at once and never kept in clear. */
export function staticVerifier(tokens: Record<string, string>): Verifier {
  const byHash = new Map(Object.entries(tokens).map(([token, id]) => [hashToken(token), { id }]))

  return async h => byHash.get(h) ?? null
}

/** A store may also keep the change log; the server serves /v1/changes only then. */
export interface ChangeFeed {
  changesSince(cursor: string | null, limit: number): Promise<{ events: unknown[]; cursor: string }>
}

export interface ServerOptions {
  /** One store, or one per principal (Postgres with row-level security needs the principal on the connection). */
  store: Store | ((p: Principal) => Store)
  verify: Verifier
  /** Shown in the manifest header and MCP output. */
  label?: string
  host?: string
  port?: number
  /** Per request; a write that times out may still complete, so clients retry with the same Idempotency-Key. */
  timeoutMs?: number
  mcp?: boolean
  /** Origins allowed on /mcp when the header is present (DNS-rebinding guard). Default: loopback only. */
  allowedOrigins?: string[]
  now?: () => string
  newId?: (prefix: string) => string
}

export const BODY_LIMIT = 1_048_576

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
const bad = (message: string) => new HttpError(400, 'bad_request', message)

export interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

const STORE_STATUS: Record<StoreError['code'], number> = { not_found: 404, conflict: 409, invalid: 422, unavailable: 503 }

// ---- validation (the trust boundary) -------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function asObj(v: unknown): Obj {
  if (!isObj(v)) throw bad('the body must be a JSON object')

  return v
}
function str(o: Obj, k: string, max: number, required = false): string | undefined {
  const v = o[k]
  if (v === undefined || v === null) {
    if (required) throw bad(`${k} is required`)

    return undefined
  }
  if (typeof v !== 'string') throw bad(`${k} must be a string`)
  if (v.length > max) throw bad(`${k} is longer than ${max} characters`)
  if (required && v.trim() === '') throw bad(`${k} is required`)

  return v
}
function strList(o: Obj, k: string): string[] | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string') || v.length > 200) throw bad(`${k} must be a list of at most 200 strings`)

  return v as string[]
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(`${k} must be one of ${allowed.join(', ')}`)

  return v as T
}
const known = (o: Obj, fields: string[]) => {
  const extra = Object.keys(o).filter(k => !fields.includes(k))
  if (extra.length > 0) throw bad(`unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`)
}

const NODE_FIELDS = ['type', 'title', 'summary', 'body', 'status', 'confidence', 'origin', 'author', 'aliases', 'tags', 'edges', 'sources', 'paths', 'urls', 'validFrom', 'due', 'done']
const PATCH_FIELDS = ['title', 'summary', 'body', 'aliases', 'tags', 'edges', 'sources', 'paths', 'urls', 'validFrom', 'due', 'done']

/** Fields shared by create and patch. */
function commonFields(o: Obj): Partial<NodeInput> {
  const out: Partial<NodeInput> = {}
  const set = <K extends keyof NodeInput>(k: K, v: NodeInput[K] | undefined) => {
    if (v !== undefined) out[k] = v
  }
  set('title', str(o, 'title', 120))
  set('summary', str(o, 'summary', 200))
  set('body', str(o, 'body', 200_000))
  set('aliases', strList(o, 'aliases'))
  set('tags', strList(o, 'tags'))
  set('paths', strList(o, 'paths'))
  set('urls', strList(o, 'urls'))
  set('validFrom', str(o, 'validFrom', 40))
  set('due', str(o, 'due', 40))
  if (o.done !== undefined && o.done !== null) {
    if (typeof o.done !== 'boolean') throw bad('done must be true or false')
    out.done = o.done
  }
  if (o.edges !== undefined && o.edges !== null) {
    const e = asObj(o.edges)
    const edges: NonNullable<NodeInput['edges']> = {}
    for (const [t, targets] of Object.entries(e)) {
      if (!(FRONT_MATTER_EDGES as readonly string[]).includes(t)) throw bad(`edges.${t} is not an edge type (${FRONT_MATTER_EDGES.join(', ')})`)
      if (!Array.isArray(targets) || targets.some(x => typeof x !== 'string')) throw bad(`edges.${t} must be a list of titles`)
      edges[t as keyof typeof edges] = targets as string[]
    }
    out.edges = edges
  }
  if (o.sources !== undefined && o.sources !== null) {
    if (!Array.isArray(o.sources) || o.sources.length > 100) throw bad('sources must be a list of at most 100')
    out.sources = o.sources.map(s => {
      const x = asObj(s)
      known(x, ['kind', 'ref', 'hash', 'at'])

      return { kind: oneOf(x, 'kind', SOURCE_KINDS) ?? (() => { throw bad('sources[].kind is required') })(), ref: str(x, 'ref', 2000, true)!, hash: str(x, 'hash', 200) ?? null, at: str(x, 'at', 40) ?? null }
    })
  }

  return out
}

function parseNewNode(raw: unknown, author: string): NodeInput {
  const o = asObj(raw)
  known(o, NODE_FIELDS)
  const type = oneOf(o, 'type', NODE_TYPES.filter((t): t is Exclude<NodeType, 'episode'> => t !== 'episode'))
  if (!type) throw bad('type is required (episodes are written by the system, not through this API)')
  const c = commonFields(o)
  if (!c.title) throw bad('title is required')
  const input: NodeInput = {
    type,
    title: c.title,
    summary: c.summary ?? '',
    body: c.body ?? '',
    status: oneOf(o, 'status', STATUSES) ?? 'inbox',
    confidence: oneOf(o, 'confidence', CONFIDENCES) ?? 'agent',
    origin: oneOf(o, 'origin', ORIGINS) ?? 'local',
    author: str(o, 'author', 200) ?? author,
    ...c,
  }
  // Spec 08 §2: web text never becomes a rule, and nothing creates an active rule without a person accepting it.
  if (input.type === 'rule' && input.origin === 'web') throw new HttpError(422, 'invalid', 'a rule cannot come from the web')
  if (input.type === 'rule' && input.status !== 'inbox') throw new HttpError(422, 'invalid', 'a new rule starts in the inbox; accept it to make it active')
  if (input.type === 'finding' && !input.sources?.length) throw new HttpError(422, 'invalid', 'a finding needs at least one source')

  return input
}

/** The write form of a stored node: PATCH changes some fields and keeps the rest. */
function toInput(n: NodeRecord): NodeInput {
  const edges: NonNullable<NodeInput['edges']> = {}
  for (const l of n.links) if (l.type !== 'mentions') (edges[l.type] ??= []).push(l.target)

  return {
    type: n.type as NodeInput['type'],
    title: n.title,
    summary: n.summary,
    body: n.body,
    status: n.status,
    confidence: n.confidence,
    origin: n.origin,
    author: n.author,
    aliases: n.aliases,
    tags: n.tags,
    edges,
    sources: n.sources,
    paths: n.paths,
    urls: n.urls,
    ...(n.validFrom ? { validFrom: n.validFrom } : {}),
    ...(n.due ? { due: n.due } : {}),
    ...(n.done !== null ? { done: n.done } : {}),
  }
}

export function publicNode(n: NodeRecord, cap = NODE_BODY_CAP): Obj {
  const { links: _links, issues: _issues, hasFrontMatter: _fm, bodyLines: _bl, path: _path, ...rest } = n

  return { ...rest, ...(n.body.length > cap ? { body: n.body.slice(0, cap), bodyTruncated: true } : {}) }
}

const pointer = (n: NodeRecord) => ({ id: n.id, type: n.type, title: n.title, summary: n.summary, status: n.status, origin: n.origin })

// ---- the app -------------------------------------------------------------------------------

export interface App {
  server: Server
  /** Starts listening; resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }>
  close(): Promise<void>
}

export function createApp(opts: ServerOptions): App {
  const label = opts.label ?? 'memory'
  const now = opts.now ?? (() => new Date().toISOString())
  const mint = opts.newId ?? ((prefix: string) => newId(prefix, Date.now(), cryptoRandom))
  const timeoutMs = opts.timeoutMs ?? 10_000
  const storeFor = (p: Principal) => (typeof opts.store === 'function' ? opts.store(p) : opts.store)
  // In-process replay cache for stores that keep no idempotency keys of their own (Files). Postgres also keeps them durably.
  const replays = new Map<string, Reply>()
  const REPLAY_MAX = 1000

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > BODY_LIMIT) throw new HttpError(413, 'payload_too_large', `the body is larger than ${BODY_LIMIT} bytes`)
      chunks.push(chunk as Buffer)
    }
    if (size === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw bad('the body is not valid JSON')
    }
  }

  const handle = async (req: IncomingMessage): Promise<Reply> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (method === 'GET' && path === '/v1/health') return { status: 200, body: { ok: true, schema_version: SCHEMA_VERSION } }

    const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    const principal = m ? await opts.verify(hashToken(m[1]!)) : null
    if (!principal) return { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: { code: 'unauthorized', message: 'a valid bearer token is required' } } }

    if (path === '/mcp') {
      if (!opts.mcp) throw new HttpError(404, 'not_found', 'the MCP endpoint is off')
      const origin = req.headers.origin
      const allowed = opts.allowedOrigins ?? []
      if (origin && !allowed.includes(origin) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) throw new HttpError(403, 'forbidden', 'origin not allowed')
      if (method !== 'POST') return { status: 405, headers: { allow: 'POST' }, body: { error: { code: 'method_not_allowed', message: 'POST JSON-RPC messages to this endpoint' } } }

      return handleMcp(storeFor(principal), await readBody(req), { label })
    }

    const store = storeFor(principal)
    const idemKey = req.headers['idempotency-key']
    const writes = method === 'POST' || method === 'PATCH' || method === 'DELETE'
    if (typeof idemKey === 'string' && (idemKey === '' || idemKey.length > 200)) throw bad('Idempotency-Key must be 1 to 200 characters')
    // The key names one operation: scoping it by principal, method and path stops one client's key from replaying another's call.
    const storeKey = typeof idemKey === 'string' && writes ? `${principal.id}|${method} ${path}|${idemKey}` : undefined
    const replay = storeKey ? replays.get(storeKey) : undefined
    if (replay) return { ...replay, headers: { ...replay.headers, 'idempotent-replayed': 'true' } }

    const reply = await route(store, principal, method, path, url, req, storeKey)
    if (storeKey && reply.status < 300) {
      if (replays.size >= REPLAY_MAX) replays.delete(replays.keys().next().value!)
      replays.set(storeKey, reply)
    }

    return reply
  }

  const route = async (store: Store, principal: Principal, method: string, path: string, url: URL, req: IncomingMessage, key: string | undefined): Promise<Reply> => {
    const ok = (body: unknown, status = 200): Reply => ({ status, body })
    const writeOpts = (extra: { id?: string; expectedVersion?: number } = {}) => ({ now: now(), newId: mint, ...(key ? { idempotencyKey: key } : {}), actor: principal.id, ...extra })

    if (method === 'GET' && path === '/v1/manifest') {
      const data = await store.manifestData({ maxTopics: DEFAULT_MANIFEST.maxTopics })
      const manifest = buildManifest(data, { ...DEFAULT_MANIFEST, vaultPath: label, backend: store.kind })

      return ok({ ...manifest, data: { rules: data.rules.map(pointer), tasks: data.tasks.map(pointer), topics: data.topics.map(t => ({ ...pointer(t.node), count: t.count })), notes: data.notes, byType: data.byType } })
    }

    if (method === 'POST' && path === '/v1/search') {
      const o = asObj(await readBody(req))
      known(o, ['text', 'limit', 'types', 'includeInbox'])
      const text = str(o, 'text', 2000, true)!
      const types = strList(o, 'types')
      if (types?.some(t => !(NODE_TYPES as readonly string[]).includes(t))) throw bad(`types must be among ${NODE_TYPES.join(', ')}`)
      const hits = await store.search({ text, limit: clampInt(o.limit, 1, 50, 10), includeInbox: o.includeInbox === true, ...(types ? { types: types as NodeType[] } : {}) })

      return ok({ results: await withPointers(store, hits) })
    }

    if (method === 'POST' && path === '/v1/match') {
      const o = asObj(await readBody(req))
      known(o, ['path', 'url', 'command', 'scopes'])
      if (o.command !== undefined) throw new HttpError(501, 'not_implemented', 'matching by command is not supported yet')
      const k = { ...(str(o, 'path', 2000) ? { path: str(o, 'path', 2000)! } : {}), ...(str(o, 'url', 2000) ? { url: str(o, 'url', 2000)! } : {}) }
      if (!k.path && !k.url) throw bad('path or url is required')
      const r = await store.matchExact(k)
      const recs = await store.getMany([...r.bySource, ...r.byEntity])

      return ok({ bySource: r.bySource.flatMap(id => (recs.has(id) ? [pointer(recs.get(id)!)] : [])), byEntity: r.byEntity.flatMap(id => (recs.has(id) ? [pointer(recs.get(id)!)] : [])) })
    }

    if (method === 'POST' && path === '/v1/links') {
      const o = asObj(await readBody(req))
      known(o, ['ids', 'depth', 'types', 'limit', 'direction', 'skipHubs', 'scopes'])
      const ids = strList(o, 'ids')
      if (!ids?.length) throw bad('ids is required')
      const types = strList(o, 'types')
      if (types?.some(t => !(EDGE_TYPES as readonly string[]).includes(t))) throw bad(`types must be among ${EDGE_TYPES.join(', ')}`)
      if (o.depth !== undefined && o.depth !== 1 && o.depth !== 2) throw bad('depth must be 1 or 2')
      const found = await store.links({ ids, depth: o.depth === 2 ? 2 : 1, limit: clampInt(o.limit, 1, 200, 20), ...(types ? { types: types as EdgeType[] } : {}) })
      const recs = await store.getMany(found.map(f => f.id))

      return ok({ neighbours: found.flatMap(f => (recs.has(f.id) ? [{ ...pointer(recs.get(f.id)!), hop: f.hop, via: f.via, from: f.from }] : [])) })
    }

    if (method === 'GET' && path === '/v1/changes') {
      const feed = store as Partial<ChangeFeed>
      if (!feed.changesSince) throw new HttpError(501, 'not_implemented', `the ${store.kind} store keeps no change log`)
      const since = url.searchParams.get('since')
      if (since !== null && !/^\d{1,18}$/.test(since)) throw bad('since must be a cursor from an earlier call')

      return ok(await feed.changesSince(since, clampInt(url.searchParams.get('limit'), 1, 500, 100)))
    }

    if (method === 'POST' && path === '/v1/nodes') {
      const node = await store.put(parseNewNode(await readBody(req), principal.id), writeOpts())

      return { status: 201, headers: { etag: `"${node.version}"`, location: `/v1/nodes/${node.id}` }, body: publicNode(node) }
    }

    const id = /^\/v1\/nodes\/([^/]+)(?:\/(accept|reject|retire))?$/.exec(path)
    if (id) {
      const nodeId = decodeURIComponent(id[1]!)
      const action = id[2]
      if (method === 'GET' && !action) {
        const node = await store.get(nodeId)
        if (!node) throw new HttpError(404, 'not_found', `no node ${nodeId}`)

        return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) }
      }
      if (method === 'PATCH' && !action) {
        const header = req.headers['if-match']
        if (typeof header !== 'string') throw new HttpError(428, 'precondition_required', 'send If-Match: <version> with every update')
        const expected = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim())
        if (!expected) throw bad('If-Match must be a node version, for example "3"')
        const o = asObj(await readBody(req))
        known(o, PATCH_FIELDS)
        const current = await store.get(nodeId)
        if (!current) throw new HttpError(404, 'not_found', `no node ${nodeId}`)
        // The version check is repeated by the store inside its transaction; this one only gives a clear early answer.
        const input = { ...toInput(current), ...commonFields(o) }
        if (input.type === 'finding' && !input.sources?.length) throw new HttpError(422, 'invalid', 'a finding needs at least one source')
        const node = await store.put(input, writeOpts({ id: nodeId, expectedVersion: Number(expected[1]) }))

        return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) }
      }
      if (method === 'POST' && action) {
        const o = asObj(await readBody(req))
        known(o, ['reason', 'validTo'])
        const status: Status = action === 'accept' ? 'active' : action === 'reject' ? 'rejected' : 'archived'
        const validTo = action === 'retire' ? (str(o, 'validTo', 40) ?? now().slice(0, 10)) : undefined
        const node = await store.setStatus(nodeId, status, { now: now(), ...(validTo ? { validTo } : {}), ...(key ? { idempotencyKey: key } : {}), actor: principal.id } as Parameters<Store['setStatus']>[2])

        return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) }
      }
      if (method === 'DELETE' && !action) throw new HttpError(501, 'not_implemented', 'deleting nodes is not supported yet; retire the node instead')
    }

    if (/^\/v1\/(edges|episodes|asof|doctor)(\/|$)/.test(path)) throw new HttpError(501, 'not_implemented', `${path} is not supported yet`)

    throw new HttpError(404, 'not_found', `no route for ${method} ${path}`)
  }

  const server = createServer((req, res) => {
    void respond(req, res)
  })
  // Slow clients are cut off by Node itself; the per-request timer below covers slow stores.
  server.requestTimeout = timeoutMs
  server.headersTimeout = Math.min(timeoutMs, 60_000)

  const respond = async (req: IncomingMessage, res: ServerResponse) => {
    let timer: NodeJS.Timeout | undefined
    let reply: Reply
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new HttpError(503, 'timeout', `no answer within ${timeoutMs} ms`)), timeoutMs)
      })
      reply = await Promise.race([handle(req), timeout])
    } catch (e) {
      reply = failure(e)
    } finally {
      clearTimeout(timer)
    }
    if (res.writableEnded || res.destroyed) return
    const payload = reply.body === undefined ? '' : JSON.stringify(reply.body)
    res.writeHead(reply.status, { ...(payload ? { 'content-type': 'application/json; charset=utf-8' } : {}), 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', ...reply.headers })
    res.end(payload)
  }

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        // 127.0.0.1 unless the owner chooses otherwise: the API has no TLS of its own.
        server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
          const a = server.address() as AddressInfo
          resolve({ host: a.address, port: a.port })
        })
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close(e => (e ? reject(e) : resolve()))
        server.closeAllConnections()
      }),
  }
}

function failure(e: unknown): Reply {
  if (e instanceof HttpError) return { status: e.status, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof StoreError) return { status: STORE_STATUS[e.code], body: { error: { code: e.code, message: e.message } } }
  // Anything else is a bug or an outage; the details stay in the server log, not in the response.
  console.error('memory server error:', e)

  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`must be a whole number from ${min} to ${max}`)

  return n
}

/** Search hits as pointers: what a caller needs to decide whether to open a node. */
export async function withPointers(store: Store, hits: Scored[]) {
  const recs = await store.getMany(hits.map(h => h.id))

  return hits.flatMap(h => (recs.has(h.id) ? [{ ...pointer(recs.get(h.id)!), score: h.score, why: h.why, ...(h.replaces ? { replaces: h.replaces } : {}) }] : []))
}
