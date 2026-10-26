// Teams server: one team, one token per person, shared notes only. The tables hold nothing but notes their owners
// chose to share, and every statement binds its values, so a read cannot reach a private note.
// Routes live under /v1 with `{ error: { code, message } }`; the unprefixed 0.1.5 routes answer for one more release.
// Revisions come from one server-wide counter: each note's revision only grows (If-Match), and feeds read in that order.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

import { clampInt, HttpError, ifMatch, readBody, seqOf, str } from './http.ts'
import { openTeamDb, SCHEMA_VERSION } from './schema.ts'

export { openTeamDb }
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,119}$/
const MAX_BODY = 256 * 1024
const MAX_TEXT = 100 * 1024
// Per token and minute. A burst above this is a script gone wrong, not a person.
export const LIMITS = { reads: 600, writes: 60 }
const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const newToken = () => `tw_${randomBytes(32).toString('hex')}`

/** Shown once: only its hash is stored. `expiresAt` is in ms; the default is one year. A name a live member holds is
 * refused; a disabled member (removed with notes kept) comes back with the same id only with `again`. */
export function invite(db: DatabaseSync, name: string, expiresAt: number = Date.now() + 365 * 864e5, opts: { again?: boolean } = {}): string {
  if (!NAME_RE.test(name)) throw new Error('a name is lower-case letters, digits, - and _, up to 32 characters')
  const m = db.prepare('SELECT id, disabled FROM members WHERE name = ?').get(name) as { id: string; disabled: number } | undefined
  if (m && !m.disabled) throw new Error(`${name} is already a member; \`team rotate ${name}\` gives them a new token`)
  if (m && !opts.again) throw new Error(`${name} was removed and their notes kept. If this is the same person, run \`team invite --again ${name}\`; if not, use another name.`)
  const token = newToken()
  if (m) db.prepare('UPDATE members SET token_hash = ?, expires_at = ?, disabled = 0 WHERE id = ?').run(hash(token), expiresAt, m.id)
  else db.prepare('INSERT INTO members (id, name, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(randomBytes(16).toString('hex'), name, hash(token), expiresAt, Date.now())

  return token
}

/** A new token for a live member; the old one stops working at once. */
export function rotate(db: DatabaseSync, name: string): string {
  const token = newToken()
  if (Number(db.prepare('UPDATE members SET token_hash = ? WHERE name = ? AND disabled = 0').run(hash(token), name).changes) === 0) throw new Error(`${name} is not a member`)

  return token
}

/** The token stops working at once. Kept notes stay under a disabled member (so the name is not reused by someone
 * else); otherwise the member and their notes go. */
export function removeMember(db: DatabaseSync, name: string, keepNotes = false): { removed: boolean; notes: number } {
  const m = db.prepare('SELECT id FROM members WHERE name = ? AND disabled = 0').get(name) as { id: string } | undefined
  if (!m) return { removed: false, notes: 0 }
  const notes = Number((db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(m.id) as { n: number }).n)
  if (keepNotes) db.prepare('UPDATE members SET disabled = 1, token_hash = NULL WHERE id = ?').run(m.id)
  else {
    for (const t of ['notes', 'tombs']) db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(m.id)
    db.prepare('DELETE FROM members WHERE id = ?').run(m.id)
  }

  return { removed: true, notes }
}

export interface MemberRow {
  name: string
  role: string
  expires_at: number | null
  disabled: number
  last_seen: number | null
}
export const listMembers = (db: DatabaseSync) => db.prepare('SELECT name, role, expires_at, disabled, last_seen FROM members ORDER BY name').all() as unknown as MemberRow[]

export interface TeamApp {
  listen(): Promise<{ host: string; port: number }>
  close(): Promise<void>
}

interface Me {
  id: string
  name: string
  role: string
  last_seen: number | null
}

export function createTeamServer(opts: { dir: string; host?: string; port?: number; version?: string }): TeamApp {
  const db = openTeamDb(opts.dir)
  const who = (auth: string | undefined): Me | null => {
    const m = /^Bearer (\S+)$/.exec(auth ?? '')
    const r = m ? (db.prepare('SELECT id, name, role, expires_at, last_seen FROM members WHERE token_hash = ? AND disabled = 0').get(hash(m[1]!)) as (Me & { expires_at: number | null }) | undefined) : undefined

    return r && (r.expires_at === null || r.expires_at > Date.now()) ? r : null
  }
  const nextRev = () => 1 + Number((db.prepare('SELECT max(r) AS r FROM (SELECT max(rev) AS r FROM notes UNION ALL SELECT max(rev) FROM tombs)').get() as { r: number | null }).r ?? 0)
  const owned = (me: Me, id: string) => db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?').get(me.id, id) as Record<string, any> | undefined
  const out = (r: Record<string, any>, full: boolean, snippet?: string) => ({ owner: r.owner, id: r.id, rev: r.rev, title: r.title, project: r.project, updated_at: r.updated_at, ...(full ? { text: r.text } : { snippet: snippet ?? String(r.text).slice(0, 200) }) })

  // Rate limits, per member and minute.
  const used = new Map<string, { minute: number; reads: number; writes: number }>()
  const spend = (me: Me, write: boolean) => {
    const minute = Math.floor(Date.now() / 60000)
    const u = used.get(me.id)?.minute === minute ? used.get(me.id)! : { minute, reads: 0, writes: 0 }
    used.set(me.id, u)
    if (write ? ++u.writes > LIMITS.writes : ++u.reads > LIMITS.reads) throw Object.assign(new HttpError(429, 'too_many', `more than ${write ? LIMITS.writes : LIMITS.reads} ${write ? 'writes' : 'reads'} a minute`), { retryAfter: 60 - Math.floor((Date.now() / 1000) % 60) })
  }

  /** A share. `match` is the revision the client last saw, or `*` for a note new to the team. `seq` is the client's own
   * order of its changes: a share made before an unshare of the same note that already arrived loses to it. */
  function put(me: Me, id: string, note: { title: string; text: string; project: string }, match: number | '*', seq = 0): [number, unknown] {
    const t = db.prepare('SELECT seq FROM tombs WHERE owner_id = ? AND id = ?').get(me.id, id) as { seq: number } | undefined
    if (seq && t && t.seq >= seq) return [409, { error: { code: 'unshared', message: `${id} was unshared after this change was made` } }]
    const cur = owned(me, id)
    if (match === '*' ? cur : !cur || cur.rev !== match) return [409, { error: { code: 'stale', message: cur ? `the team has revision ${cur.rev} of ${id}` : `${id} is not shared` }, rev: cur?.rev ?? null, updated_at: cur?.updated_at ?? null }]
    const rev = nextRev()
    db.prepare('INSERT INTO notes (owner_id, owner, id, rev, seq, title, text, project, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET owner = excluded.owner, rev = excluded.rev, seq = excluded.seq, title = excluded.title, text = excluded.text, project = excluded.project, updated_at = excluded.updated_at').run(me.id, me.name, id, rev, seq, note.title, note.text, note.project, Date.now())

    return [200, { rev }]
  }
  /** An unshare: the note goes and a tomb records it, so feeds tell other machines. */
  function del(me: Me, id: string, match: number | '*', seq = 0): [number, unknown] {
    const cur = owned(me, id)
    if (cur && match !== '*' && cur.rev !== match) return [409, { error: { code: 'stale', message: `the team has revision ${cur.rev} of ${id}` }, rev: cur.rev, updated_at: cur.updated_at }]
    const rev = nextRev()
    db.prepare('DELETE FROM notes WHERE owner_id = ? AND id = ?').run(me.id, id)
    db.prepare('INSERT INTO tombs (owner_id, owner, id, rev, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET rev = excluded.rev, seq = max(seq, excluded.seq)').run(me.id, me.name, id, rev, seq)

    return [200, { rev }]
  }
  const noteBody = (n: Record<string, unknown>) => ({ title: str(n, 'title', 500), text: str(n, 'text', MAX_TEXT), project: str(n, 'project', 200) })
  const search = (u: URL, limit: number, offset: number) => {
    const words = (u.searchParams.get('q') ?? '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? []
    if (!words.length) return []

    return (db.prepare(`SELECT n.*, snippet(notes_fts, 1, '**', '**', '…', 24) AS snip FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts), n.owner, n.id LIMIT ? OFFSET ?`).all(words.map((w) => `"${w}"`).join(' '), limit, offset) as Record<string, any>[]).map((r) => out(r, false, r.snip))
  }

  async function v1(req: IncomingMessage, u: URL, parts: string[]): Promise<[number, unknown, Record<string, string>?]> {
    const [a, b, c, extra] = parts
    if (req.method === 'GET' && a === 'health' && !b) return [200, { ok: true, schema: SCHEMA_VERSION, version: opts.version ?? '' }]
    const me = who(req.headers.authorization)
    if (!me) throw new HttpError(401, 'unauthorized', 'a valid token is needed')
    const write = req.method === 'PUT' || req.method === 'DELETE'
    spend(me, write)
    if (!me.last_seen || Date.now() - me.last_seen > 60000) db.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(Date.now(), me.id)
    const limit = () => clampInt(u.searchParams.get('limit'), 20, 1, 200, 'limit')
    const offset = () => clampInt(u.searchParams.get('offset'), 0, 0, 1e9, 'offset')
    if (req.method === 'GET' && a === 'me' && !b) return [200, { id: me.id, name: me.name, role: me.role }]
    if (req.method === 'GET' && a === 'search' && !b) return [200, { notes: search(u, limit(), offset()) }]
    if (req.method === 'GET' && a === 'tombs' && !b) {
      const since = clampInt(u.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'since')

      return [200, { tombs: db.prepare('SELECT owner, id, rev FROM tombs WHERE rev > ? ORDER BY rev LIMIT ?').all(since, limit()) }]
    }
    if (a !== 'notes') throw new HttpError(404, 'not_found', 'no such route')
    if (req.method === 'GET' && !b) {
      const mine = u.searchParams.get('owner') === 'me'
      const since = u.searchParams.get('since')
      const where = mine ? 'WHERE owner_id = ?' : ''
      const args: (string | number)[] = mine ? [me.id] : []
      // A feed (since) reads forward in revision order; a listing reads the newest first.
      const rows = since !== null ? db.prepare(`SELECT * FROM notes ${where ? `${where} AND` : 'WHERE'} rev > ? ORDER BY rev LIMIT ?`).all(...args, clampInt(since, 0, 0, Number.MAX_SAFE_INTEGER, 'since'), limit()) : db.prepare(`SELECT * FROM notes ${where} ORDER BY rev DESC, owner, id LIMIT ? OFFSET ?`).all(...args, limit(), offset())

      return [200, { notes: (rows as Record<string, any>[]).map((r) => out(r, false)) }]
    }
    if (req.method === 'GET' && b && c && !extra) {
      const r = db.prepare('SELECT * FROM notes WHERE owner = ? AND id = ?').get(b, c) as Record<string, any> | undefined
      if (!r) throw new HttpError(404, 'not_found', 'no such note')

      return [200, out(r, true), { etag: `"${r.rev}"` }]
    }
    if (!b || c || req.method === 'GET') throw new HttpError(404, 'not_found', 'no such route')
    if (!ID_RE.test(b)) throw new HttpError(400, 'bad_request', 'bad note id')
    if (req.method === 'PUT') {
      const n = await readBody(req, MAX_BODY)
      const [code, json] = put(me, b, noteBody(n), ifMatch(req.headers['if-match']), seqOf(n.seq))

      return [code, json, code === 200 ? { etag: `"${(json as { rev: number }).rev}"` } : {}]
    }
    if (req.method === 'DELETE') return del(me, b, ifMatch(req.headers['if-match']), seqOf(u.searchParams.get('seq')))
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  // The 0.1.5 routes, kept for one release so an older client still shares: revisions are the server's here too.
  async function legacy(req: IncomingMessage, u: URL, parts: string[]): Promise<[number, unknown]> {
    const me = who(req.headers.authorization)
    if (!me) return [401, { error: 'unauthorized' }]
    spend(me, req.method === 'PUT' || req.method === 'DELETE')
    const [a, b, c] = parts
    const page = () => ({ limit: Math.min(Math.max(Number(u.searchParams.get('limit') ?? 20) | 0, 1), 50), offset: Math.max(Number(u.searchParams.get('offset') ?? 0) | 0, 0) })
    if (req.method === 'GET' && a === 'me' && !b) return [200, { name: me.name }]
    if (req.method === 'GET' && a === 'search' && !b) return [200, { notes: search(u, page().limit, page().offset) }]
    if (a !== 'notes') return [404, { error: 'not found' }]
    if (req.method === 'GET' && !b) return [200, { notes: (db.prepare('SELECT * FROM notes ORDER BY rev DESC, owner, id LIMIT ? OFFSET ?').all(page().limit, page().offset) as Record<string, any>[]).map((r) => out(r, false)) }]
    if (req.method === 'GET' && b && c && !parts[3]) {
      const r = db.prepare('SELECT * FROM notes WHERE owner = ? AND id = ?').get(b, c) as Record<string, any> | undefined

      return r ? [200, out(r, true)] : [404, { error: 'not found' }]
    }
    if (!b || c || req.method === 'GET') return [404, { error: 'not found' }]
    if (!ID_RE.test(b)) return [400, { error: 'bad id' }]
    if (req.method === 'PUT') {
      let n: Record<string, unknown>
      let note
      try {
        n = await readBody(req, MAX_BODY)
        note = noteBody(n)
      } catch {
        return [400, { error: 'bad note' }]
      }
      if (!Number.isSafeInteger(n.rev)) return [400, { error: 'bad note' }]
      const cur = owned(me, b)

      return put(me, b, note, cur ? cur.rev : '*', n.rev as number)[0] === 200 ? [200, { ok: true }] : [409, { error: 'unshared' }]
    }
    if (req.method === 'DELETE') {
      const rev = Number(u.searchParams.get('rev'))
      if (!Number.isSafeInteger(rev)) return [400, { error: 'bad rev' }]
      del(me, b, '*', rev)

      return [200, { ok: true }]
    }

    return [405, { error: 'method not allowed' }]
  }

  const send = (res: ServerResponse, code: number, json: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers })
    res.end(JSON.stringify(json))
  }
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    let parts: string[]
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return send(res, 400, { error: { code: 'bad_request', message: 'bad path' } })
    }
    const isV1 = parts[0] === 'v1'
    const run = isV1 ? v1(req, u, parts.slice(1)) : legacy(req, u, parts)
    run
      .then(([code, json, headers]: [number, unknown, Record<string, string>?]) => send(res, code, json, headers))
      .catch((e) => {
        const h = e instanceof HttpError ? e : new HttpError(500, 'server_error', 'server error')
        const retry = (e as { retryAfter?: number }).retryAfter
        send(res, h.status, isV1 ? { error: { code: h.code, message: h.message } } : { error: h.message }, retry ? { 'retry-after': String(retry) } : {})
      })
  })
  server.requestTimeout = 30_000

  return {
    // 127.0.0.1 unless the owner chooses otherwise: there is no TLS here, so put a TLS proxy in front for other hosts.
    listen: () => new Promise((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => ok({ host: opts.host ?? '127.0.0.1', port: (server.address() as { port: number }).port }))),
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => (db.close(), ok())))),
  }
}
