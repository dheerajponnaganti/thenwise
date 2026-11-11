// The teammates' shared chats this machine holds: <data folder>/team-chats.db (SQLite, mode 0600). Written by
// `team sync`, read by the ingest layer. It imports nothing from the ingest, so both can use it.

import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { MASK_VERSION, maskSecrets } from '../core/secrets.ts'

export interface WireTurn {
  id: string
  at: number
  line: string
  kind: 'turn' | 'summary'
  passages: string[]
  paths: string[]
  shas: string[]
  prs: string[]
  dead_end: boolean
  dead_kind: string
  /** The sentence that says what failed; empty from a sender that predates it. */
  dead_text?: string
}
export interface WireChat {
  owner: string
  session: string
  project: string
  rev: number
  started_at: number
  ended_at: number
  head: string
  mask: number
  bytes: number
  turns: WireTurn[]
  /** The coding tool the chat came from; missing or '' from a sender that predates it. */
  tool?: string
}

export const chatCacheFile = (dir: string) => join(dir, 'team-chats.db')
/** Which cached chats came from `thenwise import`, by owner: they read as imported, not as the team's. */
export const importsFile = (dir: string) => join(dir, 'imports.json')
export function loadImports(dir: string): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(importsFile(dir), 'utf8'))
  } catch {
    return {}
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS chats(owner TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL, rev INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, head TEXT, mask INTEGER, bytes INTEGER, tool TEXT DEFAULT '', PRIMARY KEY(owner, session));
CREATE TABLE IF NOT EXISTS passages(owner TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER, line TEXT, kind TEXT, text TEXT NOT NULL, paths TEXT, shas TEXT, prs TEXT, dead_end INTEGER, dead_kind TEXT, dead_text TEXT DEFAULT '', PRIMARY KEY(owner, session, turn, n));
CREATE TABLE IF NOT EXISTS since(k TEXT PRIMARY KEY, v INTEGER NOT NULL);`

export function openChatCache(dir: string): DatabaseSync {
  const db = openChatFile(chatCacheFile(dir))
  remaskCache(db)

  return db
}

/** Text fetched under an older MASK_VERSION is masked again in place, so newer patterns reach chats fetched before, with no refetch. */
function remaskCache(db: DatabaseSync) {
  const v = Number((db.prepare("SELECT v FROM since WHERE k = 'mask'").get() as { v: number } | undefined)?.v ?? 0)
  if (v === MASK_VERSION) return
  const m = (t: string | null) => (t == null ? t : maskSecrets(t).text)
  db.exec('BEGIN')
  try {
    const up = db.prepare('UPDATE passages SET line = ?, text = ?, dead_text = ?, prs = ? WHERE owner = ? AND session = ? AND turn = ? AND n = ?')
    for (const r of db.prepare('SELECT owner, session, turn, n, line, text, dead_text, prs FROM passages').all() as any[]) up.run(m(r.line), m(r.text), m(r.dead_text), m(r.prs), r.owner, r.session, r.turn, r.n)
    const uc = db.prepare('UPDATE chats SET head = ? WHERE owner = ? AND session = ?')
    for (const r of db.prepare('SELECT owner, session, head FROM chats').all() as any[]) uc.run(m(r.head), r.owner, r.session)
    db.prepare("INSERT INTO since VALUES ('mask', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(MASK_VERSION)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
/** Any file in the chat cache's schema (an export file too), mode 0600. */
export function openChatFile(f: string): DatabaseSync {
  const db = new DatabaseSync(f)
  db.exec(SCHEMA)
  if (!(db.prepare('PRAGMA table_info(passages)').all() as { name: string }[]).some((c) => c.name === 'dead_text')) db.exec("ALTER TABLE passages ADD COLUMN dead_text TEXT DEFAULT ''")
  if (!(db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).some((c) => c.name === 'tool')) db.exec("ALTER TABLE chats ADD COLUMN tool TEXT DEFAULT ''")
  chmodSync(f, 0o600)

  return db
}

export const cursor = (db: DatabaseSync, k: 'chats' | 'tombs'): number => Number((db.prepare('SELECT v FROM since WHERE k = ?').get(k) as { v: number } | undefined)?.v ?? 0)
export const setCursor = (db: DatabaseSync, k: 'chats' | 'tombs', v: number) => void db.prepare('INSERT INTO since VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = max(v, excluded.v)').run(k, v)

/** Replaces one chat in the cache (its passages go with it). */
export function putChat(db: DatabaseSync, c: WireChat) {
  dropChat(db, c.owner, c.session)
  db.prepare('INSERT INTO chats VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.owner, c.session, c.project, c.rev, c.started_at, c.ended_at, c.head, c.mask, c.bytes, c.tool ?? '')
  const ins = db.prepare('INSERT INTO passages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const t of c.turns) t.passages.forEach((p, n) => ins.run(c.owner, c.session, t.id, n, t.at, n ? '' : t.line, t.kind, p, JSON.stringify(n ? [] : t.paths), JSON.stringify(n ? [] : t.shas), JSON.stringify(n ? [] : t.prs), t.dead_end ? 1 : 0, t.dead_kind, t.dead_text ?? ''))
}
export function dropChat(db: DatabaseSync, owner: string, session: string) {
  db.prepare('DELETE FROM passages WHERE owner = ? AND session = ?').run(owner, session)
  db.prepare('DELETE FROM chats WHERE owner = ? AND session = ?').run(owner, session)
}

/** Every cached chat, in a fixed order, turns rebuilt from their passages. Empty when the cache does not exist. */
export function readChats(dir: string): WireChat[] {
  if (!existsSync(chatCacheFile(dir))) return []
  const db = openChatCache(dir)
  try {
    return chatsIn(db)
  } finally {
    db.close()
  }
}
/** Every chat in an open file of the cache's schema, in a fixed order, turns rebuilt from their passages. */
export function chatsIn(db: DatabaseSync): WireChat[] {
  const out: WireChat[] = []
  const rows = db.prepare('SELECT * FROM passages ORDER BY owner, session, rowid').all() as any[]
  let i = 0
  for (const c of db.prepare('SELECT * FROM chats ORDER BY owner, session').all() as any[]) {
    const turns: WireTurn[] = []
    for (; i < rows.length && rows[i].owner === c.owner && rows[i].session === c.session; i++) {
      const r = rows[i]
      if (r.n === 0) turns.push({ id: r.turn, at: r.at, line: r.line, kind: r.kind, passages: [r.text], paths: JSON.parse(r.paths), shas: JSON.parse(r.shas), prs: JSON.parse(r.prs), dead_end: !!r.dead_end, dead_kind: r.dead_kind, dead_text: r.dead_text ?? '' })
      else turns.at(-1)!.passages.push(r.text)
    }
    out.push({ ...c, turns })
  }

  return out
}
