// Teams server: a team of people, one token each (or a browser session), shared notes only. The tables hold nothing
// but notes their owners chose to share, and every statement binds its values, so a read cannot reach a private note.
// Routes live under /v1 with `{ error: { code, message } }`. Revisions come from one server-wide counter: each note's
// revision only grows (If-Match), and feeds read in that order. Roles decide who may write; refusals are audited.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { quote } from '../core/frontmatter.ts'
import { VAULT_FORMAT } from '../vault/vault.ts'
import { CSP, serveConsole } from './console.ts'
import { clampInt, HttpError, ifMatch, intField, oneOf, readBody, seqOf, str, tagList } from './http.ts'
import { openTeamDb, SCHEMA_VERSION } from './schema.ts'
import { zip } from './zip.ts'

export { openTeamDb }
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,119}$/
const MAX_BODY = 256 * 1024
const MAX_TEXT = 100 * 1024
// Per token and minute. A burst above this is a script gone wrong, not a person.
export const LIMITS = { reads: 600, writes: 60 }
const DAY = 864e5
const SESSION_MS = 14 * DAY
const KEEP_READS_DAYS = 90
export const ROLES = ['viewer', 'member', 'editor', 'admin', 'owner'] as const
const KINDS = ['decision', 'dead_end', 'rule', 'finding', 'note'] as const
const STATUSES = ['active', 'retired', 'superseded', 'pending'] as const
// The lowest role that may do each thing.
const NEED = { read: 'viewer', share: 'member', curate: 'editor', admin: 'admin', owner: 'owner' } as const
type Action = keyof typeof NEED
export const can = (m: { role: string }, action: Action) => ROLES.indexOf(m.role as (typeof ROLES)[number]) >= ROLES.indexOf(NEED[action])
const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const newToken = () => `tw_${randomBytes(32).toString('hex')}`
// The CSRF value of a session: the cookie must carry it and every write must send it back in a header.
const csrfOf = (sid: string) => hash(`csrf:${sid}`).slice(0, 32)
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const teamOf = (db: DatabaseSync) => (db.prepare('SELECT id FROM teams ORDER BY created_at LIMIT 1').get() as { id: string }).id

/** Shown once: only its hash is stored. `expiresAt` is in ms; the default is one year. A name a live member holds is
 * refused; a disabled member (removed with notes kept) comes back with the same id only with `again`. The first member
 * of a team is its owner. */
export function invite(db: DatabaseSync, name: string, expiresAt: number = Date.now() + 365 * DAY, opts: { again?: boolean; role?: string } = {}): string {
  if (!NAME_RE.test(name)) throw new Error('a name is lower-case letters, digits, - and _, up to 32 characters')
  const m = db.prepare('SELECT id, role, disabled FROM members WHERE name = ?').get(name) as { id: string; role: string; disabled: number } | undefined
  if (m && !m.disabled) throw new Error(`${name} is already a member; \`team rotate ${name}\` gives them a new token`)
  if (m && !opts.again) throw new Error(`${name} was removed and their notes kept. If this is the same person, run \`team invite --again ${name}\`; if not, use another name.`)
  const token = newToken()
  const id = m?.id ?? randomBytes(16).toString('hex')
  const team = teamOf(db)
  const role = m?.role ?? opts.role ?? (db.prepare("SELECT 1 FROM members WHERE role = 'owner'").get() ? 'member' : 'owner')
  if (m) db.prepare('UPDATE members SET token_hash = ?, expires_at = ?, disabled = 0 WHERE id = ?').run(hash(token), expiresAt, id)
  else db.prepare('INSERT INTO members (id, team_id, name, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, team, name, hash(token), role, expiresAt, Date.now())
  // The command line is an invite too: a row used on the spot, so the audit trail and the Hub see who came in how.
  db.prepare('INSERT INTO invites (code_hash, team_id, role, expires_at, used_by, used_at) VALUES (?, ?, ?, ?, ?, ?)').run(hash(token), team, role, expiresAt, id, Date.now())

  return token
}

/** A new token for a live member; the old one and any browser session stop working at once. */
export function rotate(db: DatabaseSync, name: string): string {
  const token = newToken()
  const m = db.prepare('SELECT id FROM members WHERE name = ? AND disabled = 0').get(name) as { id: string } | undefined
  if (!m) throw new Error(`${name} is not a member`)
  db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').run(hash(token), m.id)
  db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id)

  return token
}

/** The token stops working at once. Kept notes stay under a disabled member (so the name is not reused by someone
 * else); otherwise the member and their notes go. The owner is handed over first, never removed. */
