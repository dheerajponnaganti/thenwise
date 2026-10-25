// Teams preview server: one team, one token per person, shared notes only. The table holds nothing but
// notes their owners chose to share, and every statement binds its values, so a read cannot reach a private note.

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,119}$/
const MAX_BODY = 256 * 1024
const MAX_TEXT = 100 * 1024
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

export function openTeamDb(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'team.db'))
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (owner, id));
    CREATE TABLE IF NOT EXISTS tombs (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (owner, id));`)

  return db
}

/** Shown once: only its hash is stored. `expiresAt` is in ms; the default is one year. */
export function invite(db: DatabaseSync, name: string, expiresAt: number = Date.now() + 365 * 864e5): string {
  if (!NAME_RE.test(name)) throw new Error('a name is lower-case letters, digits, - and _, up to 32 characters')
  if (db.prepare('SELECT 1 FROM members WHERE name = ?').get(name)) throw new Error(`${name} is already a member`)
  const token = `tw_${randomBytes(32).toString('hex')}`
  db.prepare('INSERT INTO members (name, token_hash, expires_at) VALUES (?, ?, ?)').run(name, hash(token), expiresAt)

  return token
}

/** The token stops working at once. The member's notes go too, unless keepNotes (then they stay read-only). */
export function removeMember(db: DatabaseSync, name: string, keepNotes = false): { removed: boolean; notes: number } {
  const removed = Number(db.prepare('DELETE FROM members WHERE name = ?').run(name).changes) > 0
  const notes = Number((db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner = ?').get(name) as any).n)
  if (!keepNotes) for (const t of ['notes', 'tombs']) db.prepare(`DELETE FROM ${t} WHERE owner = ?`).run(name)

  return { removed, notes }
}

export interface TeamApp {
  listen(): Promise<{ host: string; port: number }>
  close(): Promise<void>
}

export function createTeamServer(opts: { dir: string; host?: string; port?: number }): TeamApp {
  const db = openTeamDb(opts.dir)
  const who = (auth: string | undefined) => {
    const m = /^Bearer (\S+)$/.exec(auth ?? '')
    const r = m ? (db.prepare('SELECT name, expires_at FROM members WHERE token_hash = ?').get(hash(m[1]!)) as { name: string; expires_at: number | null } | undefined) : undefined

    return r && (r.expires_at === null || r.expires_at > Date.now()) ? r.name : null
  }
  const page = (u: URL) => ({ limit: Math.min(Math.max(Number(u.searchParams.get('limit') ?? 20) | 0, 1), 50), offset: Math.max(Number(u.searchParams.get('offset') ?? 0) | 0, 0) })
  const row = (r: any, full: boolean) => ({ owner: r.owner, id: r.id, title: r.title, project: r.project, ...(full ? { text: r.text } : { snippet: String(r.text).slice(0, 200) }) })

  async function handle(method: string, u: URL, auth: string | undefined, body: () => Promise<any>): Promise<[number, unknown]> {
    const me = who(auth)
    if (!me) return [401, { error: 'unauthorized' }]
    let parts: string[]
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return [400, { error: 'bad path' }]
    }
    const [a, b, c] = parts
    if (method === 'GET' && a === 'me' && !b) return [200, { name: me }]
    if (method === 'GET' && a === 'search' && !b) {
      const words = (u.searchParams.get('q') ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? []
      if (!words.length) return [200, { notes: [] }]
      const { limit, offset } = page(u)
      const where = words.map(() => "instr(lower(title || ' ' || text), ?) > 0").join(' AND ')
      const rows = db.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY rev DESC, owner, id LIMIT ? OFFSET ?`).all(...words, limit, offset)

      return [200, { notes: rows.map((r) => row(r, false)) }]
    }
    if (a !== 'notes') return [404, { error: 'not found' }]
    if (method === 'GET' && !b) {
      const { limit, offset } = page(u)

      return [200, { notes: db.prepare('SELECT * FROM notes ORDER BY rev DESC, owner, id LIMIT ? OFFSET ?').all(limit, offset).map((r) => row(r, false)) }]
    }
    if (method === 'GET' && b && c && !parts[3]) {
      const r = db.prepare('SELECT * FROM notes WHERE owner = ? AND id = ?').get(b, c)

      return r ? [200, row(r, true)] : [404, { error: 'not found' }]
    }
    if (!b || c || method === 'GET') return [404, { error: 'not found' }]
    if (!ID_RE.test(b)) return [400, { error: 'bad id' }]
    // Writes touch only the caller's own rows. The revision orders share against unshare: a delete wins a tie.
    if (method === 'PUT') {
      const n = await body()
      if (!n || typeof n.title !== 'string' || typeof n.text !== 'string' || typeof n.project !== 'string' || !Number.isSafeInteger(n.rev) || n.text.length > MAX_TEXT || n.title.length > 500 || n.project.length > 200) return [400, { error: 'bad note' }]
      const t = db.prepare('SELECT rev FROM tombs WHERE owner = ? AND id = ?').get(me, b) as { rev: number } | undefined
      if (t && t.rev >= n.rev) return [409, { error: 'unshared' }]
      db.prepare('INSERT INTO notes (owner, id, rev, title, text, project) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, id) DO UPDATE SET rev = excluded.rev, title = excluded.title, text = excluded.text, project = excluded.project WHERE excluded.rev > notes.rev').run(me, b, n.rev, n.title, n.text, n.project)

      return [200, { ok: true }]
    }
    if (method === 'DELETE') {
      const rev = Number(u.searchParams.get('rev'))
      if (!Number.isSafeInteger(rev)) return [400, { error: 'bad rev' }]
      db.prepare('DELETE FROM notes WHERE owner = ? AND id = ? AND rev <= ?').run(me, b, rev)
      db.prepare('INSERT INTO tombs (owner, id, rev) VALUES (?, ?, ?) ON CONFLICT (owner, id) DO UPDATE SET rev = max(rev, excluded.rev)').run(me, b, rev)

      return [200, { ok: true }]
    }

    return [405, { error: 'method not allowed' }]
  }

  const readBody = (req: IncomingMessage) => async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const ch of req) {
      size += (ch as Buffer).length
      if (size > MAX_BODY) return null
      chunks.push(ch as Buffer)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req.method ?? 'GET', new URL(req.url ?? '/', 'http://x'), req.headers.authorization, readBody(req))
      .catch((): [number, unknown] => [500, { error: 'server error' }])
      .then(([code, json]) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      })
  })

  return {
    // 127.0.0.1 unless the owner chooses otherwise: there is no TLS here, so put a TLS proxy in front for other hosts.
    listen: () => new Promise((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => ok({ host: opts.host ?? '127.0.0.1', port: (server.address() as { port: number }).port }))),
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => (db.close(), ok())))),
  }
}
