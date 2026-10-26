// The team database and its migrations. `PRAGMA user_version` is the schema version: each migration runs once, in a
// transaction, and a file written by a newer Thenwise is refused rather than half understood.

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

// The 0.1.5 tables. A new file starts from them too, so there is one path to the current schema.
const V0 = `CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (owner, id));
CREATE TABLE IF NOT EXISTS tombs (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (owner, id));`

const MIGRATIONS: ((db: DatabaseSync, now: number) => void)[] = [
  // 1 (0.1.9): a member has an id, a role and can be disabled; notes and tombs belong to the id; full-text search.
  (db, now) => {
    db.exec(`CREATE TABLE members1 (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'member',
        expires_at INTEGER, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, last_seen INTEGER);
      INSERT INTO members1 (id, name, token_hash, expires_at, created_at) SELECT lower(hex(randomblob(16))), name, token_hash, expires_at, ${now} FROM members;
      -- Owners whose member row was removed with their notes kept: disabled members, so their notes keep an owner.
      INSERT INTO members1 (id, name, created_at, disabled) SELECT lower(hex(randomblob(16))), owner, ${now}, 1 FROM (SELECT owner FROM notes UNION SELECT owner FROM tombs) WHERE owner NOT IN (SELECT name FROM members);
      -- seq is the sharing machine's own order of its changes (the old client revision): a share older than an unshare loses.
      CREATE TABLE notes1 (owner_id TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_id, id));
      INSERT INTO notes1 SELECT m.id, n.owner, n.id, n.rev, n.rev, n.title, n.text, n.project, ${now} FROM notes n JOIN members1 m ON m.name = n.owner;
      CREATE TABLE tombs1 (owner_id TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, id));
      INSERT INTO tombs1 SELECT m.id, t.owner, t.id, t.rev, t.rev FROM tombs t JOIN members1 m ON m.name = t.owner;
      DROP TABLE members; DROP TABLE notes; DROP TABLE tombs;
      ALTER TABLE members1 RENAME TO members; ALTER TABLE notes1 RENAME TO notes; ALTER TABLE tombs1 RENAME TO tombs;
      CREATE INDEX notes_rev ON notes (rev); CREATE INDEX tombs_rev ON tombs (rev);
      CREATE VIRTUAL TABLE notes_fts USING fts5 (title, text, content = 'notes', content_rowid = 'rowid', tokenize = 'porter unicode61 remove_diacritics 2');
      INSERT INTO notes_fts (rowid, title, text) SELECT rowid, title, text FROM notes;
      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text); END;
      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts (notes_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text); END;
      CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN INSERT INTO notes_fts (notes_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
        INSERT INTO notes_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text); END;`)
  },
]

/** Brings a team database to SCHEMA_VERSION. Refuses one from a newer Thenwise; returns the versions applied. */
export function migrateTeamDb(db: DatabaseSync, now = Date.now()): number[] {
  const at = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (at > SCHEMA_VERSION) throw new Error(`team.db was written by a newer Thenwise (schema ${at}, this one knows ${SCHEMA_VERSION}). Update Thenwise.`)
  const applied: number[] = []
  for (let v = at; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (v === 0) db.exec(V0)
      MIGRATIONS[v]!(db, now)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    applied.push(v + 1)
  }

  return applied
}

export function openTeamDb(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'team.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  try {
    migrateTeamDb(db)
  } catch (e) {
    db.close()
    throw e
  }
  for (const f of ['team.db', 'team.db-wal', 'team.db-shm']) if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o600)

  return db
}