export function removeMember(db: DatabaseSync, name: string, keepNotes = false): { removed: boolean; notes: number } {
  const m = db.prepare('SELECT id, role FROM members WHERE name = ? AND disabled = 0').get(name) as { id: string; role: string } | undefined
  if (!m) return { removed: false, notes: 0 }
  if (m.role === 'owner') throw new Error(`${name} is the owner and cannot be removed; hand the team over first`)
  const notes = Number((db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(m.id) as { n: number }).n)
  db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id)
  if (keepNotes) db.prepare('UPDATE members SET disabled = 1, token_hash = NULL WHERE id = ?').run(m.id)
  else {
    for (const t of ['notes', 'tombs', 'note_revisions', 'note_reads']) db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(m.id)
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
  team_id: string
  via: 'token' | 'session'
  sid?: string
}
type Row = Record<string, any>
type Reply = [number, unknown, Record<string, string | string[]>?]
interface Meta {
  kind?: string
  source?: string
  tags?: string[]
}

export interface ServerOptions {
  dir: string
  host?: string
  port?: number
  version?: string
  /** The clock, in ms. Tests move it. */
  now?: () => number
  /** A built Hub folder to serve at `/`. */
  console?: string
  /** Origins of a Hub on another host that may call the API with its cookies. */
  allowOrigins?: string[]
  /** Cookies get `Secure`: a TLS proxy sits in front. */
  tlsBehindProxy?: boolean
  allowPlainHttp?: boolean
}

