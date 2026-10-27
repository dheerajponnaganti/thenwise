// Teams server: a team of people, one token each (or a browser session), shared notes only. The tables hold nothing
// but notes their owners chose to share, and every statement binds its values, so a read cannot reach a private note.
// Routes live under /v1 with `{ error: { code, message } }`. Revisions come from one server-wide counter: each note's
// revision only grows (If-Match), and feeds read in that order. Roles decide who may write; refusals are audited.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quote } from "../core/frontmatter.js";
import { maskSecrets } from "../core/secrets.js";
import { VAULT_FORMAT } from "../vault/vault.js";
import { CSP, serveConsole } from "./console.js";
import { CHAT_LIMITS, chatUnit, clampInt, HttpError, ifMatch, intField, oneOf, readBody, seqOf, str, tagList } from "./http.js";
import { openTeamDb, SCHEMA_VERSION } from "./schema.js";
import { zip } from "./zip.js";
export { openTeamDb };
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,119}$/;
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 100 * 1024;
// Per token and minute. A burst above this is a script gone wrong, not a person.
export const LIMITS = { reads: 600, writes: 60 };
const DAY = 864e5;
const SESSION_MS = 14 * DAY;
const KEEP_READS_DAYS = 90;
// Shared chat text per member (decision 8).
export const CHAT_QUOTA = 200 * 1024 * 1024;
export const ROLES = ['viewer', 'member', 'editor', 'admin', 'owner'];
const KINDS = ['decision', 'dead_end', 'rule', 'finding', 'note'];
const STATUSES = ['active', 'retired', 'superseded', 'pending'];
// The lowest role that may do each thing.
const NEED = { read: 'viewer', share: 'member', curate: 'editor', admin: 'admin', owner: 'owner' };
export const can = (m, action) => ROLES.indexOf(m.role) >= ROLES.indexOf(NEED[action]);
const hash = (t) => createHash('sha256').update(t).digest('hex');
const newToken = () => `tw_${randomBytes(32).toString('hex')}`;
// The CSRF value of a session: the cookie must carry it and every write must send it back in a header.
const csrfOf = (sid) => hash(`csrf:${sid}`).slice(0, 32);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const teamOf = (db) => db.prepare('SELECT id FROM teams ORDER BY created_at LIMIT 1').get().id;
/** The next revision: one counter for notes and chats, so a feed cursor orders everything. */
const nextRevOf = (db) => 1 + Number(db.prepare('SELECT max(r) AS r FROM (SELECT max(rev) AS r FROM notes UNION ALL SELECT max(rev) FROM tombs UNION ALL SELECT max(rev) FROM chats UNION ALL SELECT max(rev) FROM chat_tombs)').get().r ?? 0);
/** An unshare: the note goes (with its revisions and counts) and a tomb records it, so feeds tell other machines. */
function dropNote(db, m, id, seq = 0) {
    const rev = nextRevOf(db);
    for (const t of ['notes', 'note_revisions', 'note_reads'])
        db.prepare(`DELETE FROM ${t} WHERE owner_id = ? AND id = ?`).run(m.id, id);
    db.prepare('INSERT INTO tombs (team_id, owner_id, owner, id, rev, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET rev = excluded.rev, seq = max(seq, excluded.seq)').run(m.team_id, m.id, m.name, id, rev, seq);
    return rev;
}
/** Deletes a chat for real (passages, their FTS entries, read counts) and records a tomb so other machines drop it. */
function dropChat(db, m, session, seq = 0) {
    const rev = nextRevOf(db);
    for (const t of ['chat_passages', 'chats', 'chat_reads'])
        db.prepare(`DELETE FROM ${t} WHERE owner_id = ? AND session = ?`).run(m.id, session);
    db.prepare('INSERT INTO chat_tombs (team_id, owner_id, owner, session, rev, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, session) DO UPDATE SET rev = excluded.rev, seq = max(seq, excluded.seq)').run(m.team_id, m.id, m.name, session, rev, seq);
    return rev;
}
/** Unshares every chat of a project of one member; returns the sessions dropped. */
function dropProject(db, m, project) {
    const rows = db.prepare('SELECT session, bytes FROM chats WHERE owner_id = ? AND project = ?').all(m.id, project);
    for (const r of rows)
        dropChat(db, m, r.session);
    db.prepare('DELETE FROM shared_projects WHERE owner_id = ? AND project = ?').run(m.id, project);
    return { chats: rows.length, bytes: rows.reduce((a, r) => a + r.bytes, 0) };
}
/** Shown once: only its hash is stored. `expiresAt` is in ms; the default is one year. A name a live member holds is
 * refused; a disabled member (removed with notes kept) comes back with the same id only with `again`. The first member
 * of a team is its owner. */
export function invite(db, name, expiresAt = Date.now() + 365 * DAY, opts = {}) {
    if (!NAME_RE.test(name))
        throw new Error('a name is lower-case letters, digits, - and _, up to 32 characters');
    const m = db.prepare('SELECT id, role, disabled FROM members WHERE name = ?').get(name);
    if (m && !m.disabled)
        throw new Error(`${name} is already a member; \`team rotate ${name}\` gives them a new token`);
    if (m && !opts.again)
        throw new Error(`${name} was removed and their notes kept. If this is the same person, run \`team invite --again ${name}\`; if not, use another name.`);
    const token = newToken();
    const id = m?.id ?? randomBytes(16).toString('hex');
    const team = teamOf(db);
    const role = m?.role ?? opts.role ?? (db.prepare("SELECT 1 FROM members WHERE role = 'owner'").get() ? 'member' : 'owner');
    if (m)
        db.prepare('UPDATE members SET token_hash = ?, expires_at = ?, disabled = 0 WHERE id = ?').run(hash(token), expiresAt, id);
    else
        db.prepare('INSERT INTO members (id, team_id, name, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, team, name, hash(token), role, expiresAt, Date.now());
    // The command line is an invite too: a row used on the spot, so the audit trail and the Hub see who came in how.
    db.prepare('INSERT INTO invites (code_hash, team_id, role, expires_at, used_by, used_at) VALUES (?, ?, ?, ?, ?, ?)').run(hash(token), team, role, expiresAt, id, Date.now());
    return token;
}
/** A new token for a live member; the old one and any browser session stop working at once. */
export function rotate(db, name) {
    const token = newToken();
    const m = db.prepare('SELECT id FROM members WHERE name = ? AND disabled = 0').get(name);
    if (!m)
        throw new Error(`${name} is not a member`);
    db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').run(hash(token), m.id);
    db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id);
    return token;
}
/** The token stops working at once. Kept notes stay under a disabled member (so the name is not reused by someone
 * else); otherwise the member and their notes go. The owner is handed over first, never removed. */
