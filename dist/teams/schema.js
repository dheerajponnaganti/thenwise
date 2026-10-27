// The team database and its migrations. `PRAGMA user_version` is the schema version: each migration runs once, in a
// transaction, and a file written by a newer Thenwise is refused rather than half understood.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
export const SCHEMA_VERSION = 4;
// The 0.1.5 tables. A new file starts from them too, so there is one path to the current schema.
const V0 = `CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (owner, id));
CREATE TABLE IF NOT EXISTS tombs (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (owner, id));`;
const MIGRATIONS = [
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
        INSERT INTO notes_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text); END;`);
    },
    // 2 (0.1.12): teams (one row for now, every row carries its id), roles, note metadata and revisions, invites,
    // sessions, an audit log and read counts.
    (db, now) => {
        const team = randomBytes(16).toString('hex');
        const col = (t) => `ALTER TABLE ${t} ADD COLUMN team_id TEXT NOT NULL DEFAULT '${team}';`;
        db.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, review_queue INTEGER NOT NULL DEFAULT 0);
      INSERT INTO teams (id, name, created_at) VALUES ('${team}', 'Team', ${now});
      ${col('members')} ${col('notes')} ${col('tombs')}
      ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
      ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE notes ADD COLUMN superseded_by TEXT;
      ALTER TABLE notes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE notes ADD COLUMN shared_by TEXT;
      ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT '';
      UPDATE notes SET created_at = updated_at, shared_by = owner_id;
      -- The first member of a 0.1.9 team is its owner.
      UPDATE members SET role = 'owner' WHERE id = (SELECT id FROM members WHERE disabled = 0 ORDER BY created_at, rowid LIMIT 1);
      CREATE TABLE note_revisions (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, tags TEXT NOT NULL, edited_by TEXT, edited_at INTEGER NOT NULL, PRIMARY KEY (owner_id, id, rev));
      INSERT INTO note_revisions SELECT team_id, owner_id, id, rev, title, text, kind, status, tags, owner_id, updated_at FROM notes;
      CREATE TABLE invites (code_hash TEXT PRIMARY KEY, team_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT, expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER);
      CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, team_id TEXT NOT NULL, member_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX audit_at ON audit (at);
      CREATE TABLE note_reads (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, id TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (team_id, owner_id, id, day));`);
    },
    // 3 (0.1.17): shared project chats. Passages are the engine's own pieces of a turn; chat_fts indexes them for the Hub.
    // The revision counter is shared with notes, so one feed cursor orders everything.
    (db) => {
        db.exec(`ALTER TABLE teams ADD COLUMN chat_retention_days INTEGER;
      CREATE TABLE chats (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, head TEXT NOT NULL, turns INTEGER NOT NULL, bytes INTEGER NOT NULL, mask INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, session));
      CREATE INDEX chats_rev ON chats (rev);
      CREATE TABLE chat_passages (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, line TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
        paths TEXT NOT NULL DEFAULT '[]', shas TEXT NOT NULL DEFAULT '[]', prs TEXT NOT NULL DEFAULT '[]', dead_end INTEGER NOT NULL DEFAULT 0, dead_kind TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'turn');
      CREATE INDEX chat_passages_chat ON chat_passages (owner_id, session);
      CREATE VIRTUAL TABLE chat_fts USING fts5 (text, content = 'chat_passages', content_rowid = 'rowid', tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TRIGGER chat_passages_ai AFTER INSERT ON chat_passages BEGIN INSERT INTO chat_fts (rowid, text) VALUES (new.rowid, new.text); END;
      CREATE TRIGGER chat_passages_ad AFTER DELETE ON chat_passages BEGIN INSERT INTO chat_fts (chat_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
      CREATE TABLE chat_tombs (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner TEXT NOT NULL, session TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, session));
      CREATE INDEX chat_tombs_rev ON chat_tombs (rev);
      CREATE TABLE shared_projects (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, project TEXT NOT NULL, since INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', last_push INTEGER NOT NULL, PRIMARY KEY (owner_id, project));
      CREATE TABLE chat_reads (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, session TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (team_id, owner_id, session, day));`);
    },
    // 4 (0.1.19): the sentence of a dead end travels with its turn.
    (db) => {
        db.exec("ALTER TABLE chat_passages ADD COLUMN dead_text TEXT NOT NULL DEFAULT ''");
    },
];
/** Brings a team database to SCHEMA_VERSION. Refuses one from a newer Thenwise; returns the versions applied. */
export function migrateTeamDb(db, now = Date.now()) {
    const at = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (at > SCHEMA_VERSION)
        throw new Error(`team.db was written by a newer Thenwise (schema ${at}, this one knows ${SCHEMA_VERSION}). Update Thenwise.`);
    const applied = [];
    for (let v = at; v < SCHEMA_VERSION; v++) {
        db.exec('BEGIN IMMEDIATE');
        try {
            if (v === 0)
                db.exec(V0);
            MIGRATIONS[v](db, now);
            db.exec(`PRAGMA user_version = ${v + 1}`);
            db.exec('COMMIT');
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        applied.push(v + 1);
    }
    return applied;
}
export function openTeamDb(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(dir, 'team.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    try {
        migrateTeamDb(db);
    }
    catch (e) {
        db.close();
        throw e;
    }
    // Freed pages must return to the file for a deletion to really delete; a file older than 0.1.17 is rebuilt once.
    if (Number(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum) !== 2)
        db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM');
    for (const f of ['team.db', 'team.db-wal', 'team.db-shm'])
        if (existsSync(join(dir, f)))
            chmodSync(join(dir, f), 0o600);
    return db;
}
