// What a session did, kept on its turn nodes so an update and a rebuild store the same thing: each edit (file, hashes of
// the old and new text, whether a later edit of the session put it back) and each test run (when, whether it failed, the
// command masked, the file edited just before). Two indexed tables are derived from the nodes for fast lookups by the
// hooks, the way the passage index is: `changes` (by file and new text) and `tests` (by test).
import { isAbsolute, resolve } from 'node:path';
import { maskSecrets } from "../core/secrets.js";
import { normPath } from "../core/vault-index.js";
import { checkoutTop } from "./repos.js";
/** The facts of each turn of one session. An edit is undone when a later edit of another turn puts its old text back,
 * the same rule `structural` uses for an undone dead end. Sessions do not cross. */
export function sessionFacts(turns, cwd = '') {
    const out = new Map();
    const made = [];
    const events = turns.flatMap((t) => [...(t.changes ?? []).map((c) => ({ at: c.at, t, c })), ...(t.tests ?? []).map((x) => ({ at: x.at, t, x }))]).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let lastEdited;
    for (const e of events) {
        const f = out.get(e.t.id) ?? out.set(e.t.id, {}).get(e.t.id);
        if ('x' in e) {
            const cmd = maskSecrets(e.x.cmd ?? '').text;
            (f.tests ??= []).push({ at: e.x.at, failed: e.x.failed, cmd, key: testKey(cmd, cwd), ...(lastEdited ? { after: lastEdited } : {}) });
            continue;
        }
        const c = e.c;
        const file = normPath(c.file);
        // This edit puts back the old text of an earlier one: that earlier edit was tried and undone.
        if (c.newHash)
            for (const m of made)
                if (m.turn !== e.t.id && m.fact.file === file && m.fact.old === c.newHash)
                    m.fact.undone = true;
        const fact = { file, old: c.oldHash, new: c.newHash, at: c.at };
        (f.changes ??= []).push(fact);
        made.push({ turn: e.t.id, fact });
        lastEdited = file;
    }
    return out;
}
/** A test file name (or a glob of them) in a command: the one rule for keys and for matching keys. */
export const TEST_FILE = /[\w./*-]*(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|test_[\w-]+\.py|[\w-]+_test\.py)\b/g;
export const isTestFile = (w) => new RegExp(`^(?:${TEST_FILE.source})$`).test(w);
/** The test a command runs: the test files it names, else the command without its flags. A file is named from the top of
 * the checkout the command ran in (`cwd`), so `../test/a.test.ts` run from `src` and `test/a.test.ts` run from the top
 * are one test. A file outside the checkout, or with no folder to go by, stays as written. */
export function testKey(cmd, cwd = '') {
    const dir = cwd.replace(/\\/g, '/');
    const top = dir && checkoutTop(dir);
    const name = (w) => {
        if (!top)
            return w.replace(/^\.\//, '');
        const abs = normPath(isAbsolute(w) ? w : resolve(dir, w));
        return abs.startsWith(`${top}/`) ? abs.slice(top.length + 1) : w.replace(/^\.\//, '');
    };
    const files = [...cmd.matchAll(TEST_FILE)].map((m) => name(m[0]));
    return files.length ? [...new Set(files)].sort().join(' ') : cmd.split(/\s+/).filter((w) => w && !w.startsWith('-') && !/^\w+=/.test(w)).join(' ').slice(0, 200);
}
export const FACT_SCHEMA = `CREATE TABLE IF NOT EXISTS changes(node TEXT NOT NULL, file TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, at TEXT, undone INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS changes_file ON changes(file, new);
CREATE INDEX IF NOT EXISTS changes_node ON changes(node);
CREATE TABLE IF NOT EXISTS tests(node TEXT NOT NULL, key TEXT NOT NULL, at TEXT, failed INTEGER NOT NULL, cmd TEXT NOT NULL, after TEXT);
CREATE INDEX IF NOT EXISTS tests_key ON tests(key, at);
CREATE INDEX IF NOT EXISTS tests_node ON tests(node);`;
/** Writes the rows of one node's facts. Only turns carry them. */
export function putFacts(db, id, kind, extra) {
    if (kind !== 'turn' || (!extra.includes('"changes"') && !extra.includes('"tests"')))
        return;
    const x = JSON.parse(extra);
    const ci = db.prepare('INSERT INTO changes VALUES (?,?,?,?,?,?)');
    for (const c of x.changes ?? [])
        ci.run(id, c.file, c.old, c.new, c.at, c.undone ? 1 : 0);
    const ti = db.prepare('INSERT INTO tests VALUES (?,?,?,?,?,?)');
    for (const t of x.tests ?? [])
        ti.run(id, t.key ?? testKey(t.cmd), t.at, t.failed ? 1 : 0, t.cmd, t.after ?? null);
}
export function dropFacts(db, id) {
    db.prepare('DELETE FROM changes WHERE node = ?').run(id);
    db.prepare('DELETE FROM tests WHERE node = ?').run(id);
}
/** The tables from every turn node, for a full build. */
export function buildFactIndex(db) {
    db.exec(FACT_SCHEMA);
    for (const r of db.prepare("SELECT id, kind, extra FROM nodes WHERE kind = 'turn' ORDER BY id").iterate())
        putFacts(db, r.id, r.kind, r.extra);
}