export function removeMember(db, name, keepNotes = false) {
    const m = db.prepare('SELECT id, role, team_id FROM members WHERE name = ? AND disabled = 0').get(name);
    if (!m)
        return { removed: false, notes: 0 };
    if (m.role === 'owner')
        throw new Error(`${name} is the owner and cannot be removed; hand the team over first`);
    const notes = Number(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(m.id).n);
    db.prepare('DELETE FROM sessions WHERE member_id = ?').run(m.id);
    if (keepNotes)
        db.prepare('UPDATE members SET disabled = 1, token_hash = NULL WHERE id = ?').run(m.id);
    else {
        // Each note gets a tomb before the member row goes, so teammates drop their copies at the next sync. Old tombs stay.
        for (const n of db.prepare('SELECT id FROM notes WHERE owner_id = ?').all(m.id))
            dropNote(db, { ...m, name }, n.id);
        // Their chats go with tombs, so teammates drop their copies; kept notes keep chats readable.
        for (const c of db.prepare('SELECT session FROM chats WHERE owner_id = ?').all(m.id))
            dropChat(db, { ...m, name }, c.session);
        db.prepare('DELETE FROM shared_projects WHERE owner_id = ?').run(m.id);
        db.prepare('DELETE FROM members WHERE id = ?').run(m.id);
    }
    return { removed: true, notes };
}
export const listMembers = (db) => db.prepare('SELECT name, role, expires_at, disabled, last_seen FROM members ORDER BY name').all();
export function createTeamServer(opts) {
    const host = opts.host ?? '127.0.0.1';
    // Cookies and tokens over plain http on a network can be read on the way.
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && !opts.tlsBehindProxy && !opts.allowPlainHttp)
        throw new Error(`refused: ${host} is not this machine. Put a TLS proxy in front and add --tls-behind-proxy, or add --allow-plain-http if the network is trusted.`);
    if (opts.console && !existsSync(join(opts.console, 'index.html')))
        throw new Error(`${opts.console} has no index.html`);
    const db = openTeamDb(opts.dir);
    const now = opts.now ?? Date.now;
    const teamId = teamOf(db);
    const settings = () => db.prepare('SELECT name, review_queue FROM teams WHERE id = ?').get(teamId);
    const ME = 'SELECT m.id, m.name, m.role, m.last_seen, m.team_id, m.expires_at FROM members m';
    const live = (r) => (r && (r.expires_at === null || r.expires_at > now()) ? r : null);
    const cookie = (req, name) => (req.headers.cookie ?? '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    const who = (req) => {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
        if (m) {
            const r = live(db.prepare(`${ME} WHERE m.token_hash = ? AND m.disabled = 0`).get(hash(m[1])));
            return r ? { ...r, via: 'token' } : null;
        }
        const sid = cookie(req, 'tw_session');
        const r = sid ? live(db.prepare(`${ME} JOIN sessions s ON s.member_id = m.id WHERE s.id_hash = ? AND s.expires_at > ? AND m.disabled = 0`).get(hash(sid), now())) : null;
        return r ? { ...r, via: 'session', sid } : null;
    };
    const cookieFlags = `Path=/; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${opts.tlsBehindProxy ? '; Secure' : ''}`;
    const startSession = (m) => {
        const sid = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions (id_hash, team_id, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(sid), m.team_id, m.id, now(), now() + SESSION_MS);
        return [`tw_session=${sid}; HttpOnly; ${cookieFlags}`, `tw_csrf=${csrfOf(sid)}; ${cookieFlags}`];
    };
    const noCookies = ['tw_session', 'tw_csrf'].map((n) => `${n}=; Path=/; SameSite=Strict; Max-Age=0`);
    const nextRev = () => nextRevOf(db);
    const owned = (me, id) => db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?').get(me.id, id);
    // A pending note (review queue) is seen by its owner and by admins only.
    const vis = (me) => ({ sql: "(n.status != 'pending' OR n.owner_id = ? OR ?)", args: [me.id, can(me, 'admin') ? 1 : 0] });
    const out = (r, full, snippet) => ({
        owner: r.owner, id: r.id, rev: r.rev, title: r.title, project: r.project, updated_at: r.updated_at, created_at: r.created_at,
        kind: r.kind, status: r.status, pinned: !!r.pinned, tags: JSON.parse(r.tags), superseded_by: r.superseded_by, shared_by: r.shared_by, source: r.source,
        ...(full ? { text: r.text } : { snippet: snippet ?? String(r.text).slice(0, 200) }),
    });
    const member = (m) => ({ id: m.id, name: m.name, role: m.role, expires_at: m.expires_at, disabled: !!m.disabled, last_seen: m.last_seen, created_at: m.created_at });
    const audit = (me, action, target = '', details = {}) => {
        db.prepare('INSERT INTO audit (team_id, at, actor, action, target, details) VALUES (?, ?, ?, ?, ?, ?)').run(me?.team_id ?? teamId, now(), me?.id ?? null, action, target, JSON.stringify(details));
    };
    // Every change to a note leaves its text behind, so an edit can be read back and compared.
    const snap = (n, by) => {
        db.prepare('INSERT OR REPLACE INTO note_revisions (team_id, owner_id, id, rev, title, text, kind, status, tags, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(n.team_id, n.owner_id, n.id, n.rev, n.title, n.text, n.kind, n.status, n.tags, by, n.updated_at);
    };
    /** Changes columns of a note (names from this file only), gives it a new revision and records it. */
    const change = (n, set, by) => {
        const cols = Object.keys(set);
        db.prepare(`UPDATE notes SET ${cols.map((c) => `${c} = ?`).join(', ')}, rev = ?, updated_at = ? WHERE owner_id = ? AND id = ?`).run(...cols.map((c) => set[c]), nextRev(), now(), n.owner_id, n.id);
        const r = db.prepare('SELECT * FROM notes WHERE owner_id = ? AND id = ?').get(n.owner_id, n.id);
        snap(r, by);
        return r;
    };
    // Failed sign-ins per client IP and minute. Behind a proxy every client shares the proxy's address (shortcut: no X-Forwarded-For).
    const fails = new Map();
    const failed = (req, e) => {
        const ip = req.socket.remoteAddress ?? '?';
        const minute = Math.floor(now() / 60000);
        if (fails.size > 1000)
            for (const [k, v] of fails)
                if (v.minute !== minute)
                    fails.delete(k);
        let f = fails.get(ip);
        if (f?.minute !== minute) {
            f = { minute, n: 0, row: 0 };
            fails.set(ip, f);
        }
        f.n++;
        const details = JSON.stringify({ ip, failures: f.n });
        if (!f.row)
            f.row = db.prepare('INSERT INTO audit (team_id, at, actor, action, target, details) VALUES (?, ?, NULL, ?, ?, ?)').run(teamId, now(), 'auth.failed', ip, details).lastInsertRowid;
        else
            db.prepare('UPDATE audit SET details = ? WHERE rowid = ?').run(details, f.row);
        return f.n > 20 ? Object.assign(new HttpError(429, 'too_many_attempts', 'too many failed sign-ins; wait a minute'), { retryAfter: 60 - Math.floor((now() / 1000) % 60) }) : e;
    };
    // Rate limits, per member and minute.
    const used = new Map();
    const spend = (me, write) => {
        const minute = Math.floor(now() / 60000);
        const u = used.get(me.id)?.minute === minute ? used.get(me.id) : { minute, reads: 0, writes: 0 };
        used.set(me.id, u);
        if (write ? ++u.writes > LIMITS.writes : ++u.reads > LIMITS.reads)
            throw Object.assign(new HttpError(429, 'too_many', `more than ${write ? LIMITS.writes : LIMITS.reads} ${write ? 'writes' : 'reads'} a minute`), { retryAfter: 60 - Math.floor((now() / 1000) % 60) });
    };
    // Read counts stay 90 days, and an expired session is dropped. Checked once a day, on the first request.
    let swept = -1;
    const sweep = () => {
        const day = Math.floor(now() / DAY);
        if (day === swept)
            return;
        swept = day;
        db.prepare('DELETE FROM note_reads WHERE day < ?').run(day - KEEP_READS_DAYS);
        db.prepare('DELETE FROM chat_reads WHERE day < ?').run(day - KEEP_READS_DAYS);
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
        const keep = db.prepare('SELECT chat_retention_days AS d FROM teams WHERE id = ?').get(teamId).d;
        if (keep) {
            const old = db.prepare('SELECT c.owner_id AS id, c.owner AS name, c.team_id, c.session, c.bytes FROM chats c WHERE c.team_id = ? AND max(c.ended_at, c.started_at) < ?').all(teamId, now() - keep * DAY);
            for (const c of old)
                dropChat(db, c, c.session);
            if (old.length)
                audit(null, 'chat.retention', 'chats', { days: keep, chats: old.length, bytes: old.reduce((a, c) => a + c.bytes, 0) });
        }
        // Returns freed pages to the file, so what was deleted is no longer on disk.
        db.exec("PRAGMA incremental_vacuum; INSERT INTO chat_fts (chat_fts) VALUES ('optimize')");
    };
    /** A share. `match` is the revision the client last saw, or `*` for a note new to the team. `seq` is the client's own
     * order of its changes: a share made before an unshare of the same note that already arrived loses to it. */
    function put(me, id, note, match, seq = 0) {
        const t = db.prepare('SELECT seq FROM tombs WHERE owner_id = ? AND id = ?').get(me.id, id);
        if (seq && t && t.seq >= seq)
            return [409, { error: { code: 'unshared', message: `${id} was unshared after this change was made` } }];
        const cur = owned(me, id);
        if (match === '*' ? cur : !cur || cur.rev !== match)
            return [409, { error: { code: 'stale', message: cur ? `the team has revision ${cur.rev} of ${id}` : `${id} is not shared` }, rev: cur?.rev ?? null, updated_at: cur?.updated_at ?? null }];
        // The client masks too; a raw API call must not store a secret.
        note = { ...note, title: maskSecrets(note.title).text, text: maskSecrets(note.text).text };
        const rev = nextRev();
        // With the review queue on, what a person who cannot approve shares waits for an admin, edits included.
        const status = settings().review_queue && !can(me, 'admin') ? 'pending' : cur?.status ?? 'active';
        db.prepare('INSERT INTO notes (team_id, owner_id, owner, id, rev, seq, title, text, project, updated_at, created_at, shared_by, kind, status, tags, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET owner = excluded.owner, rev = excluded.rev, seq = excluded.seq, title = excluded.title, text = excluded.text, project = excluded.project, updated_at = excluded.updated_at, kind = excluded.kind, status = excluded.status, tags = excluded.tags, source = excluded.source')
            .run(me.team_id, me.id, me.name, id, rev, seq, note.title, note.text, note.project, now(), now(), me.id, note.kind ?? cur?.kind ?? 'note', status, JSON.stringify(note.tags ?? JSON.parse(cur?.tags ?? '[]')), note.source ?? cur?.source ?? '');
        snap(owned(me, id), me.id);
        return [200, { rev }];
    }
    /** An unshare: the note goes (with its revisions and counts) and a tomb records it, so feeds tell other machines. */
    function del(me, id, match, seq = 0) {
        const cur = owned(me, id);
        if (cur && match !== '*' && cur.rev !== match)
            return [409, { error: { code: 'stale', message: `the team has revision ${cur.rev} of ${id}` }, rev: cur.rev, updated_at: cur.updated_at }];
        return [200, { rev: dropNote(db, me, id, seq) }];
    }
    /** A chat unit as stored: turns rebuilt from their passages (metadata sits on a turn's first row). */
    const unitOf = (c, full) => {
        const head = { owner: c.owner, session: c.session, project: c.project, rev: c.rev, started_at: c.started_at, ended_at: c.ended_at, head: c.head, mask: c.mask, bytes: c.bytes, turn_count: c.turns };
        if (!full)
            return head;
        const turns = [];
        for (const r of db.prepare('SELECT * FROM chat_passages WHERE owner_id = ? AND session = ? ORDER BY rowid').all(c.owner_id, c.session))
            if (r.n === 0)
                turns.push({ id: r.turn, at: r.at, line: r.line, kind: r.kind, passages: [r.text], paths: JSON.parse(r.paths), shas: JSON.parse(r.shas), prs: JSON.parse(r.prs), dead_end: !!r.dead_end, dead_kind: r.dead_kind, dead_text: r.dead_text });
            else
                turns.at(-1).passages.push(r.text);
        return { ...head, turns };
    };
    /** A chat push. `match` and `seq` work as for notes; the passages are replaced as one transaction. */
    function putChat(me, session, unit, match, seq = 0, reshare = false) {
        const t = db.prepare('SELECT seq FROM chat_tombs WHERE owner_id = ? AND session = ?').get(me.id, session);
        const mk = (x) => maskSecrets(x).text;
        unit = { ...unit, head: mk(unit.head), turns: unit.turns.map((tn) => ({ ...tn, line: mk(tn.line), passages: tn.passages.map(mk), dead_text: mk(tn.dead_text) })) };
        // A tomb with seq 0 was made on the server (admin, Hub, retention, member removal): only a deliberate re-share undoes it.
        if (t && ((seq && t.seq >= seq) || (!t.seq && !reshare)))
            return [409, { error: { code: 'unshared', message: `${session} was unshared after this change was made` } }];
        const cur = db.prepare('SELECT rev, bytes, updated_at FROM chats WHERE owner_id = ? AND session = ?').get(me.id, session);
        if (match === '*' ? cur : !cur || cur.rev !== match)
            return [409, { error: { code: 'stale', message: cur ? `the team has revision ${cur.rev} of ${session}` : `${session} is not shared` }, rev: cur?.rev ?? null, updated_at: cur?.updated_at ?? null }];
        const have = Number(db.prepare('SELECT coalesce(sum(bytes), 0) AS b FROM chats WHERE owner_id = ?').get(me.id).b) - (cur?.bytes ?? 0);
        if (have + unit.bytes > CHAT_QUOTA) {
            audit(me, 'chat.quota', `chat:${session}`, { bytes: unit.bytes, have });
            throw new HttpError(413, 'quota', `shared chats are limited to ${CHAT_QUOTA / 1024 / 1024} MB per member`);
        }
        const rev = nextRev();
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare('DELETE FROM chat_passages WHERE owner_id = ? AND session = ?').run(me.id, session);
            db.prepare('INSERT INTO chats (team_id, owner_id, owner, project, session, rev, seq, started_at, ended_at, head, turns, bytes, mask, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, session) DO UPDATE SET owner = excluded.owner, project = excluded.project, rev = excluded.rev, seq = excluded.seq, started_at = excluded.started_at, ended_at = excluded.ended_at, head = excluded.head, turns = excluded.turns, bytes = excluded.bytes, mask = excluded.mask, updated_at = excluded.updated_at')
                .run(me.team_id, me.id, me.name, unit.project, session, rev, seq, unit.started_at, unit.ended_at, unit.head, unit.turns.length, unit.bytes, unit.mask, now());
            const ins = db.prepare('INSERT INTO chat_passages (team_id, owner_id, session, turn, n, at, line, text, paths, shas, prs, dead_end, dead_kind, kind, dead_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const tn of unit.turns)
                tn.passages.forEach((text, n) => ins.run(me.team_id, me.id, session, tn.id, n, tn.at, n ? '' : tn.line, text, n ? '[]' : JSON.stringify(tn.paths), n ? '[]' : JSON.stringify(tn.shas), n ? '[]' : JSON.stringify(tn.prs), tn.dead_end ? 1 : 0, tn.dead_kind, tn.kind, tn.dead_text));
            const fresh = !db.prepare('SELECT 1 FROM shared_projects WHERE owner_id = ? AND project = ?').get(me.id, unit.project);
            db.prepare('INSERT INTO shared_projects (team_id, owner_id, project, since, last_push) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id, project) DO UPDATE SET last_push = excluded.last_push').run(me.team_id, me.id, unit.project, now(), now());
            if (t && reshare)
                db.prepare('UPDATE chat_tombs SET seq = ? WHERE owner_id = ? AND session = ?').run(Math.max(seq, 1), me.id, session);
            if (fresh)
                audit(me, 'project.share', `project:${unit.project}`);
            audit(me, 'chat.share', `chat:${session}`, { turns: unit.turns.length, passages: unit.turns.reduce((a, x) => a + x.passages.length, 0), bytes: unit.bytes });
            db.exec('COMMIT');
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
        return [200, { rev }];
    }
    /** An unshare of one chat: rows, FTS entries and read counts go, a tomb stays. */
    function delChat(me, owner, session, match, seq = 0) {
        const cur = db.prepare('SELECT rev, bytes, updated_at FROM chats WHERE owner_id = ? AND session = ?').get(owner.id, session);
        if (cur && match !== '*' && cur.rev !== match)
            return [409, { error: { code: 'stale', message: `the team has revision ${cur.rev} of ${session}` }, rev: cur.rev, updated_at: cur.updated_at }];
        const rev = dropChat(db, owner, session, seq);
        audit(me, owner.id === me.id ? 'chat.unshare' : 'chat.admin_unshare', `chat:${session}`, { bytes: cur?.bytes ?? 0, owner: owner.name });
        return [200, { rev }];
    }
    const chatFeed = (me, u, lim, since) => {
        const project = u.searchParams.get('project');
        const mine = u.searchParams.get('mine') === null ? 'exclude' : oneOf(u.searchParams.get('mine'), ['exclude', 'include', 'only'], 'mine');
        const rows = db.prepare(`SELECT * FROM chats WHERE team_id = ? AND ${mine === 'exclude' ? 'owner_id != ?' : mine === 'only' ? 'owner_id = ?' : '? IS NOT NULL'} AND rev > ? ${project === null ? '' : 'AND project = ?'} ORDER BY rev LIMIT ?`).all(me.team_id, me.id, since, ...(project === null ? [] : [project]), lim);
        const full = u.searchParams.get('full') === '1';
        return rows.map((c) => unitOf(c, full));
    };
    /** Chats that match, the best passage of each first, with a snippet. */
    const searchChats = (me, u, lim) => {
        const words = (u.searchParams.get('q') ?? '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
        if (!words.length)
            return [];
        const project = u.searchParams.get('project');
        const owner = u.searchParams.get('owner');
        const rows = db.prepare(`SELECT c.*, p.turn AS hit_turn, snippet(chat_fts, 0, '**', '**', '…', 24) AS snip FROM chat_fts JOIN chat_passages p ON p.rowid = chat_fts.rowid JOIN chats c ON c.owner_id = p.owner_id AND c.session = p.session WHERE chat_fts MATCH ? AND c.team_id = ? ${project === null ? '' : 'AND c.project = ?'} ${owner === null ? '' : 'AND c.owner = ?'} ORDER BY bm25(chat_fts), c.owner, c.session LIMIT 500`)
            .all(words.map((w) => `"${w}"`).join(' '), me.team_id, ...(project === null ? [] : [project]), ...(owner === null ? [] : [owner]));
        const seen = new Map();
        for (const r of rows)
            if (!seen.has(`${r.owner_id}/${r.session}`))
                seen.set(`${r.owner_id}/${r.session}`, r);
        return [...seen.values()].slice(0, lim).map((r) => ({ ...unitOf(r, false), turn: r.hit_turn, snippet: r.snip }));
    };
    const noteBody = (n) => ({ title: str(n, 'title', 500), text: str(n, 'text', MAX_TEXT), project: str(n, 'project', 200), ...meta(n) });
    const meta = (n) => ({
        ...(n.kind === undefined ? {} : { kind: oneOf(n.kind, KINDS, 'kind') }),
        ...(n.source === undefined ? {} : { source: str(n, 'source', 2000) }),
        ...(n.tags === undefined ? {} : { tags: tagList(n.tags) }),
    });
    const search = (me, u, limit, offset) => {
        const words = (u.searchParams.get('q') ?? '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
        if (!words.length)
            return [];
        const v = vis(me);
        return db.prepare(`SELECT n.*, snippet(notes_fts, 1, '**', '**', '…', 24) AS snip FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.team_id = ? AND ${v.sql} ORDER BY bm25(notes_fts), n.owner, n.id LIMIT ? OFFSET ?`).all(words.map((w) => `"${w}"`).join(' '), me.team_id, ...v.args, limit, offset).map((r) => out(r, false, r.snip));
    };
    /** The vault format of the plugin plus who shared it, so the folder drops into a member's Obsidian vault. */
    function exportZip(me) {
        const v = vis(me);
        const rows = db.prepare(`SELECT n.*, coalesce(m.name, n.owner) AS shared_name FROM notes n LEFT JOIN members m ON m.id = n.shared_by WHERE n.team_id = ? AND n.status != 'pending' AND ${v.sql} ORDER BY n.project, n.created_at, n.owner, n.id`).all(me.team_id, ...v.args);
        const safe = (s) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        const dirs = new Map();
        const files = [];
        for (const r of rows) {
            const dir = safe(r.project) || 'no-project';
            const base = `${safe(`${r.owner}-${r.id}`).slice(0, 80)}-${hash(`${r.owner}/${r.id}`).slice(0, 6)}`;
            const sources = String(r.source).split(',').map((s) => s.trim()).filter(Boolean);
            files.push([`${dir}/${base}.md`, `---\nthenwise: ${VAULT_FORMAT}\nproject: ${quote(r.project)}\nsources: [${sources.map(quote).join(', ')}]\nshared_by: ${quote(r.shared_name)}\nkind: ${r.kind}\nstatus: ${r.status}\n---\n\n# ${r.title}\n\n${r.text}\n`]);
            const d = dirs.get(dir) ?? dirs.set(dir, { project: r.project, lines: [] }).get(dir);
            d.lines.push(`- [[${base}|${r.title.replace(/[|\]\[\n]/g, ' ')}]] (${r.kind}, ${r.status})`);
        }
        for (const [dir, d] of dirs)
            files.push([`${dir}/Index.md`, `# ${d.project || 'No project'}\n\n${d.lines.join('\n')}\n`]);
        return zip(files, new Date(now()));
    }
    async function v1(req, u, parts) {
        const [a, b, c, d] = parts;
        const m = req.method;
        if (m === 'GET' && a === 'health' && !b)
            return [200, { ok: true, schema: SCHEMA_VERSION, version: opts.version ?? '', team: settings().name }];
        if (m === 'POST' && a === 'session' && !b) {
            const token = str(await readBody(req, 1024), 'token', 200);
            const r = live(db.prepare(`${ME} WHERE m.token_hash = ? AND m.disabled = 0`).get(hash(token)));
            if (!r)
                throw failed(req, new HttpError(401, 'unauthorized', 'a valid token is needed'));
            return [200, member(r), { 'set-cookie': startSession(r) }];
        }
        if (m === 'POST' && a === 'join' && !b) {
            const body = await readBody(req, 4096);
            const name = str(body, 'name', 32);
            if (!NAME_RE.test(name))
                throw new HttpError(400, 'bad_request', 'a name is lower-case letters, digits, - and _, up to 32 characters');
            const inv = db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?').get(hash(str(body, 'code', 200)), now());
            if (!inv)
                throw failed(req, new HttpError(401, 'invalid_invite', 'the invite is wrong, used or expired'));
            if (db.prepare('SELECT 1 FROM members WHERE name = ?').get(name))
                throw new HttpError(409, 'name_taken', `${name} is taken; choose another name`);
            const token = newToken();
            const id = randomBytes(16).toString('hex');
            db.prepare('INSERT INTO members (id, team_id, name, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, inv.team_id, name, hash(token), inv.role, now() + 365 * DAY, now());
            db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(id, now(), inv.code_hash);
            audit({ id, team_id: inv.team_id }, 'member.join', `member:${id}`, { role: inv.role, invited_by: inv.created_by });
            // From a browser the joiner is signed in at once; the token is returned either way, to be kept for the plugin.
            const browser = body.session === true || String(req.headers.accept).includes('text/html');
            return [200, { id, name, role: inv.role, token }, browser ? { 'set-cookie': startSession({ id, team_id: inv.team_id }) } : {}];
        }
        const me = who(req);
        // Only a credential that did not match counts as a failed sign-in; a signed-out page load does not.
        if (!me)
            throw req.headers.authorization || cookie(req, 'tw_session') ? failed(req, new HttpError(401, 'unauthorized', 'a valid token is needed')) : new HttpError(401, 'unauthorized', 'a valid token is needed');
        const write = m !== 'GET';
        if (me.via === 'session' && write && !(cookie(req, 'tw_csrf') && same(cookie(req, 'tw_csrf'), String(req.headers['x-thenwise-csrf'] ?? '')) && same(csrfOf(me.sid), String(req.headers['x-thenwise-csrf']))))
            throw new HttpError(403, 'csrf', 'a write from a browser session needs the X-Thenwise-CSRF header');
        spend(me, write);
        if (!me.last_seen || now() - me.last_seen > 3600000)
            db.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(now(), me.id);
        const need = (action) => {
            if (can(me, action))
                return;
            audit(me, 'denied', `${m} ${u.pathname}`, { needs: NEED[action] });
            throw new HttpError(403, 'forbidden', `this needs the ${NEED[action]} role`);
        };
        const limit = (dflt = 20) => clampInt(u.searchParams.get('limit'), dflt, 1, 200, 'limit');
        const offset = () => clampInt(u.searchParams.get('offset'), 0, 0, 1e9, 'offset');
        const since = () => clampInt(u.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'since');
        const memberById = (id) => {
            const r = db.prepare('SELECT * FROM members WHERE id = ? AND team_id = ?').get(id ?? '', me.team_id);
            if (!r)
                throw new HttpError(404, 'not_found', 'no such member');
            return r;
        };
        if (a === 'session' && !b && m === 'DELETE') {
            if (me.sid)
                db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(me.sid));
            return [200, { ok: true }, { 'set-cookie': noCookies }];
        }
        if (m === 'GET' && a === 'me' && !b)
            return [200, { id: me.id, name: me.name, role: me.role }];
        if (m === 'GET' && a === 'search' && !b)
            return [200, { notes: search(me, u, limit(), offset()) }];
        if (m === 'GET' && a === 'tombs' && !b)
            return [200, { tombs: db.prepare('SELECT owner, id, rev FROM tombs WHERE team_id = ? AND rev > ? ORDER BY rev LIMIT ?').all(me.team_id, since(), limit()) }];
        if (a === 'members') {
            if (!(m === 'POST' && c === 'rotate' && b === me.id))
                need('admin');
            if (m === 'GET' && !b)
                return [200, { members: db.prepare('SELECT * FROM members WHERE team_id = ? ORDER BY name').all(me.team_id).map(member) }];
            const t = memberById(b);
            if (m === 'PATCH' && !c) {
                const body = await readBody(req, 4096);
                if (t.role === 'owner')
                    throw new HttpError(409, 'owner_protected', 'the owner keeps the role and the access; hand the team over with make-owner');
                const set = {};
                if (body.role !== undefined)
                    set.role = oneOf(body.role, ROLES.filter((r) => r !== 'owner'), 'role');
                if (body.expires_at !== undefined)
                    set.expires_at = body.expires_at === null ? null : intField(body.expires_at, 0, Number.MAX_SAFE_INTEGER, 'expires_at');
                if (body.disabled !== undefined) {
                    if (typeof body.disabled !== 'boolean')
                        throw new HttpError(400, 'bad_request', 'disabled must be true or false');
                    set.disabled = body.disabled ? 1 : 0;
                    if (body.disabled)
                        set.token_hash = null;
                }
                if (!Object.keys(set).length)
                    throw new HttpError(400, 'bad_request', 'nothing to change');
                db.prepare(`UPDATE members SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), t.id);
                if (set.disabled)
                    db.prepare('DELETE FROM sessions WHERE member_id = ?').run(t.id);
                audit(me, 'member.update', `member:${t.id}`, { role: set.role, expires_at: set.expires_at, disabled: body.disabled });
                return [200, member(memberById(t.id))];
            }
            if (m === 'DELETE' && !c) {
                const keep = oneOf(u.searchParams.get('notes'), ['keep', 'delete'], 'notes');
                try {
                    removeMember(db, t.name, keep === 'keep');
                }
                catch (e) {
                    throw new HttpError(409, 'owner_protected', e.message);
                }
                audit(me, 'member.remove', `member:${t.id}`, { notes: keep });
                return [200, { ok: true }];
            }
            if (m === 'POST' && c === 'rotate' && !d) {
                if (t.disabled)
                    throw new HttpError(409, 'disabled', 'the member is disabled; enable them first or invite them again');
                // Rank decides: the owner rotates anyone, an admin only roles below admin, everyone their own.
                if (t.id !== me.id && me.role !== 'owner') {
                    const owner = t.role === 'owner';
                    if (owner || ROLES.indexOf(t.role) >= ROLES.indexOf('admin')) {
                        audit(me, 'denied', `${m} ${u.pathname}`, { needs: 'owner' });
                        throw new HttpError(403, owner ? 'owner_protected' : 'forbidden', owner ? 'only the owner can rotate the owner token' : 'an admin can rotate only roles below admin');
                    }
                }
                audit(me, 'member.rotate', `member:${t.id}`);
                return [200, { token: rotate(db, t.name) }];
            }
            if (m === 'POST' && c === 'make-owner' && !d) {
                need('owner');
                if (t.disabled || t.id === me.id)
                    throw new HttpError(409, 'bad_target', 'pick another live member');
                db.exec('BEGIN');
                db.prepare("UPDATE members SET role = 'admin' WHERE id = ?").run(me.id);
                db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").run(t.id);
                db.exec('COMMIT');
                audit(me, 'member.make_owner', `member:${t.id}`);
                return [200, member(memberById(t.id))];
            }
            throw new HttpError(404, 'not_found', 'no such route');
        }
        if (a === 'settings' && !b) {
            need('admin');
            if (m === 'PATCH') {
                const body = await readBody(req, 4096);
                if (body.name !== undefined) {
                    const name = str(body, 'name', 80).trim();
                    if (!name)
                        throw new HttpError(400, 'bad_request', 'name must not be empty');
                    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, me.team_id);
                }
                if (body.review_queue !== undefined) {
                    if (typeof body.review_queue !== 'boolean')
                        throw new HttpError(400, 'bad_request', 'review_queue must be true or false');
                    db.prepare('UPDATE teams SET review_queue = ? WHERE id = ?').run(body.review_queue ? 1 : 0, me.team_id);
                }
                audit(me, 'settings.update', 'settings', { name: body.name, review_queue: body.review_queue });
            }
            else if (m !== 'GET')
                throw new HttpError(405, 'method_not_allowed', 'method not allowed');
            const s = settings();
            return [200, { name: s.name, review_queue: !!s.review_queue }];
        }
        if (a === 'invites' && !b && m === 'POST') {
            need('admin');
            const body = await readBody(req, 4096);
            const role = oneOf(body.role ?? 'member', ROLES.filter((r) => r !== 'owner'), 'role');
            const days = body.days === undefined ? 7 : intField(body.days, 1, 365, 'days');
            const code = `twi_${randomBytes(24).toString('hex')}`;
            db.prepare('INSERT INTO invites (code_hash, team_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(code), me.team_id, role, me.id, now() + days * DAY);
            audit(me, 'invite.create', `role:${role}`, { days });
            return [200, { code, role, expires_at: now() + days * DAY }];
        }
        if (a === 'audit' && !b && m === 'GET') {
            need('admin');
            const actor = u.searchParams.get('actor');
            const action = u.searchParams.get('action');
            const rows = db.prepare(`SELECT a.*, m.name AS actor_name FROM audit a LEFT JOIN members m ON m.id = a.actor WHERE a.team_id = ? AND a.at > ? ${actor ? 'AND a.actor = ?' : ''} ${action ? 'AND a.action = ?' : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(me.team_id, since(), ...(actor ? [actor] : []), ...(action ? [action] : []), limit(50), offset());
            return [200, { entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, actor_name: r.actor_name, action: r.action, target: r.target, details: JSON.parse(r.details) })) }];
        }
        if (a === 'stats' && !b && m === 'GET') {
            need('admin');
            const from = Math.floor(now() / DAY) - KEEP_READS_DAYS;
            const top = db.prepare('SELECT n.owner, n.id, n.title, sum(r.count) AS reads FROM note_reads r JOIN notes n ON n.owner_id = r.owner_id AND n.id = r.id WHERE r.team_id = ? AND r.day > ? GROUP BY r.owner_id, r.id ORDER BY reads DESC, n.owner, n.id LIMIT 20').all(me.team_id, from);
            return [200, { days: KEEP_READS_DAYS, top, members: db.prepare('SELECT id, name, last_seen FROM members WHERE team_id = ? AND disabled = 0 ORDER BY name').all(me.team_id) }];
        }
        if (a === 'export.zip' && !b && m === 'GET') {
            need('curate');
            return [200, exportZip(me), { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="thenwise-export.zip"' }];
        }
        if (a === 'chat-settings' && !b) {
            need('admin');
            if (m === 'PATCH') {
                const body = await readBody(req, 4096);
                const days = body.chat_retention_days;
                if (days !== null)
                    intField(days, 1, 3650, 'chat_retention_days');
                db.prepare('UPDATE teams SET chat_retention_days = ? WHERE id = ?').run(days, me.team_id);
                audit(me, 'settings.update', 'chat-settings', { chat_retention_days: days });
            }
            else if (m !== 'GET')
                throw new HttpError(405, 'method_not_allowed', 'method not allowed');
            return [200, { chat_retention_days: db.prepare('SELECT chat_retention_days AS d FROM teams WHERE id = ?').get(me.team_id).d }];
        }
        if (a === 'chat-tombs' && !b && m === 'GET') {
            const only = oneOf(u.searchParams.get('mine') ?? 'include', ['include', 'only'], 'mine') === 'only';
            return [200, { tombs: db.prepare(`SELECT owner, session, rev FROM chat_tombs WHERE team_id = ? AND rev > ? ${only ? 'AND owner_id = ?' : 'AND ? IS NOT NULL'} ORDER BY rev LIMIT ?`).all(me.team_id, since(), me.id, clampInt(u.searchParams.get('limit'), 100, 1, 500, 'limit')) }];
        }
        if (a === 'shared-projects') {
            if (m === 'GET' && !b)
                return [200, { projects: db.prepare('SELECT m.name AS owner, s.project, s.since, s.status, s.last_push, (SELECT count(*) FROM chats c WHERE c.owner_id = s.owner_id AND c.project = s.project) AS chats, (SELECT coalesce(sum(bytes), 0) FROM chats c WHERE c.owner_id = s.owner_id AND c.project = s.project) AS bytes FROM shared_projects s JOIN members m ON m.id = s.owner_id WHERE s.team_id = ? ORDER BY m.name, s.project').all(me.team_id) }];
            if (m === 'PATCH' && b && c && !d) {
                need(b === me.name ? 'share' : 'admin');
                const body = await readBody(req, 1024);
                const status = oneOf(body.status, ['active', 'paused'], 'status');
                const r = db.prepare('UPDATE shared_projects SET status = ? WHERE project = ? AND owner_id = (SELECT id FROM members WHERE team_id = ? AND name = ?)').run(status, c, me.team_id, b);
                if (!r.changes)
                    throw new HttpError(404, 'not_found', 'no such shared project');
                audit(me, 'project.status', `project:${c}`, { status, owner: b });
                return [200, { status }];
            }
            if (m === 'DELETE' && b && c && !d) {
                need(b === me.name ? 'share' : 'admin');
                const o = db.prepare('SELECT id, name, team_id FROM members WHERE team_id = ? AND name = ?').get(me.team_id, b);
                if (!o)
                    throw new HttpError(404, 'not_found', 'no such member');
                const r = dropProject(db, o, c);
                audit(me, o.id === me.id ? 'project.unshare' : 'chat.admin_unshare', `project:${c}`, { ...r, owner: o.name });
                return [200, r];
            }
            throw new HttpError(404, 'not_found', 'no such route');
        }
        if (a === 'chats') {
            if (m === 'GET' && !b)
                return [200, { chats: chatFeed(me, u, clampInt(u.searchParams.get('limit'), 20, 1, 50, 'limit'), since()) }];
            if (m === 'GET' && b === 'search' && !c)
                return [200, { chats: searchChats(me, u, limit()) }];
            if (m === 'GET' && b && c && !d) {
                const row = db.prepare('SELECT * FROM chats WHERE team_id = ? AND owner = ? AND session = ?').get(me.team_id, b, c);
                if (!row)
                    throw new HttpError(404, 'not_found', 'no such chat');
                // A Hub reading a chat is a read of the team's chat text: counted and audited, never with the text.
                if (me.via === 'session') {
                    db.prepare('INSERT INTO chat_reads (team_id, owner_id, session, day, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (team_id, owner_id, session, day) DO UPDATE SET count = count + 1').run(me.team_id, row.owner_id, row.session, Math.floor(now() / DAY));
                    audit(me, 'chat.read', `chat:${b}/${c}`, { bytes: row.bytes });
                }
                return [200, unitOf(row, true), { etag: `"${row.rev}"` }];
            }
            if (b && !c && (m === 'PUT' || m === 'DELETE')) {
                if (!ID_RE.test(b))
                    throw new HttpError(400, 'bad_request', 'bad chat id');
                need('share');
                if (m === 'DELETE')
                    return delChat(me, me, b, ifMatch(req.headers['if-match']), seqOf(u.searchParams.get('seq')));
                const body = await readBody(req, CHAT_LIMITS.body);
                const [code, json] = putChat(me, b, chatUnit(body), ifMatch(req.headers['if-match']), seqOf(body.seq), body.reshare === true);
                return [code, json, code === 200 ? { etag: `"${json.rev}"` } : {}];
            }
            // An admin unshares a member's chat.
            if (m === 'DELETE' && b && c && !d) {
                need(b === me.name ? 'share' : 'admin');
                const o = db.prepare('SELECT id, name, team_id FROM members WHERE team_id = ? AND name = ?').get(me.team_id, b);
                if (!o)
                    throw new HttpError(404, 'not_found', 'no such member');
                return delChat(me, o, c, ifMatch(req.headers['if-match']), seqOf(u.searchParams.get('seq')));
            }
            throw new HttpError(404, 'not_found', 'no such route');
        }
        if (a !== 'notes')
            throw new HttpError(404, 'not_found', 'no such route');
        if (m === 'GET' && !b) {
            const v = vis(me);
            const owner = u.searchParams.get('owner');
            const feed = u.searchParams.get('since') !== null;
            const where = ['n.team_id = ?', v.sql];
            const args = [me.team_id, ...v.args];
            if (owner)
                (where.push(owner === 'me' ? 'n.owner_id = ?' : 'n.owner = ?'), args.push(owner === 'me' ? me.id : owner));
            if (u.searchParams.get('project') !== null)
                (where.push('n.project = ?'), args.push(u.searchParams.get('project')));
            if (u.searchParams.get('kind'))
                (where.push('n.kind = ?'), args.push(oneOf(u.searchParams.get('kind'), KINDS, 'kind')));
            if (u.searchParams.get('status'))
                (where.push('n.status = ?'), args.push(oneOf(u.searchParams.get('status'), STATUSES, 'status')));
            // A feed (since) reads forward in revision order and never carries a pending note; a listing reads the newest first.
            if (feed)
                (where.push('n.rev > ?', "n.status != 'pending'"), args.push(since()));
            const rows = db.prepare(`SELECT n.* FROM notes n WHERE ${where.join(' AND ')} ORDER BY ${feed ? 'n.rev' : 'n.rev DESC, n.owner, n.id'} LIMIT ? OFFSET ?`).all(...args, limit(), feed ? 0 : offset());
            // full=1 carries each note's text, so a feed reader needs no request per note.
            return [200, { notes: rows.map((r) => out(r, u.searchParams.get('full') === '1')) }];
        }
        // /notes/:owner/:id and what hangs off it. The owner is a name here, the id is the note's.
        if (b && c && ((!d && (m === 'GET' || m === 'PATCH')) || (m === 'GET' && d === 'revisions') || (m === 'POST' && ['retire', 'supersede', 'pin', 'unpin', 'approve'].includes(d ?? '')))) {
            const v = vis(me);
            const n = db.prepare(`SELECT n.* FROM notes n WHERE n.team_id = ? AND n.owner = ? AND n.id = ? AND ${v.sql}`).get(me.team_id, b, c, ...v.args);
            if (!n)
                throw new HttpError(404, 'not_found', 'no such note');
            const target = `note:${b}/${c}`;
            if (m === 'GET' && !d) {
                if (me.via === 'session')
                    db.prepare('INSERT INTO note_reads (team_id, owner_id, id, day, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (team_id, owner_id, id, day) DO UPDATE SET count = count + 1').run(me.team_id, n.owner_id, n.id, Math.floor(now() / DAY));
                return [200, out(n, true), { etag: `"${n.rev}"` }];
            }
            if (m === 'GET') {
                const rows = db.prepare('SELECT r.*, coalesce(e.name, \'\') AS edited_by_name FROM note_revisions r LEFT JOIN members e ON e.id = r.edited_by WHERE r.owner_id = ? AND r.id = ? ORDER BY r.rev DESC LIMIT ? OFFSET ?').all(n.owner_id, n.id, limit(50), offset());
                return [200, { revisions: rows.map((r) => ({ rev: r.rev, title: r.title, text: r.text, kind: r.kind, status: r.status, tags: JSON.parse(r.tags), edited_by: r.edited_by, edited_by_name: r.edited_by_name, edited_at: r.edited_at })) }];
            }
            if (d === 'approve') {
                need('admin');
                if (n.status !== 'pending')
                    throw new HttpError(409, 'not_pending', 'the note is not waiting for review');
                const r = change(n, { status: 'active' }, me.id);
                audit(me, 'note.approve', target);
                return [200, out(r, true), { etag: `"${r.rev}"` }];
            }
            if (m === 'PATCH') {
                need('curate');
                const match = ifMatch(req.headers['if-match']);
                if (match === '*')
                    throw new HttpError(400, 'bad_request', 'If-Match must be the revision you read');
                if (match !== n.rev)
                    return [409, { error: { code: 'stale', message: `the team has revision ${n.rev} of ${c}` }, rev: n.rev, updated_at: n.updated_at }];
                const body = await readBody(req, MAX_BODY);
                const set = {};
                for (const [k, max] of [['title', 500], ['text', MAX_TEXT], ['project', 200]])
                    if (body[k] !== undefined)
                        set[k] = str(body, k, max);
                for (const k of ['title', 'text'])
                    if (typeof set[k] === 'string')
                        set[k] = maskSecrets(set[k]).text;
                const mt = meta(body);
                if (mt.kind !== undefined)
                    set.kind = mt.kind;
                if (mt.source !== undefined)
                    set.source = mt.source;
                if (mt.tags !== undefined)
                    set.tags = JSON.stringify(mt.tags);
                if (!Object.keys(set).length)
                    throw new HttpError(400, 'bad_request', 'nothing to change');
                const r = change(n, set, me.id);
                audit(me, 'note.edit', target, { fields: Object.keys(set) });
                return [200, out(r, true), { etag: `"${r.rev}"` }];
            }
            need('curate');
            let set;
            if (d === 'supersede') {
                const by = str(await readBody(req, 4096), 'by', 240);
                // `by` is a note id of the same owner, or owner/id.
                const [bo, bid] = by.includes('/') ? by.split('/', 2) : [n.owner, by];
                if (!db.prepare('SELECT 1 FROM notes WHERE team_id = ? AND owner = ? AND id = ?').get(me.team_id, bo, bid) || (bo === n.owner && bid === n.id))
                    throw new HttpError(400, 'bad_request', 'by must be another shared note');
                set = { status: 'superseded', superseded_by: by };
            }
            else
                set = d === 'retire' ? { status: 'retired' } : { pinned: d === 'pin' ? 1 : 0 };
            const r = change(n, set, me.id);
            audit(me, `note.${d}`, target, d === 'supersede' ? { by: set.superseded_by } : {});
            return [200, out(r, true), { etag: `"${r.rev}"` }];
        }
        if (!b || c || m === 'GET')
            throw new HttpError(404, 'not_found', 'no such route');
        if (!ID_RE.test(b))
            throw new HttpError(400, 'bad_request', 'bad note id');
        if (m === 'PUT') {
            need('share');
            const n = await readBody(req, MAX_BODY);
            const [code, json] = put(me, b, noteBody(n), ifMatch(req.headers['if-match']), seqOf(n.seq));
            return [code, json, code === 200 ? { etag: `"${json.rev}"` } : {}];
        }
        if (m === 'DELETE') {
            need('share');
            return del(me, b, ifMatch(req.headers['if-match']), seqOf(u.searchParams.get('seq')));
        }
        throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    const allow = opts.allowOrigins ?? [];
    const send = (res, code, body, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const server = createServer((req, res) => {
        // Security headers on every answer; a Hub on another host gets CORS only when its origin is listed.
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy', CSP);
        const origin = req.headers.origin;
        const cors = !!origin && allow.includes(origin);
        if (cors) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('access-control-allow-credentials', 'true');
            res.setHeader('access-control-expose-headers', 'etag');
            res.setHeader('vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            if (cors)
                (res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE'), res.setHeader('access-control-allow-headers', 'content-type, if-match, x-thenwise-csrf'), res.setHeader('access-control-max-age', '600'));
            return void res.writeHead(204).end();
        }
        const u = new URL(req.url ?? '/', 'http://x');
        let parts;
        try {
            parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        }
        catch {
            return send(res, 400, { error: { code: 'bad_request', message: 'bad path' } });
        }
        if (parts[0] !== 'v1') {
            const f = opts.console && (req.method === 'GET' || req.method === 'HEAD') ? serveConsole(opts.console, parts) : null;
            if (f)
                return send(res, 200, f.body, { 'content-type': f.type, 'cache-control': f.cache });
            return send(res, 404, { error: 'not found. Routes without /v1 are gone; update Thenwise.' });
        }
        sweep();
        v1(req, u, parts.slice(1))
            .then(([code, json, headers]) => send(res, code, json, headers))
            .catch((e) => {
            const h = e instanceof HttpError ? e : new HttpError(500, 'server_error', 'server error');
            const retry = e.retryAfter;
            // A dead session is cleared in the browser, so the app sees a clean sign-out.
            send(res, h.status, { error: { code: h.code, message: h.message } }, { ...(retry ? { 'retry-after': String(retry) } : {}), ...(h.status === 401 && cookie(req, 'tw_session') ? { 'set-cookie': noCookies } : {}) });
        });
    });
    server.requestTimeout = 30_000;
    return {
        // 127.0.0.1 unless the owner chooses otherwise (see the check above).
        // server.pid tells `team restore` that the database is in use.
        listen: () => new Promise((ok) => server.listen(opts.port ?? 0, host, () => (writeFileSync(join(opts.dir, 'server.pid'), String(process.pid), { mode: 0o600 }), ok({ host, port: server.address().port })))),
        close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => (db.close(), rmSync(join(opts.dir, 'server.pid'), { force: true }), ok())))),
    };
}
/** An online copy of team.db (VACUUM INTO), readable by the owner only. Safe while the server runs. */
export function backupTeam(dir, file) {
    if (existsSync(file))
        throw new Error(`${file} exists; choose a new file name`);
    const db = openTeamDb(dir);
    try {
        db.prepare('VACUUM INTO ?').run(file);
    }
    finally {
        db.close();
    }
    chmodSync(file, 0o600);
}
/** Puts a backup in place of team.db. Refused while a server runs on the folder, and for a file from a newer Thenwise. */
export function restoreTeam(dir, file) {
    const pid = existsSync(join(dir, 'server.pid')) ? Number(readFileSync(join(dir, 'server.pid'), 'utf8')) : 0;
    // A stale pid file can name this very process (a new container starts its command as pid 1).
    if (pid && pid !== process.pid && alive(pid))
        throw new Error(`a team server (pid ${pid}) runs on ${dir}; stop it first`);
    const src = new DatabaseSync(file, { readOnly: true });
    let at;
    try {
        at = Number(src.prepare('PRAGMA user_version').get().user_version);
        if (at > SCHEMA_VERSION)
            throw new Error(`${file} was written by a newer Thenwise (schema ${at}, this one knows ${SCHEMA_VERSION}). Update Thenwise.`);
        const tables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
        if (!tables.includes('teams') || !tables.includes('members'))
            throw new Error(`${file} is not a team backup (no teams and members tables); team.db was not touched`);
        const cols = src.prepare('PRAGMA table_info(members)').all().map((r) => r.name);
        const owner = src.prepare(`SELECT 1 AS x FROM members WHERE role = 'owner'${cols.includes('disabled') ? ' AND disabled = 0' : ''}`).get();
        if (!owner)
            throw new Error(`${file} has no live owner, so nobody could sign in as owner; team.db was not touched`);
    }
    finally {
        src.close();
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cur = join(dir, 'team.db');
    let kept = '';
    if (existsSync(cur)) {
        const d = new DatabaseSync(cur);
        d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // the WAL's changes go into the file that is kept
        d.close();
        kept = `${cur}.before-restore-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
        renameSync(cur, kept);
    }
    for (const f of ['team.db-wal', 'team.db-shm'])
        rmSync(join(dir, f), { force: true });
    copyFileSync(file, cur);
    chmodSync(cur, 0o600);
    openTeamDb(dir).close(); // an older backup migrates now
    return { schema: at, kept };
}
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
