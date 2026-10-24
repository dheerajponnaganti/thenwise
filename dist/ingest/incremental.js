// The incremental update: reads only what changed since the last run and ends with the store a full rebuild would give.
// One SQLite transaction; if anything goes wrong the caller rebuilds from scratch.
//
// How equality is kept:
//  - Chat files are told apart by size, times, inode and (when those differ) a sha256 of the bytes. Each node a chat
//    gives is recorded in `owners` with the text length it gave, so when two files carry the same turn the fuller copy
//    wins (the first on a tie), exactly as in a full rebuild. Edges and commit or PR claims are the union of the owners.
//  - Commits are the set `git rev-list --all` names; only new ones are read, vanished ones are removed.
//  - PRs, notes, curated notes, rules and auto-memory are small: each run builds them whole and applies the difference.
//  - File nodes exist while an edge points at them. Links the texts state (`mentions`, `made`, `opened`) are redone for
//    the nodes that changed and for the nodes whose references now point at something else (a new commit, PR or file).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseTrailers, syncTrailers } from "../capture/notes.js";
import { fillSynonyms, keepWord, toks } from "../query/language.js";
import { noteKeys, splitPassages } from "../query/passages.js";
import { DERIVED, STORE_FORMAT, FILE_KINDS, gitOut, loadPrInputs, ownerRows, scanSessions, sessionId, sha256, signatureOf } from "./ingest.js";
import { LOG_FORMAT, MENTION_KINDS, aliasesOf, classify, commitEdges, curatedPart, docsPart, edgeKey, extractRefs, fileNode, memoryPart, notesPart, parseLog, prPart, resolveClaims, resolveRefs, sessionPart, sortKeys } from "./parts.js";
import { discoverRepos } from "./repos.js";
import { parseSession } from "./transcript.js";
const SESSION_KINDS = ['part_of', 'read', 'edited', 'ran_in', 'continued_from'];
const LABELLED = new Set(['note', 'section', 'commit', 'pr']);
const range = (p) => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
const inList = (xs) => xs.map(() => '?').join(',');
class Store {
    stmts = new Map();
    touched = new Set(); // file nodes whose edges changed
    dirtyNodes = new Set(); // nodes whose references must be read again
    dirtyTurns = new Set();
    keys = new Set(); // `type\0value` of references that may now point at something else
    claimKeys = new Set(); // `kind\0key` of commit and PR claims that may now resolve differently
    words = new Set();
    labelled = false;
    writes = 0;
    db;
    home;
    constructor(db, home) {
        this.db = db;
        this.home = home;
    }
    q(sql) {
        let s = this.stmts.get(sql);
        if (!s)
            this.stmts.set(sql, (s = this.db.prepare(sql)));
        return s;
    }
    all(sql, ...p) {
        return this.q(sql).all(...p);
    }
    get(sql, ...p) {
        return this.q(sql).get(...p);
    }
    run(sql, ...p) {
        return this.q(sql).run(...p);
    }
    exists = (id) => !!this.get('SELECT 1 FROM nodes WHERE id = ?', id);
    bump(table, text, by) {
        for (const w of new Set(toks(text))) {
            this.run(`INSERT INTO ${table}(word, n) VALUES (?, ?) ON CONFLICT(word) DO UPDATE SET n = n + excluded.n`, w, by);
            this.words.add(w);
        }
    }
    unindex(old) {
        this.run("INSERT INTO nodes_fts(nodes_fts, rowid, title, text) VALUES ('delete', ?, ?, ?)", old.rowid, old.title, old.text);
        this.run('DELETE FROM titles_fts WHERE rowid = ?', old.rowid);
        for (const p of this.all('SELECT rowid, text FROM passages WHERE node = ?', old.id)) {
            this.run("INSERT INTO passages_fts(passages_fts, rowid, text) VALUES ('delete', ?, ?)", p.rowid, p.text);
            this.bump('vocab_b', p.text, -1);
        }
        this.run('DELETE FROM passages WHERE node = ?', old.id);
        this.bump('vocab_t', old.title, -1);
    }
    index(rowid, n, extra) {
        this.run('INSERT INTO nodes_fts(rowid, title, text) VALUES (?, ?, ?)', rowid, n.title, n.text);
        this.run('INSERT INTO titles_fts(rowid, title) VALUES (?, ?)', rowid, [n.title, ...noteKeys(n.kind, extra)].join(' '));
        if (n.kind !== 'file' && n.kind !== 'doc') {
            const parts = splitPassages(n.text || n.title || '');
            const k = noteKeys(n.kind, extra);
            if (k.length)
                parts.push(k.join('\n'));
            parts.forEach((p, i) => {
                const r = this.run('INSERT INTO passages(pid, node, n, text) VALUES (?,?,?,?)', `${n.id}#p${i}`, n.id, i, p);
                this.run('INSERT INTO passages_fts(rowid, text) VALUES (?, ?)', r.lastInsertRowid, p);
                this.bump('vocab_b', p, 1);
            });
        }
        this.bump('vocab_t', n.title, 1);
    }
    /** Adds or replaces a node (and its search index). False when it is already exactly that. */
    putNode(n) {
        const extra = JSON.stringify(sortKeys(n.extra));
        const old = this.get('SELECT rowid, * FROM nodes WHERE id = ?', n.id);
        if (old && old.kind === n.kind && old.title === n.title && old.text === n.text && old.at === n.at && old.until === n.until && old.project === n.project && old.source === n.source && old.extra === extra)
            return false;
        this.writes++;
        let rowid;
        if (old) {
            this.unindex(old);
            this.run('UPDATE nodes SET kind=?, title=?, text=?, at=?, until=?, project=?, source=?, extra=? WHERE id=?', n.kind, n.title, n.text, n.at, n.until, n.project, n.source, extra, n.id);
            rowid = old.rowid;
        }
        else {
            rowid = Number(this.run('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)', n.id, n.kind, n.title, n.text, n.at, n.until, n.project, n.source, extra).lastInsertRowid);
            for (const e of this.all('SELECT * FROM pending_edges WHERE dst = ?', n.id)) {
                if (!this.exists(e.src))
                    continue;
                this.run('INSERT OR REPLACE INTO edges VALUES (?,?,?,?,?)', e.src, e.dst, e.kind, e.at, e.extra);
                this.run('DELETE FROM pending_edges WHERE src=? AND dst=? AND kind=?', e.src, e.dst, e.kind);
            }
        }
        this.index(rowid, n, extra);
        if (LABELLED.has(n.kind))
            this.labelled = true;
        if (MENTION_KINDS.has(n.kind)) {
            this.run('DELETE FROM refs WHERE node = ?', n.id);
            extractRefs(n.kind, n.title, n.text, this.home).forEach((r, i) => this.run('INSERT INTO refs VALUES (?,?,?,?,?)', n.id, i, r.type, r.val, r.match));
            this.dirtyNodes.add(n.id);
        }
        return true;
    }
    delNode(id) {
        const old = this.get('SELECT rowid, * FROM nodes WHERE id = ?', id);
        if (!old)
            return;
        this.writes++;
        this.unindex(old);
        this.run('DELETE FROM nodes WHERE id = ?', id);
        this.run('DELETE FROM refs WHERE node = ?', id);
        this.run('DELETE FROM claims WHERE node = ?', id);
        for (const e of this.all(`SELECT dst FROM edges WHERE src = ? AND kind IN (${inList(FILE_KINDS)})`, id, ...FILE_KINDS))
            this.touched.add(e.dst);
        this.run('DELETE FROM edges WHERE src = ?', id);
        this.run('DELETE FROM pending_edges WHERE src = ?', id);
        // Edges that pointed here wait for the node to come back; links the texts state are worked out again then.
        this.run(`INSERT OR REPLACE INTO pending_edges SELECT src, dst, kind, at, extra FROM edges WHERE dst = ? AND kind NOT IN (${inList([...DERIVED])})`, id, ...DERIVED);
        this.run('DELETE FROM edges WHERE dst = ?', id);
        this.dirtyNodes.delete(id);
        this.dirtyTurns.delete(id);
        if (LABELLED.has(old.kind))
            this.labelled = true;
    }
    putEdge(e) {
        const toFile = e.dst.startsWith('file:') && FILE_KINDS.includes(e.kind);
        if (toFile)
            this.touched.add(e.dst);
        const live = this.exists(e.src) && (toFile || this.exists(e.dst));
        const extra = JSON.stringify(sortKeys(e.extra));
        this.writes++;
        if (live) {
            this.run('INSERT OR REPLACE INTO edges VALUES (?,?,?,?,?)', e.src, e.dst, e.kind, e.at, extra);
            this.run('DELETE FROM pending_edges WHERE src=? AND dst=? AND kind=?', e.src, e.dst, e.kind);
        }
        else {
            this.run('INSERT OR REPLACE INTO pending_edges VALUES (?,?,?,?,?)', e.src, e.dst, e.kind, e.at, extra);
            this.run('DELETE FROM edges WHERE src=? AND dst=? AND kind=?', e.src, e.dst, e.kind);
        }
    }
    delEdge(src, dst, kind) {
        if (dst.startsWith('file:') && FILE_KINDS.includes(kind))
            this.touched.add(dst);
        this.writes++;
        this.run('DELETE FROM edges WHERE src=? AND dst=? AND kind=?', src, dst, kind);
        this.run('DELETE FROM pending_edges WHERE src=? AND dst=? AND kind=?', src, dst, kind);
    }
    /** Edges (live or waiting) from one node, of the given kinds, by key. */
    edgesFrom(src, kinds) {
        const out = new Map();
        for (const t of ['edges', 'pending_edges']) {
            for (const r of this.all(`SELECT * FROM ${t} WHERE src = ? AND kind IN (${inList(kinds)})`, src, ...kinds))
                out.set(edgeKey(r), { src: r.src, dst: r.dst, kind: r.kind, at: r.at, extra: {}, raw: r.extra });
        }
        return out;
    }
    /** Makes the edges from `src` of these kinds equal to `want`. */
    setEdges(src, kinds, want) {
        const cur = this.edgesFrom(src, kinds);
        const wanted = new Map();
        for (const e of want)
            wanted.has(edgeKey(e)) || wanted.set(edgeKey(e), e);
        for (const [k, c] of cur)
            if (!wanted.has(k))
                this.delEdge(c.src, c.dst, c.kind);
        for (const [k, e] of wanted) {
            const c = cur.get(k);
            if (!c || c.at !== e.at || c.raw !== JSON.stringify(sortKeys(e.extra)))
                this.putEdge(e);
        }
    }
    /** Makes every node whose id starts with one of the prefixes, and their edges of these kinds, equal to the layer. */
    applyLayer(prefixes, kinds, layer) {
        const have = new Map();
        for (const p of prefixes)
            for (const r of this.all('SELECT id, extra FROM nodes WHERE id >= ? AND id < ?', ...range(p)))
                have.set(r.id, r);
        const changed = [];
        const want = new Set();
        for (const n of layer.nodes) {
            want.add(n.id);
            if (this.putNode(n))
                changed.push(n);
        }
        const removed = [...have.values()].filter((r) => !want.has(r.id));
        for (const r of removed)
            this.delNode(r.id);
        const bySrc = new Map();
        for (const e of layer.edges)
            bySrc.set(e.src, [...(bySrc.get(e.src) ?? []), e]);
        const srcs = new Set(bySrc.keys());
        for (const id of want)
            srcs.add(id);
        for (const src of srcs)
            if (this.exists(src) || bySrc.has(src))
                this.setEdges(src, kinds, bySrc.get(src) ?? []);
        return { changed, removed };
    }
}
export function updateGraph(cfg, opts, dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
        const sig = db.prepare("SELECT value FROM ingest_state WHERE key = 'signature'").get();
        if (sig?.value !== signatureOf(cfg))
            throw new Error('settings changed: rebuild');
        db.exec('BEGIN IMMEDIATE');
        const r = update(db, cfg, opts, dbPath);
        db.exec('COMMIT');
        return r;
    }
    catch (e) {
        try {
            db.exec('ROLLBACK');
        }
        catch { }
        throw e;
    }
    finally {
        db.close();
    }
}
function update(db, cfg, opts, dbPath) {
    const S = new Store(db, cfg.home);
    const warnings = [];
    // 1. Chats.
    const { files, skipped } = scanSessions(cfg);
    const known = new Map(S.all('SELECT * FROM ingest_files').map((r) => [r.file, r]));
    const byFile = new Map(files.map((f) => [f.file, f]));
    const fresh = [];
    for (const sf of files) {
        const old = known.get(sf.file);
        if (old && old.size === sf.size && old.mtime === sf.mtime && old.ctime === sf.ctime && old.ino === sf.ino)
            continue;
        const bytes = readFileSync(sf.path);
        const sha = sha256(bytes);
        if (old && old.sha === sha) {
            S.run('UPDATE ingest_files SET size=?, mtime=?, ctime=?, ino=? WHERE file=?', sf.size, sf.mtime, sf.ctime, sf.ino, sf.file);
            continue;
        }
        const s = parseSession(gunzipSync(bytes).toString('utf8'), sessionId(sf.name), cfg.home);
        const status = classify(cfg, s);
        fresh.push({ sf, sha, status, ...(status === 'in' ? { part: sessionPart(s, sf.key) } : {}) });
    }
    const gone = [...known.keys()].filter((f) => !byFile.has(f));
    if (fresh.length || gone.length)
        applySessions(S, cfg, fresh, gone, byFile);
    for (const f of fresh)
        S.run('INSERT OR REPLACE INTO ingest_files VALUES (?,?,?,?,?,?,?)', f.sf.file, f.sf.size, f.sf.mtime, f.sf.ctime, f.sf.ino, f.sha, f.status);
    for (const f of gone)
        S.run('DELETE FROM ingest_files WHERE file = ?', f);
    // 2. Commits.
    const cwds = S.all("SELECT DISTINCT json_extract(extra, '$.cwd') AS cwd FROM nodes WHERE kind = 'session'").map((r) => r.cwd);
    const repos = discoverRepos(cfg.repos, cwds);
    const reposChanged = JSON.stringify(repos) !== S.get("SELECT value FROM ingest_state WHERE key = 'repos'")?.value;
    S.run("INSERT OR REPLACE INTO ingest_state VALUES ('repos', ?)", JSON.stringify(repos));
    if (reposChanged)
        for (const r of S.all("SELECT id FROM nodes WHERE kind = 'file'"))
            S.touched.add(r.id);
    applyCommits(S, repos, warnings);
    // 3. Pull requests, then notes, curated notes, rules and auto-memory.
    const commit = { id: (sha) => S.get('SELECT id FROM commit_idx WHERE sha = ?', sha)?.id, repo: (sha) => S.get('SELECT repo FROM commit_idx WHERE sha = ?', sha)?.repo };
    const pr = prPart(loadPrInputs(cfg, opts, repos, warnings), repos, commit);
    const trailers = [...pr.trailers];
    for (const r of S.all("SELECT id, at, project, text FROM nodes WHERE kind = 'commit' AND extra LIKE '%\"trailers\"%'"))
        trailers.push(...parseTrailers(r.text, r.id, r.at, r.project));
    syncTrailers(cfg.memDir, trailers);
    const prRes = S.applyLayer(['pr:'], ['merged_as', 'touches'], pr);
    for (const n of prRes.changed)
        (S.keys.add(`pr\0${n.id.split('#').pop()}`), S.claimKeys.add(`url\0${n.extra.url}`));
    for (const r of prRes.removed)
        (S.keys.add(`pr\0${r.id.split('#').pop()}`), S.claimKeys.add(`url\0${JSON.parse(r.extra).url}`));
    S.applyLayer(['note:'], ['part_of', 'links_to'], notesPart(cfg));
    S.applyLayer(['curated:'], ['derived_from', 'supersedes'], curatedPart(cfg));
    S.applyLayer(['doc:', 'rule:'], ['part_of'], docsPart(cfg));
    S.applyLayer(['mem:'], [], memoryPart(cfg, S.all("SELECT DISTINCT project FROM nodes WHERE kind = 'session'").map((r) => r.project), opts.memoryFrom));
    // 4. File nodes.
    const aliasRoots = [...new Set([...cfg.roots, ...repos])];
    for (const fid of S.touched) {
        const kinds = new Set(S.all(`SELECT DISTINCT kind FROM edges WHERE dst = ? AND kind IN (${inList(FILE_KINDS)})`, fid, ...FILE_KINDS).map((r) => r.kind));
        const old = S.get('SELECT extra FROM nodes WHERE id = ?', fid);
        const before = old ? (JSON.parse(old.extra).aliases ?? []) : [];
        let after = [];
        if (!kinds.size) {
            S.delNode(fid);
            S.run('DELETE FROM file_alias WHERE file = ?', fid);
        }
        else {
            const n = fileNode(fid, kinds, aliasRoots);
            after = aliasesOf(n);
            S.putNode(n);
            if (before.join('\0') !== after.join('\0') || !old) {
                S.run('DELETE FROM file_alias WHERE file = ?', fid);
                for (const a of after)
                    S.run('INSERT INTO file_alias VALUES (?,?)', a, fid);
            }
        }
        if (!old || !kinds.size || before.join('\0') !== after.join('\0')) {
            S.keys.add(`abs\0${fid.slice(5)}`);
            for (const a of [...before, ...after])
                S.keys.add(`rel\0${a}`);
        }
    }
    // 5. Links the texts state.
    const look = {
        pr: (n) => (pr.ambiguous.has(n) ? undefined : pr.numbers.get(n)),
        sha: (p) => {
            const hits = S.all('SELECT id FROM commit_idx WHERE sha >= ? AND sha < ?', p, `${p}g`);
            return hits.length === 1 ? hits[0].id : undefined;
        },
        file: (id) => S.exists(id),
        alias: (a) => S.all('SELECT file FROM file_alias WHERE alias = ? ORDER BY file', a).map((r) => r.file),
        edge: (s, d, k) => !!S.get('SELECT 1 FROM edges WHERE src=? AND dst=? AND kind=?', s, d, k),
        bySubject: (s) => S.all('SELECT id, ms FROM commit_idx WHERE title = ?', s),
        prUrl: (u) => pr.urls.get(u),
    };
    for (const k of S.claimKeys) {
        const [kind, key] = k.split('\0');
        for (const r of S.all('SELECT DISTINCT node FROM claims WHERE kind = ? AND key = ?', kind, key))
            S.dirtyTurns.add(r.node);
    }
    for (const id of S.dirtyTurns) {
        if (!S.exists(id))
            continue;
        const claims = [];
        for (const r of S.all('SELECT data FROM owners WHERE node = ? ORDER BY file', id))
            for (const [kind, val, at, turnAt] of JSON.parse(r.data).c)
                claims.push({ node: id, kind, val, at, turnAt });
        S.setEdges(id, ['made', 'opened'], resolveClaims(claims, look));
    }
    for (const k of S.keys) {
        const [type, val] = k.split('\0');
        for (const r of S.all('SELECT DISTINCT node FROM refs WHERE type = ? AND val = ?', type, val))
            S.dirtyNodes.add(r.node);
    }
    for (const id of S.dirtyNodes) {
        const n = S.get('SELECT at FROM nodes WHERE id = ?', id);
        if (!n)
            continue;
        const refs = S.all('SELECT type, val, match FROM refs WHERE node = ? ORDER BY seq', id);
        S.setEdges(id, ['mentions'], resolveRefs(id, n.at, refs, look));
    }
    // 6. Language tables, counts.
    if (S.labelled)
        fillSynonyms(db);
    for (const w of S.words) {
        const t = S.get('SELECT n FROM vocab_t WHERE word = ?', w)?.n ?? 0;
        const b = S.get('SELECT n FROM vocab_b WHERE word = ?', w)?.n ?? 0;
        if (t <= 0)
            S.run('DELETE FROM vocab_t WHERE word = ?', w);
        if (b <= 0)
            S.run('DELETE FROM vocab_b WHERE word = ?', w);
        if (keepWord(t, b))
            S.run('INSERT OR REPLACE INTO vocab VALUES (?,?)', w, Math.max(t, b));
        else
            S.run('DELETE FROM vocab WHERE word = ?', w);
    }
    const n = {};
    for (const r of S.all('SELECT status, count(*) c FROM ingest_files GROUP BY status'))
        n[r.status] = r.c;
    const meta = { sessions_in_scope: n.in ?? 0, sessions_out_of_scope: n.out ?? 0, excluded_eval_projects: skipped + (n.marker ?? 0), excluded_entrypoint: n.entry ?? 0, after_cutoff: n.empty ?? 0, format: STORE_FORMAT };
    for (const [k, v] of Object.entries(meta))
        S.run('INSERT OR REPLACE INTO meta VALUES (?,?)', k, String(v));
    return { db: dbPath, sessionsIn: meta.sessions_in_scope, sessionsOut: meta.sessions_out_of_scope, excludedEval: meta.excluded_eval_projects, excludedEntrypoint: meta.excluded_entrypoint, afterCutoff: meta.after_cutoff, warnings, mode: S.writes || fresh.length || gone.length ? 'update' : 'unchanged', filesRead: fresh.length, ms: 0 };
}
/** The owners of every node the changed or vanished chat files gave or give, and the nodes, edges and claims that follow. */
function applySessions(S, cfg, fresh, gone, byFile) {
    const F = [...fresh.map((f) => f.sf.file), ...gone];
    const affected = new Set();
    for (const f of F)
        for (const r of S.all('SELECT node FROM owners WHERE file = ?', f))
            affected.add(r.node);
    const parsed = new Map();
    const rows = [];
    for (const f of fresh) {
        if (!f.part)
            continue;
        parsed.set(f.sf.file, new Map(f.part.nodes.map((n) => [n.id, n])));
        for (const r of ownerRows(f.sf.file, f.part))
            (rows.push(r), affected.add(r.node));
    }
    const winner = (node) => {
        let w;
        for (const r of S.all('SELECT file, len FROM owners WHERE node = ? ORDER BY file', node))
            if (!w || r.len > w.len)
                w = r;
        return w?.file;
    };
    const was = new Map();
    for (const x of affected)
        was.set(x, winner(x));
    for (const f of F)
        S.run('DELETE FROM owners WHERE file = ?', f);
    for (const r of rows)
        S.run('INSERT INTO owners VALUES (?,?,?,?)', r.node, r.file, r.len, r.data);
    const loaded = new Map();
    const load = (file, node) => {
        let m = loaded.get(file);
        if (!m) {
            const sf = byFile.get(file);
            const s = parseSession(gunzipSync(readFileSync(sf.path)).toString('utf8'), sessionId(sf.name), cfg.home);
            m = new Map(sessionPart(s, sf.key).nodes.map((n) => [n.id, n]));
            loaded.set(file, m);
        }
        return m.get(node);
    };
    for (const x of [...affected].sort()) {
        const own = S.all('SELECT file, len, data FROM owners WHERE node = ? ORDER BY file', x);
        if (!own.length) {
            S.delNode(x);
            continue;
        }
        let win = own[0];
        for (const r of own)
            if (r.len > win.len)
                win = r;
        const node = parsed.get(win.file)?.get(x) ?? (was.get(x) === win.file ? undefined : load(win.file, x));
        if (node)
            S.putNode(node);
        const edges = [];
        const claims = [];
        for (const r of own) {
            const d = JSON.parse(r.data);
            for (const [dst, kind, at, extra] of d.e)
                edges.push({ src: x, dst, kind, at, extra });
            for (const [kind, val, at, turnAt] of d.c)
                claims.push({ node: x, kind, val, at, turnAt });
        }
        S.setEdges(x, SESSION_KINDS, edges);
        const keys = new Set(claims.map((c) => `${c.kind}\0${c.kind === 'sha' ? c.val.slice(0, 7) : c.val}`));
        const had = S.all('SELECT kind, key FROM claims WHERE node = ?', x);
        if (had.length !== keys.size || had.some((r) => !keys.has(`${r.kind}\0${r.key}`))) {
            S.run('DELETE FROM claims WHERE node = ?', x);
            for (const k of keys)
                S.run('INSERT INTO claims VALUES (?,?,?)', x, ...k.split('\0'));
        }
        if (keys.size || had.length)
            S.dirtyTurns.add(x);
    }
}
function applyCommits(S, repos, warnings) {
    const wanted = new Map(); // sha -> repo, the first repo that has it
    for (const repo of repos) {
        const raw = gitOut(repo, ['rev-list', '--all']);
        if (raw === null) {
            warnings.push(`git log failed in ${repo}`);
            continue;
        }
        for (const sha of raw.split('\n'))
            if (sha && !wanted.has(sha))
                wanted.set(sha, repo);
    }
    const have = new Map(S.all('SELECT * FROM commit_idx').map((r) => [r.sha, r]));
    const touch = (sha, title) => {
        S.keys.add(`sha\0${sha.slice(0, 7)}`);
        S.claimKeys.add(`sha\0${sha.slice(0, 7)}`);
        S.claimKeys.add(`sub\0${title}`);
    };
    for (const [sha, c] of have) {
        if (wanted.get(sha) === c.repo)
            continue;
        S.delNode(c.id);
        S.run('DELETE FROM commit_idx WHERE sha = ?', sha);
        touch(sha, c.title);
    }
    const add = new Map();
    for (const [sha, repo] of wanted)
        if (have.get(sha)?.repo !== repo)
            add.set(repo, [...(add.get(repo) ?? []), sha]);
    for (const [repo, shas] of add) {
        const raw = gitOut(repo, ['log', '--no-walk=unsorted', '--stdin', ...LOG_FORMAT], `${shas.join('\n')}\n`);
        if (raw === null) {
            warnings.push(`git log failed in ${repo}`);
            continue;
        }
        for (const c of parseLog(raw, repo)) {
            const sha = c.node.extra.sha;
            S.putNode(c.node);
            for (const e of commitEdges(c))
                S.putEdge(e);
            S.run('INSERT OR REPLACE INTO commit_idx VALUES (?,?,?,?,?)', sha, c.node.id, repo, c.node.title, Date.parse(c.node.at));
            touch(sha, c.node.title);
        }
    }
}