export function createTeamServer(opts: ServerOptions): TeamApp {
  const host = opts.host ?? '127.0.0.1'
  // Cookies and tokens over plain http on a network can be read on the way.
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && !opts.tlsBehindProxy && !opts.allowPlainHttp) throw new Error(`refused: ${host} is not this machine. Put a TLS proxy in front and add --tls-behind-proxy, or add --allow-plain-http if the network is trusted.`)
  if (opts.console && !existsSync(join(opts.console, 'index.html'))) throw new Error(`${opts.console} has no index.html`)
  const db = openTeamDb(opts.dir)
  const now = opts.now ?? Date.now
  const teamId = teamOf(db)
  const settings = () => db.prepare('SELECT name, review_queue FROM teams WHERE id = ?').get(teamId) as { name: string; review_queue: number }

  const ME = 'SELECT m.id, m.name, m.role, m.last_seen, m.team_id, m.expires_at FROM members m'
  const live = (r: Row | undefined): Row | null =>(r && (r.expires_at === null || r.expires_at > now()) ? r : null)
  const cookie = (req: IncomingMessage, name: string) =>
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1)
  const who = (req: IncomingMessage): Me | null => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    if (m) {
      const r = live(db.prepare(`${ME} WHERE m.token_hash = ? AND m.disabled = 0`).get(hash(m[1]!)) as Row | undefined)

      return r ? ({ ...r, via: 'token' } as Me) : null
    }
    const sid = cookie(req, 'tw_session')
    const r = sid ? live(db.prepare(`${ME} JOIN sessions s ON s.member_id = m.id WHERE s.id_hash = ? AND s.expires_at > ? AND m.disabled = 0`).get(hash(sid), now()) as Row | undefined) : null

    return r ? ({ ...r, via: 'session', sid } as Me) : null
  }
  const cookieFlags = `Path=/; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${opts.tlsBehindProxy ? '; Secure' : ''}`
  const startSession = (m: { id: string; team_id: string }): string[] => {
    const sid = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO sessions (id_hash, team_id, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(sid), m.team_id, m.id, now(), now() + SESSION_MS)

    return [`tw_session=${sid}; HttpOnly; ${cookieFlags}`, `tw_csrf=${csrfOf(sid)}; ${cookieFlags}`]
  }
  const noCookies = ['tw_session', 'tw_csrf'].map((n) => `${n}=; Path=/; SameSite=Strict; Max-Age=0`)

  const nextRev = () => 1 + Number((db.prepare('SELECT max(r) AS r FROM (SELECT max(rev) AS r FROM notes UNION ALL SELECT max(rev) FROM tombs)').get() as { r: number | null }).r ?? 0)
  const owned = (me: Me, id: string) => db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?').get(me.id, id) as Row | undefined
  // A pending note (review queue) is seen by its owner and by admins only.
  const vis = (me: Me) => ({ sql: "(n.status != 'pending' OR n.owner_id = ? OR ?)", args: [me.id, can(me, 'admin') ? 1 : 0] })
  const out = (r: Row, full: boolean, snippet?: string) => ({
    owner: r.owner, id: r.id, rev: r.rev, title: r.title, project: r.project, updated_at: r.updated_at, created_at: r.created_at,
    kind: r.kind, status: r.status, pinned: !!r.pinned, tags: JSON.parse(r.tags), superseded_by: r.superseded_by, shared_by: r.shared_by, source: r.source,
    ...(full ? { text: r.text } : { snippet: snippet ?? String(r.text).slice(0, 200) }),
  })
  const member = (m: Row) => ({ id: m.id, name: m.name, role: m.role, expires_at: m.expires_at, disabled: !!m.disabled, last_seen: m.last_seen, created_at: m.created_at })

  const audit = (me: { id: string; team_id: string } | null, action: string, target = '', details: Record<string, unknown> = {}) => {
    db.prepare('INSERT INTO audit (team_id, at, actor, action, target, details) VALUES (?, ?, ?, ?, ?, ?)').run(me?.team_id ?? teamId, now(), me?.id ?? null, action, target, JSON.stringify(details))
  }
  // Every change to a note leaves its text behind, so an edit can be read back and compared.
  const snap = (n: Row, by: string) => {
    db.prepare('INSERT OR REPLACE INTO note_revisions (team_id, owner_id, id, rev, title, text, kind, status, tags, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(n.team_id, n.owner_id, n.id, n.rev, n.title, n.text, n.kind, n.status, n.tags, by, n.updated_at)
  }
  /** Changes columns of a note (names from this file only), gives it a new revision and records it. */
  const change = (n: Row, set: Record<string, string | number | null>, by: string): Row => {
    const cols = Object.keys(set)
    db.prepare(`UPDATE notes SET ${cols.map((c) => `${c} = ?`).join(', ')}, rev = ?, updated_at = ? WHERE owner_id = ? AND id = ?`).run(...cols.map((c) => set[c]!), nextRev(), now(), n.owner_id, n.id)
    const r = db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?').get(n.owner_id, n.id) as Row
    snap(r, by)

    return r
  }

  // Rate limits, per member and minute.
  const used = new Map<string, { minute: number; reads: number; writes: number }>()
  const spend = (me: Me, write: boolean) => {
    const minute = Math.floor(now() / 60000)
    const u = used.get(me.id)?.minute === minute ? used.get(me.id)! : { minute, reads: 0, writes: 0 }
    used.set(me.id, u)
    if (write ? ++u.writes > LIMITS.writes : ++u.reads > LIMITS.reads) throw Object.assign(new HttpError(429, 'too_many', `more than ${write ? LIMITS.writes : LIMITS.reads} ${write ? 'writes' : 'reads'} a minute`), { retryAfter: 60 - Math.floor((now() / 1000) % 60) })
  }

  // Read counts stay 90 days, and an expired session is dropped. Checked once a day, on the first request.
  let swept = -1
  const sweep = () => {
    const day = Math.floor(now() / DAY)
    if (day === swept) return
    swept = day
    db.prepare('DELETE FROM note_reads WHERE day < ?').run(day - KEEP_READS_DAYS)
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now())
  }

  /** A share. `match` is the revision the client last saw, or `*` for a note new to the team. `seq` is the client's own
   * order of its changes: a share made before an unshare of the same note that already arrived loses to it. */
  function put(me: Me, id: string, note: { title: string; text: string; project: string } & Meta, match: number | '*', seq = 0): [number, unknown] {
    const t = db.prepare('SELECT seq FROM tombs WHERE owner_id = ? AND id = ?').get(me.id, id) as { seq: number } | undefined
    if (seq && t && t.seq >= seq) return [409, { error: { code: 'unshared', message: `${id} was unshared after this change was made` } }]
    const cur = owned(me, id)
    if (match === '*' ? cur : !cur || cur.rev !== match) return [409, { error: { code: 'stale', message: cur ? `the team has revision ${cur.rev} of ${id}` : `${id} is not shared` }, rev: cur?.rev ?? null, updated_at: cur?.updated_at ?? null }]
    const rev = nextRev()
    // With the review queue on, what a person who cannot approve shares waits for an admin, edits included.
    const status = settings().review_queue && !can(me, 'admin') ? 'pending' : cur?.status ?? 'active'
    db.prepare('INSERT INTO notes (team_id, owner_id, owner, id, rev, seq, title, text, project, updated_at, created_at, shared_by, kind, status, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET owner = excluded.owner, rev = excluded.rev, seq = excluded.seq, title = excluded.title, text = excluded.text, project = excluded.project, updated_at = excluded.updated_at, kind = excluded.kind, status = excluded.status, tags = excluded.tags, source = excluded.source')
      .run(me.team_id, me.id, me.name, id, rev, seq, note.title, note.text, note.project, now(), now(), me.id, note.kind ?? cur?.kind ?? 'note', status, JSON.stringify(note.tags ?? JSON.parse(cur?.tags ?? '[]')), note.source ?? cur?.source ?? '')
    snap(owned(me, id)!, me.id)

    return [200, { rev }]
  }
  /** An unshare: the note goes (with its revisions and counts) and a tomb records it, so feeds tell other machines. */
  function del(me: Me, id: string, match: number | '*', seq = 0): [number, unknown] {
    const cur = owned(me, id)
    if (cur && match !== '*' && cur.rev !== match) return [409, { error: { code: 'stale', message: `the team has revision ${cur.rev} of ${id}` }, rev: cur.rev, updated_at: cur.updated_at }]
    const rev = nextRev()
    for (const t of ['notes', 'note_revisions', 'note_reads']) db.prepare(`DELETE FROM ${t} WHERE owner_id = ? AND id = ?`).run(me.id, id)
    db.prepare('INSERT INTO tombs (team_id, owner_id, owner, id, rev, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET rev = excluded.rev, seq = max(seq, excluded.seq)').run(me.team_id, me.id, me.name, id, rev, seq)

    return [200, { rev }]
  }
  const noteBody = (n: Record<string, unknown>) => ({ title: str(n, 'title', 500), text: str(n, 'text', MAX_TEXT), project: str(n, 'project', 200), ...meta(n) })
  const meta = (n: Record<string, unknown>): Meta => ({
    ...(n.kind === undefined ? {} : { kind: oneOf(n.kind, KINDS, 'kind') }),
    ...(n.source === undefined ? {} : { source: str(n, 'source', 2000) }),
    ...(n.tags === undefined ? {} : { tags: tagList(n.tags) }),
  })
  const search = (me: Me, u: URL, limit: number, offset: number) => {
    const words = (u.searchParams.get('q') ?? '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? []
    if (!words.length) return []
    const v = vis(me)

    return (db.prepare(`SELECT n.*, snippet(notes_fts, 1, '**', '**', '…', 24) AS snip FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.team_id = ? AND ${v.sql} ORDER BY bm25(notes_fts), n.owner, n.id LIMIT ? OFFSET ?`).all(words.map((w) => `"${w}"`).join(' '), me.team_id, ...v.args, limit, offset) as Row[]).map((r) => out(r, false, r.snip))
  }

  /** The vault format of the plugin plus who shared it, so the folder drops into a member's Obsidian vault. */
  function exportZip(me: Me): Buffer {
    const v = vis(me)
    const rows = db.prepare(`SELECT n.*, coalesce(m.name, n.owner) AS shared_name FROM notes n LEFT JOIN members m ON m.id = n.shared_by WHERE n.team_id = ? AND n.status != 'pending' AND ${v.sql} ORDER BY n.project, n.created_at, n.owner, n.id`).all(me.team_id, ...v.args) as Row[]
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    const dirs = new Map<string, { project: string; lines: string[] }>()
    const files: [string, string][] = []
    for (const r of rows) {
      const dir = safe(r.project) || 'no-project'
      const base = `${safe(`${r.owner}-${r.id}`).slice(0, 80)}-${hash(`${r.owner}/${r.id}`).slice(0, 6)}`
      const sources = String(r.source).split(',').map((s) => s.trim()).filter(Boolean)
      files.push([`${dir}/${base}.md`, `---\nthenwise: ${VAULT_FORMAT}\nproject: ${quote(r.project)}\nsources: [${sources.map(quote).join(', ')}]\nshared_by: ${quote(r.shared_name)}\nkind: ${r.kind}\nstatus: ${r.status}\n---\n\n# ${r.title}\n\n${r.text}\n`])
      const d = dirs.get(dir) ?? dirs.set(dir, { project: r.project, lines: [] }).get(dir)!
      d.lines.push(`- [[${base}|${r.title.replace(/[|\]\[\n]/g, ' ')}]] (${r.kind}, ${r.status})`)
    }
    for (const [dir, d] of dirs) files.push([`${dir}/Index.md`, `# ${d.project || 'No project'}\n\n${d.lines.join('\n')}\n`])

    return zip(files, new Date(now()))
  }

  async function v1(req: IncomingMessage, u: URL, parts: string[]): Promise<Reply> {
    const [a, b, c, d] = parts
    const m = req.method
    if (m === 'GET' && a === 'health' && !b) return [200, { ok: true, schema: SCHEMA_VERSION, version: opts.version ?? '', team: settings().name }]
    if (m === 'POST' && a === 'session' && !b) {
      const token = str(await readBody(req, 1024), 'token', 200)
      const r = live(db.prepare(`${ME} WHERE m.token_hash = ? AND m.disabled = 0`).get(hash(token)) as Row | undefined)
      if (!r) throw new HttpError(401, 'unauthorized', 'a valid token is needed')

      return [200, member(r), { 'set-cookie': startSession(r as Me) }]
    }
    if (m === 'POST' && a === 'join' && !b) {
      const body = await readBody(req, 4096)
      const name = str(body, 'name', 32)
      if (!NAME_RE.test(name)) throw new HttpError(400, 'bad_request', 'a name is lower-case letters, digits, - and _, up to 32 characters')
      const inv = db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?').get(hash(str(body, 'code', 200)), now()) as Row | undefined
      if (!inv) throw new HttpError(401, 'invalid_invite', 'the invite is wrong, used or expired')
      if (db.prepare('SELECT 1 FROM members WHERE name = ?').get(name)) throw new HttpError(409, 'name_taken', `${name} is taken; choose another name`)
      const token = newToken()
      const id = randomBytes(16).toString('hex')
      db.prepare('INSERT INTO members (id, team_id, name, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, inv.team_id, name, hash(token), inv.role, now() + 365 * DAY, now())
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(id, now(), inv.code_hash)
      audit({ id, team_id: inv.team_id }, 'member.join', `member:${id}`, { role: inv.role, invited_by: inv.created_by })
      // From a browser the joiner is signed in at once; the token is returned either way, to be kept for the plugin.
      const browser = body.session === true || String(req.headers.accept).includes('text/html')

      return [200, { id, name, role: inv.role, token }, browser ? { 'set-cookie': startSession({ id, team_id: inv.team_id }) } : {}]
    }

    const me = who(req)
    if (!me) throw new HttpError(401, 'unauthorized', 'a valid token is needed')
    const write = m !== 'GET'
    if (me.via === 'session' && write && !(cookie(req, 'tw_csrf') && same(cookie(req, 'tw_csrf')!, String(req.headers['x-thenwise-csrf'] ?? '')) && same(csrfOf(me.sid!), String(req.headers['x-thenwise-csrf'])))) throw new HttpError(403, 'csrf', 'a write from a browser session needs the X-Thenwise-CSRF header')
    spend(me, write)
    if (!me.last_seen || now() - me.last_seen > 3600000) db.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(now(), me.id)
    const need = (action: Action) => {
      if (can(me, action)) return
      audit(me, 'denied', `${m} ${u.pathname}`, { needs: NEED[action] })
      throw new HttpError(403, 'forbidden', `this needs the ${NEED[action]} role`)
    }
    const limit = (dflt = 20) => clampInt(u.searchParams.get('limit'), dflt, 1, 200, 'limit')
    const offset = () => clampInt(u.searchParams.get('offset'), 0, 0, 1e9, 'offset')
    const since = () => clampInt(u.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'since')
    const memberById = (id: string | undefined) => {
      const r = db.prepare('SELECT * FROM members WHERE id = ? AND team_id = ?').get(id ?? '', me.team_id) as Row | undefined
      if (!r) throw new HttpError(404, 'not_found', 'no such member')

      return r
    }

    if (a === 'session' && !b && m === 'DELETE') {
      if (me.sid) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(me.sid))

      return [200, { ok: true }, { 'set-cookie': noCookies }]
    }
    if (m === 'GET' && a === 'me' && !b) return [200, { id: me.id, name: me.name, role: me.role }]
    if (m === 'GET' && a === 'search' && !b) return [200, { notes: search(me, u, limit(), offset()) }]
    if (m === 'GET' && a === 'tombs' && !b) return [200, { tombs: db.prepare('SELECT owner, id, rev FROM tombs WHERE team_id = ? AND rev > ? ORDER BY rev LIMIT ?').all(me.team_id, since(), limit()) }]

    if (a === 'members') {
      need('admin')
      if (m === 'GET' && !b) return [200, { members: (db.prepare('SELECT * FROM members WHERE team_id = ? ORDER BY name').all(me.team_id) as Row[]).map(member) }]
      const t = memberById(b)
      if (m === 'PATCH' && !c) {
        const body = await readBody(req, 4096)
        if (t.role === 'owner') throw new HttpError(409, 'owner_protected', 'the owner keeps the role and the access; hand the team over with make-owner')
        const set: Record<string, string | number | null> = {}
        if (body.role !== undefined) set.role = oneOf(body.role, ROLES.filter((r) => r !== 'owner'), 'role')
        if (body.expires_at !== undefined) set.expires_at = body.expires_at === null ? null : intField(body.expires_at, 0, Number.MAX_SAFE_INTEGER, 'expires_at')
        if (body.disabled !== undefined) {
          if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'bad_request', 'disabled must be true or false')
          set.disabled = body.disabled ? 1 : 0
          if (body.disabled) set.token_hash = null
        }
        if (!Object.keys(set).length) throw new HttpError(400, 'bad_request', 'nothing to change')
        db.prepare(`UPDATE members SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), t.id)
        if (set.disabled) db.prepare('DELETE FROM sessions WHERE member_id = ?').run(t.id)
        audit(me, 'member.update', `member:${t.id}`, { role: set.role, expires_at: set.expires_at, disabled: body.disabled })

        return [200, member(memberById(t.id))]
      }
      if (m === 'DELETE' && !c) {
        const keep = oneOf(u.searchParams.get('notes'), ['keep', 'delete'], 'notes')
        try {
          removeMember(db, t.name, keep === 'keep')
        } catch (e) {
          throw new HttpError(409, 'owner_protected', (e as Error).message)
        }
        audit(me, 'member.remove', `member:${t.id}`, { notes: keep })

        return [200, { ok: true }]
      }
      if (m === 'POST' && c === 'rotate' && !d) {
        if (t.disabled) throw new HttpError(409, 'disabled', 'the member is disabled; enable them first or invite them again')
        audit(me, 'member.rotate', `member:${t.id}`)

        return [200, { token: rotate(db, t.name) }]
      }
      if (m === 'POST' && c === 'make-owner' && !d) {
        need('owner')
        if (t.disabled || t.id === me.id) throw new HttpError(409, 'bad_target', 'pick another live member')
        db.exec('BEGIN')
        db.prepare("UPDATE members SET role = 'admin' WHERE id = ?").run(me.id)
        db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").run(t.id)
        db.exec('COMMIT')
        audit(me, 'member.make_owner', `member:${t.id}`)

        return [200, member(memberById(t.id))]
      }
      throw new HttpError(404, 'not_found', 'no such route')
    }
    if (a === 'settings' && !b) {
      need('admin')
      if (m === 'PATCH') {
        const body = await readBody(req, 4096)
        if (body.name !== undefined) {
          const name = str(body, 'name', 80).trim()
          if (!name) throw new HttpError(400, 'bad_request', 'name must not be empty')
          db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, me.team_id)
        }
        if (body.review_queue !== undefined) {
          if (typeof body.review_queue !== 'boolean') throw new HttpError(400, 'bad_request', 'review_queue must be true or false')
          db.prepare('UPDATE teams SET review_queue = ? WHERE id = ?').run(body.review_queue ? 1 : 0, me.team_id)
        }
        audit(me, 'settings.update', 'settings', { name: body.name, review_queue: body.review_queue })
      } else if (m !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
      const s = settings()

      return [200, { name: s.name, review_queue: !!s.review_queue }]
    }
    if (a === 'invites' && !b && m === 'POST') {
      need('admin')
      const body = await readBody(req, 4096)
      const role = oneOf(body.role ?? 'member', ROLES.filter((r) => r !== 'owner'), 'role')
      const days = body.days === undefined ? 7 : intField(body.days, 1, 365, 'days')
      const code = `twi_${randomBytes(24).toString('hex')}`
      db.prepare('INSERT INTO invites (code_hash, team_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(code), me.team_id, role, me.id, now() + days * DAY)
      audit(me, 'invite.create', `role:${role}`, { days })

      return [200, { code, role, expires_at: now() + days * DAY }]
    }
    if (a === 'audit' && !b && m === 'GET') {
      need('admin')
      const actor = u.searchParams.get('actor')
      const action = u.searchParams.get('action')
      const rows = db.prepare(`SELECT a.*, m.name AS actor_name FROM audit a LEFT JOIN members m ON m.id = a.actor WHERE a.team_id = ? AND a.at > ? ${actor ? 'AND a.actor = ?' : ''} ${action ? 'AND a.action = ?' : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(me.team_id, since(), ...(actor ? [actor] : []), ...(action ? [action] : []), limit(50), offset()) as Row[]

      return [200, { entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, actor_name: r.actor_name, action: r.action, target: r.target, details: JSON.parse(r.details) })) }]
    }
    if (a === 'stats' && !b && m === 'GET') {
      need('admin')
      const from = Math.floor(now() / DAY) - KEEP_READS_DAYS
      const top = db.prepare('SELECT n.owner, n.id, n.title, sum(r.count) AS reads FROM note_reads r JOIN notes n ON n.owner_id = r.owner_id AND n.id = r.id WHERE r.team_id = ? AND r.day > ? GROUP BY r.owner_id, r.id ORDER BY reads DESC, n.owner, n.id LIMIT 20').all(me.team_id, from)

      return [200, { days: KEEP_READS_DAYS, top, members: db.prepare('SELECT id, name, last_seen FROM members WHERE team_id = ? AND disabled = 0 ORDER BY name').all(me.team_id) }]
    }
    if (a === 'export.zip' && !b && m === 'GET') {
      need('curate')

      return [200, exportZip(me), { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="thenwise-export.zip"' }]
    }
    if (a !== 'notes') throw new HttpError(404, 'not_found', 'no such route')

    if (m === 'GET' && !b) {
      const v = vis(me)
      const owner = u.searchParams.get('owner')
      const feed = u.searchParams.get('since') !== null
      const where = ['n.team_id = ?', v.sql]
      const args: (string | number)[] = [me.team_id, ...v.args]
      if (owner) (where.push(owner === 'me' ? 'n.owner_id = ?' : 'n.owner = ?'), args.push(owner === 'me' ? me.id : owner))
      if (u.searchParams.get('project') !== null) (where.push('n.project = ?'), args.push(u.searchParams.get('project')!))
      if (u.searchParams.get('kind')) (where.push('n.kind = ?'), args.push(oneOf(u.searchParams.get('kind'), KINDS, 'kind')))
      if (u.searchParams.get('status')) (where.push('n.status = ?'), args.push(oneOf(u.searchParams.get('status'), STATUSES, 'status')))
      // A feed (since) reads forward in revision order and never carries a pending note; a listing reads the newest first.
      if (feed) (where.push('n.rev > ?', "n.status != 'pending'"), args.push(since()))
      const rows = db.prepare(`SELECT n.* FROM notes n WHERE ${where.join(' AND ')} ORDER BY ${feed ? 'n.rev' : 'n.rev DESC, n.owner, n.id'} LIMIT ? OFFSET ?`).all(...args, limit(), feed ? 0 : offset()) as Row[]

      // full=1 carries each note's text, so a feed reader needs no request per note.
      return [200, { notes: rows.map((r) => out(r, u.searchParams.get('full') === '1')) }]
    }
    // /notes/:owner/:id and what hangs off it. The owner is a name here, the id is the note's.
    if (b && c && ((!d && (m === 'GET' || m === 'PATCH')) || (m === 'GET' && d === 'revisions') || (m === 'POST' && ['retire', 'supersede', 'pin', 'unpin', 'approve'].includes(d ?? '')))) {
      const v = vis(me)
      const n = db.prepare(`SELECT n.* FROM notes n WHERE n.team_id = ? AND n.owner = ? AND n.id = ? AND ${v.sql}`).get(me.team_id, b, c, ...v.args) as Row | undefined
      if (!n) throw new HttpError(404, 'not_found', 'no such note')
      const target = `note:${b}/${c}`
      if (m === 'GET' && !d) {
        if (me.via === 'session') db.prepare('INSERT INTO note_reads (team_id, owner_id, id, day, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (team_id, owner_id, id, day) DO UPDATE SET count = count + 1').run(me.team_id, n.owner_id, n.id, Math.floor(now() / DAY))

        return [200, out(n, true), { etag: `"${n.rev}"` }]
      }
      if (m === 'GET') {
        const rows = db.prepare('SELECT r.*, coalesce(e.name, \'\') AS edited_by_name FROM note_revisions r LEFT JOIN members e ON e.id = r.edited_by WHERE r.owner_id = ? AND r.id = ? ORDER BY r.rev DESC LIMIT ? OFFSET ?').all(n.owner_id, n.id, limit(50), offset()) as Row[]

        return [200, { revisions: rows.map((r) => ({ rev: r.rev, title: r.title, text: r.text, kind: r.kind, status: r.status, tags: JSON.parse(r.tags), edited_by: r.edited_by, edited_by_name: r.edited_by_name, edited_at: r.edited_at })) }]
      }
      if (d === 'approve') {
        need('admin')
        if (n.status !== 'pending') throw new HttpError(409, 'not_pending', 'the note is not waiting for review')
        const r = change(n, { status: 'active' }, me.id)
        audit(me, 'note.approve', target)

        return [200, out(r, true), { etag: `"${r.rev}"` }]
      }
      if (m === 'PATCH') {
        need('curate')
        const match = ifMatch(req.headers['if-match'])
        if (match === '*') throw new HttpError(400, 'bad_request', 'If-Match must be the revision you read')
        if (match !== n.rev) return [409, { error: { code: 'stale', message: `the team has revision ${n.rev} of ${c}` }, rev: n.rev, updated_at: n.updated_at }]
        const body = await readBody(req, MAX_BODY)
        const set: Record<string, string | number | null> = {}
        for (const [k, max] of [['title', 500], ['text', MAX_TEXT], ['project', 200]] as const) if (body[k] !== undefined) set[k] = str(body, k, max)
        const mt = meta(body)
        if (mt.kind !== undefined) set.kind = mt.kind
        if (mt.source !== undefined) set.source = mt.source
        if (mt.tags !== undefined) set.tags = JSON.stringify(mt.tags)
        if (!Object.keys(set).length) throw new HttpError(400, 'bad_request', 'nothing to change')
        const r = change(n, set, me.id)
        audit(me, 'note.edit', target, { fields: Object.keys(set) })

        return [200, out(r, true), { etag: `"${r.rev}"` }]
      }
      need('curate')
      let set: Record<string, string | number | null>
      if (d === 'supersede') {
        const by = str(await readBody(req, 4096), 'by', 240)
        // `by` is a note id of the same owner, or owner/id.
        const [bo, bid] = by.includes('/') ? by.split('/', 2) : [n.owner, by]
        if (!db.prepare('SELECT 1 FROM notes WHERE team_id = ? AND owner = ? AND id = ?').get(me.team_id, bo, bid) || (bo === n.owner && bid === n.id)) throw new HttpError(400, 'bad_request', 'by must be another shared note')
        set = { status: 'superseded', superseded_by: by }
      } else set = d === 'retire' ? { status: 'retired' } : { pinned: d === 'pin' ? 1 : 0 }
      const r = change(n, set, me.id)
      audit(me, `note.${d}`, target, d === 'supersede' ? { by: set.superseded_by } : {})

      return [200, out(r, true), { etag: `"${r.rev}"` }]
    }
    if (!b || c || m === 'GET') throw new HttpError(404, 'not_found', 'no such route')
    if (!ID_RE.test(b)) throw new HttpError(400, 'bad_request', 'bad note id')
    if (m === 'PUT') {
      need('share')
      const n = await readBody(req, MAX_BODY)
      const [code, json] = put(me, b, noteBody(n), ifMatch(req.headers['if-match']), seqOf(n.seq))

      return [code, json, code === 200 ? { etag: `"${(json as { rev: number }).rev}"` } : {}]
    }
    if (m === 'DELETE') {
      need('share')

      return del(me, b, ifMatch(req.headers['if-match']), seqOf(u.searchParams.get('seq')))
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  const allow = opts.allowOrigins ?? []
  const send = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers })
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }
  const server: Server = createServer((req, res) => {
    // Security headers on every answer; a Hub on another host gets CORS only when its origin is listed.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', CSP)
    const origin = req.headers.origin
    const cors = !!origin && allow.includes(origin)
    if (cors) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-credentials', 'true')
      res.setHeader('access-control-expose-headers', 'etag')
      res.setHeader('vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      if (cors) (res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE'), res.setHeader('access-control-allow-headers', 'content-type, if-match, x-thenwise-csrf'), res.setHeader('access-control-max-age', '600'))

      return void res.writeHead(204).end()
    }
    const u = new URL(req.url ?? '/', 'http://x')
    let parts: string[]
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return send(res, 400, { error: { code: 'bad_request', message: 'bad path' } })
    }
    if (parts[0] !== 'v1') {
      const f = opts.console && (req.method === 'GET' || req.method === 'HEAD') ? serveConsole(opts.console, parts) : null
      if (f) return send(res, 200, f.body, { 'content-type': f.type, 'cache-control': f.cache })

      return send(res, 404, { error: 'not found. Routes without /v1 are gone; update Thenwise.' })
    }
    sweep()
    v1(req, u, parts.slice(1))
      .then(([code, json, headers]) => send(res, code, json, headers))
      .catch((e) => {
        const h = e instanceof HttpError ? e : new HttpError(500, 'server_error', 'server error')
        const retry = (e as { retryAfter?: number }).retryAfter
        // A dead session is cleared in the browser, so the app sees a clean sign-out.
        send(res, h.status, { error: { code: h.code, message: h.message } }, { ...(retry ? { 'retry-after': String(retry) } : {}), ...(h.status === 401 && cookie(req, 'tw_session') ? { 'set-cookie': noCookies } : {}) })
      })
  })
  server.requestTimeout = 30_000

  return {
    // 127.0.0.1 unless the owner chooses otherwise (see the check above).
    listen: () => new Promise((ok) => server.listen(opts.port ?? 0, host, () => ok({ host, port: (server.address() as { port: number }).port }))),
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => (db.close(), ok())))),
  }
}
