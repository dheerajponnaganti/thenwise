// `thenwise ingest`: build the derived graph (graph.db) from the masked archive, git, PRs, vaults, CLAUDE.md files and
// auto-memory. The first run, `--full` and a changed config rebuild everything. Every other run only reads what changed
// since the last one (src/ingest/incremental.ts) and ends with the same store a full rebuild would give.
// Deterministic: inputs are sorted and no wall-clock time is used in the graph.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { syncTrailers } from "../capture/notes.js";
import { buildLanguage } from "../query/language.js";
import { buildPassageIndex } from "../query/passages.js";
import { globMatch } from "./config.js";
import { updateGraph } from "./incremental.js";
import { withLock } from "./lock.js";
import { LOG_FORMAT, Graph, aliasesOf, classify, commitEdges, curatedPart, docsPart, extractRefs, fileNode, memoryPart, notesPart, parseLog, prPart, resolveClaims, resolveRefs, sessionPart, sortKeys } from "./parts.js";
import { plansPart } from "./plans.js";
import { fetchPrs } from "./prs.js";
import { discoverRepos } from "./repos.js";
import { parseSession } from "./transcript.js";
export { GENERATED, datedSections } from "./parts.js";
export const STATE_VERSION = 1;
/** The layout of graph.db. A store with no entry is today's (carapace) layout, which is 1. */
export const STORE_FORMAT = 1;
/** The format a store file says it has. */
export function storeFormat(dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return Number(db.prepare("SELECT value FROM meta WHERE key = 'format'").get()?.value ?? 1);
    }
    catch {
        return STORE_FORMAT;
    }
    finally {
        db.close();
    }
}
/** Everything in the config that decides what enters the memory. A change rebuilds the store. */
export const signatureOf = (cfg) => JSON.stringify({ v: STATE_VERSION, home: cfg.home, claude: cfg.claudeDir, roots: cfg.roots, repos: cfg.repos, vaults: cfg.vaults, entry: cfg.includeEntrypoints, excl: cfg.ingestExcludeProjects, marks: cfg.ingestExcludeMarkers });
export const DERIVED = new Set(['made', 'opened', 'mentions']);
export const FILE_KINDS = ['changed', 'read', 'edited', 'ran_in', 'touches'];
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const sessionId = (name) => name.replace(/\.jsonl\.gz$/, '');
/** The archived chats, sorted, and how many sit in projects ingest leaves out (counted, never read). */
export function scanSessions(cfg) {
    const dir = join(cfg.memDir, 'archive/sessions');
    const files = [];
    let skipped = 0;
    if (!existsSync(dir))
        return { files, skipped };
    for (const key of readdirSync(dir).sort()) {
        const kd = join(dir, key);
        if (!statSync(kd).isDirectory())
            continue;
        const names = readdirSync(kd).filter((x) => x.endsWith('.jsonl.gz')).sort();
        if (cfg.ingestExcludeProjects.some((g) => globMatch(g, key))) {
            skipped += names.length;
            continue;
        }
        for (const name of names) {
            const path = join(kd, name);
            const st = statSync(path);
            files.push({ key, name, file: `${key}\x01${name}`, path, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, ino: st.ino });
        }
    }
    return { files, skipped };
}
export function gitOut(repo, args, input) {
    try {
        return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['pipe', 'pipe', 'ignore'], ...(input === undefined ? {} : { input }) });
    }
    catch {
        return null;
    }
}
/** The PR lists to link: a test file, or the cached `gh pr list` of each repo with a GitHub remote. */
export function loadPrInputs(cfg, opts, repos, warnings) {
    if (!opts.prs)
        return fetchPrs(cfg, repos, { now: opts.now, timeoutMs: opts.ghTimeoutMs }).inputs;
    const full = cfg.githubRepos[0] ?? 'unknown/unknown';
    try {
        return [{ full, list: JSON.parse(readFileSync(opts.prs, 'utf8')) }];
    }
    catch (e) {
        warnings.push(`no PRs for ${full}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        return [];
    }
}
export function ingest(cfg, opts = {}) {
    const dbPath = opts.db ?? join(cfg.memDir, 'graph.db');
    return withLock(dbPath, () => {
        const t0 = Date.now();
        let r;
        let failed = '';
        const format = existsSync(dbPath) ? storeFormat(dbPath) : STORE_FORMAT;
        if (format > STORE_FORMAT)
            throw new Error(`${dbPath} was written by a newer Thenwise (store format ${format}, this one reads ${STORE_FORMAT}). Update Thenwise.`);
        if (!opts.full && !opts.until && format === STORE_FORMAT && existsSync(dbPath)) {
            try {
                r = updateGraph(cfg, opts, dbPath);
            }
            catch (e) {
                // A store this code cannot update is rebuilt, never left half changed (the update ran in one transaction).
                const why = e instanceof Error ? e.message : String(e);
                if (!/settings changed|no such table|no such column/.test(why))
                    failed = `the update failed (${why.split('\n')[0]}), so everything was rebuilt`;
                if (process.env.THENWISE_DEBUG)
                    console.error(e);
            }
        }
        r ??= fullBuild(cfg, opts, dbPath);
        if (failed)
            r.warnings.push(failed);
        return { ...r, ms: Date.now() - t0 };
    });
}
/** What each chat file gave to each node, so an update can tell which copy of a shared turn wins and which edges a file adds. */
export function ownerRows(file, part) {
    const edges = new Map();
    for (const e of part.edges)
        edges.set(e.src, [...(edges.get(e.src) ?? []), e]);
    const claims = new Map();
    for (const c of part.claims)
        claims.set(c.node, [...(claims.get(c.node) ?? []), c]);
    return part.nodes.map((n) => ({ node: n.id, file, len: n.text.length, data: JSON.stringify({ e: (edges.get(n.id) ?? []).map((e) => [e.dst, e.kind, e.at, e.extra]), c: (claims.get(n.id) ?? []).map((c) => [c.kind, c.val, c.at, c.turnAt]) }) }));
}
function fullBuild(cfg, opts, dbPath) {
    const g = new Graph();
    const warnings = [];
    // 1. Sessions, scoped by cwd or any touched path under a configured root.
    const { files, skipped } = scanSessions(cfg);
    const counts = { in: 0, entry: 0, marker: 0, empty: 0, out: 0 };
    const sessions = [];
    const fileRows = [];
    for (const sf of files) {
        const bytes = readFileSync(sf.path);
        const s = parseSession(gunzipSync(bytes).toString('utf8'), sessionId(sf.name), cfg.home, opts.until);
        const status = classify(cfg, s);
        counts[status]++;
        fileRows.push([sf.file, sf.size, sf.mtime, sf.ctime, sf.ino, sha256(bytes), status]);
        if (status === 'in')
            sessions.push({ cwd: s.cwd, key: sf.key, file: sf.file, part: sessionPart(s, sf.key) });
    }
    // 2. Git commits (read only), from the configured repos and the repos the chats worked in.
    const repos = discoverRepos(cfg.repos, sessions.map((x) => x.cwd));
    const trailerItems = [];
    const commits = new Map(); // full sha -> commit
    for (const repo of repos) {
        const raw = gitOut(repo, ['log', '--all', ...LOG_FORMAT]);
        if (raw === null) {
            warnings.push(`git log failed in ${repo}`);
            continue;
        }
        for (const c of parseLog(raw, repo, opts.until)) {
            const sha = c.node.extra.sha;
            if (commits.has(sha))
                continue;
            commits.set(sha, { id: c.node.id, repo, title: c.node.title, ms: Date.parse(c.node.at) });
            trailerItems.push(...c.trailers);
            g.node(c.node);
            for (const e of commitEdges(c))
                g.edge(e.src, e.dst, e.kind, e.at, e.extra);
        }
    }
    // 3. Sessions into nodes and edges.
    const claimsOf = new Map();
    const owners = [];
    for (const x of sessions) {
        for (const n of x.part.nodes)
            g.node(n);
        for (const e of x.part.edges)
            g.edge(e.src, e.dst, e.kind, e.at, e.extra);
        for (const c of x.part.claims)
            claimsOf.set(c.node, [...(claimsOf.get(c.node) ?? []), c]);
        owners.push(...ownerRows(x.file, x.part));
    }
    // 4. Pull requests, then the notes, curated notes, rules and auto-memory.
    const pr = prPart(loadPrInputs(cfg, opts, repos, warnings), repos, { id: (sha) => commits.get(sha)?.id, repo: (sha) => commits.get(sha)?.repo }, opts.until);
    trailerItems.push(...pr.trailers);
    const layers = [pr, notesPart(cfg, opts.until)];
    // Owner-written trailers become active notes first; inbox, rejected and expired notes stay out.
    if (!opts.until)
        syncTrailers(cfg.memDir, trailerItems);
    layers.push(curatedPart(cfg, opts.until), docsPart(cfg), memoryPart(cfg, sessions.map((x) => x.key), opts.memoryFrom), plansPart(cfg, opts.until));
    for (const l of layers) {
        for (const n of l.nodes)
            g.node(n);
        for (const e of l.edges)
            g.edge(e.src, e.dst, e.kind, e.at, e.extra);
    }
    // 5. File nodes (one per file an edge points at), their repo-relative aliases, and the links the texts state.
    const kinds = new Map();
    for (const e of g.edges.values())
        if (e.dst.startsWith('file:') && FILE_KINDS.includes(e.kind))
            kinds.set(e.dst, (kinds.get(e.dst) ?? new Set()).add(e.kind));
    const aliasRoots = [...new Set([...cfg.roots, ...repos])];
    const aliasIndex = new Map();
    const aliasRows = [];
    for (const [id, ks] of kinds) {
        const n = fileNode(id, ks, aliasRoots);
        g.nodes.set(id, n);
        for (const a of aliasesOf(n))
            (aliasIndex.set(a, [...(aliasIndex.get(a) ?? []), id]), aliasRows.push([a, id]));
    }
    const buckets = new Map();
    const bySubject = new Map();
    for (const [sha, c] of commits) {
        buckets.set(sha.slice(0, 7), [...(buckets.get(sha.slice(0, 7)) ?? []), sha]);
        bySubject.set(c.title, [...(bySubject.get(c.title) ?? []), { id: c.id, ms: c.ms }]);
    }
    const look = {
        pr: (n) => (pr.ambiguous.has(n) ? undefined : pr.numbers.get(n)),
        sha: (p) => {
            const hits = (buckets.get(p.slice(0, 7)) ?? []).filter((s) => s.startsWith(p));
            return hits.length === 1 ? commits.get(hits[0]).id : undefined;
        },
        file: (id) => g.nodes.has(id),
        alias: (a) => aliasIndex.get(a) ?? [],
        edge: (s, d, k) => g.edges.has(`${s}\0${d}\0${k}`),
        bySubject: (s) => bySubject.get(s) ?? [],
        prUrl: (u) => pr.urls.get(u),
    };
    const claimRows = [];
    for (const [node, cl] of claimsOf) {
        for (const e of resolveClaims(cl, look))
            g.edge(e.src, e.dst, e.kind, e.at, e.extra);
        for (const k of new Set(cl.map((c) => `${c.kind}\0${c.kind === 'sha' ? c.val.slice(0, 7) : c.val}`)))
            claimRows.push([node, ...k.split('\0')]);
    }
    const refRows = [];
    for (const n of [...g.nodes.values()]) {
        const refs = extractRefs(n.kind, n.title, n.text, cfg.home);
        refs.forEach((r, i) => refRows.push([n.id, i, r.type, r.val, r.match]));
        for (const e of resolveRefs(n.id, n.at, refs, look))
            g.edge(e.src, e.dst, e.kind, e.at, e.extra);
    }
    // 6. Edges whose target does not exist yet wait in pending_edges, then the database is written.
    const pending = [];
    for (const [k, e] of g.edges)
        if (!g.nodes.has(e.src) || !g.nodes.has(e.dst))
            (g.edges.delete(k), DERIVED.has(e.kind) || pending.push(e));
    const excludedEval = skipped + counts.marker;
    const meta = { sessions_in_scope: counts.in, sessions_out_of_scope: counts.out, excluded_eval_projects: excludedEval, excluded_entrypoint: counts.entry, after_cutoff: counts.empty, format: STORE_FORMAT };
    const state = opts.until ? null : { signature: signatureOf(cfg), repos, files: fileRows, owners, refs: refRows, claims: claimRows, commits: [...commits].map(([sha, c]) => [sha, c.id, c.repo, c.title, c.ms]), aliases: aliasRows, pending };
    writeDb(dbPath, g, meta, state);
    return { db: dbPath, sessionsIn: counts.in, sessionsOut: counts.out, excludedEval, excludedEntrypoint: counts.entry, afterCutoff: counts.empty, warnings, mode: 'full', filesRead: files.length, ms: 0 };
}
export const SCHEMA = `CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));
CREATE INDEX edges_dst ON edges(dst, kind);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE nodes_fts USING fts5(title, text, content='nodes', content_rowid='rowid');`;
const STATE_SCHEMA = `CREATE TABLE ingest_state(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE ingest_files(file TEXT PRIMARY KEY, size INTEGER, mtime REAL, ctime REAL, ino REAL, sha TEXT, status TEXT);
CREATE TABLE owners(node TEXT NOT NULL, file TEXT NOT NULL, len INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(node, file));
CREATE INDEX owners_file ON owners(file);
CREATE TABLE refs(node TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, val TEXT NOT NULL, match TEXT NOT NULL, PRIMARY KEY(node, seq));
CREATE INDEX refs_val ON refs(type, val);
CREATE TABLE claims(node TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(node, kind, key));
CREATE INDEX claims_key ON claims(kind, key);
CREATE TABLE commit_idx(sha TEXT PRIMARY KEY, id TEXT NOT NULL, repo TEXT NOT NULL, title TEXT NOT NULL, ms REAL NOT NULL);
CREATE INDEX commit_title ON commit_idx(title);
CREATE TABLE file_alias(alias TEXT NOT NULL, file TEXT NOT NULL, PRIMARY KEY(alias, file));
CREATE TABLE pending_edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));
CREATE INDEX pending_dst ON pending_edges(dst);`;
function writeDb(path, g, meta, state) {
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    db.exec(SCHEMA);
    db.exec('BEGIN');
    const ni = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)');
    for (const n of [...g.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
        ni.run(n.id, n.kind, n.title, n.text, n.at, n.until, n.project, n.source, JSON.stringify(sortKeys(n.extra)));
    const ei = db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)');
    for (const e of [...g.edges.values()].sort((a, b) => (a.src + a.dst + a.kind < b.src + b.dst + b.kind ? -1 : 1)))
        ei.run(e.src, e.dst, e.kind, e.at, JSON.stringify(sortKeys(e.extra)));
    for (const [k, v] of Object.entries(meta))
        db.prepare('INSERT INTO meta VALUES (?,?)').run(k, String(v));
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
    buildPassageIndex(db);
    buildLanguage(db);
    if (state) {
        db.exec(STATE_SCHEMA);
        const put = (sql, rows) => {
            const st = db.prepare(sql);
            for (const r of rows)
                st.run(...r);
        };
        put('INSERT INTO ingest_state VALUES (?,?)', [['signature', state.signature], ['repos', JSON.stringify(state.repos)]]);
        put('INSERT INTO ingest_files VALUES (?,?,?,?,?,?,?)', state.files);
        put('INSERT INTO owners VALUES (?,?,?,?)', state.owners.map((o) => [o.node, o.file, o.len, o.data]));
        put('INSERT INTO refs VALUES (?,?,?,?,?)', state.refs);
        put('INSERT OR IGNORE INTO claims VALUES (?,?,?)', state.claims);
        put('INSERT INTO commit_idx VALUES (?,?,?,?,?)', state.commits);
        put('INSERT INTO file_alias VALUES (?,?)', state.aliases);
        put('INSERT INTO pending_edges VALUES (?,?,?,?,?)', state.pending.map((e) => [e.src, e.dst, e.kind, e.at, JSON.stringify(sortKeys(e.extra))]));
    }
    db.exec('COMMIT');
    db.close();
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}
/** Sorted logical dump of nodes, edges and meta (not the FTS shadow tables), as one sha256. */
export function dumpHash(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    const h = createHash('sha256');
    for (const [sql, tag] of [['SELECT * FROM nodes ORDER BY id', 'n'], ['SELECT * FROM edges ORDER BY src, dst, kind', 'e'], ['SELECT * FROM meta ORDER BY key', 'm'], ['SELECT * FROM passages ORDER BY pid', 'p'], ['SELECT * FROM synonyms ORDER BY word, syn', 's'], ['SELECT * FROM vocab ORDER BY word', 'v']])
        for (const row of db.prepare(sql).all())
            h.update(`${tag}${JSON.stringify(row)}\n`);
    db.close();
    return h.digest('hex');
}
export function report(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = (sql) => db.prepare(sql).all();
    const one = (sql) => Object.values(rows(sql)[0] ?? { n: 0 })[0];
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}% (${a} of ${b})` : 'n/a (0)');
    const out = [];
    const meta = Object.fromEntries(rows('SELECT * FROM meta').map((r) => [r.key, r.value]));
    out.push(`sessions in scope: ${meta.sessions_in_scope}, out of scope: ${meta.sessions_out_of_scope}`, `excluded: ${meta.excluded_eval_projects} as test chats (eval-ws folders or marked prompts), ${meta.excluded_entrypoint} by entrypoint (not interactive), ${meta.after_cutoff} entirely after the cutoff`, 'nodes:');
    for (const r of rows('SELECT kind, count(*) n FROM nodes GROUP BY kind ORDER BY kind'))
        out.push(`  ${r.kind}: ${r.n}`);
    out.push('edges:');
    for (const r of rows('SELECT kind, count(*) n FROM edges GROUP BY kind ORDER BY kind'))
        out.push(`  ${r.kind}: ${r.n}`);
    out.push(`sessions with a made or opened edge: ${pct(one("SELECT count(DISTINCT t.dst) FROM edges t JOIN edges l ON l.src = t.src AND l.kind IN ('made','opened') WHERE t.kind = 'part_of' AND t.dst LIKE 'ses:%'"), one("SELECT count(*) FROM nodes WHERE kind = 'session'"))}`, `PRs linked to a turn (opened, or mentioned by a turn): ${pct(one("SELECT count(DISTINCT n.id) FROM nodes n JOIN edges e ON e.dst = n.id AND e.src LIKE 'turn:%' AND e.kind IN ('opened','mentions') WHERE n.kind = 'pr'"), one("SELECT count(*) FROM nodes WHERE kind = 'pr'"))}`, `commits linked to a PR (merged_as, or a PR reference): ${pct(one("SELECT count(DISTINCT n.id) FROM nodes n WHERE n.kind = 'commit' AND (EXISTS (SELECT 1 FROM edges e WHERE e.dst = n.id AND e.src LIKE 'pr:%') OR EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id AND e.dst LIKE 'pr:%'))"), one("SELECT count(*) FROM nodes WHERE kind = 'commit'"))}`, `notes with at least one link: ${pct(one("SELECT count(DISTINCT n.id) FROM nodes n JOIN edges e ON (e.src = n.id OR e.dst = n.id) AND e.kind = 'links_to' WHERE n.kind = 'note'"), one("SELECT count(*) FROM nodes WHERE kind = 'note'"))}`);
    // Continuation chains: follow continued_from to the first session of each chain.
    const next = new Map(rows("SELECT src, dst FROM edges WHERE kind = 'continued_from'").map((r) => [r.src, r.dst]));
    const lengths = new Map();
    for (const s of next.keys()) {
        let n = 1;
        for (let c = s, seen = new Set(); next.has(c) && !seen.has(c); c = next.get(c))
            (seen.add(c), n++);
        lengths.set(s, n);
    }
    const starts = [...next.keys()].filter((s) => ![...next.values()].includes(s));
    out.push(`continuation chains: ${starts.length}, longest: ${Math.max(0, ...starts.map((s) => lengths.get(s)))} sessions, links: ${next.size}`);
    db.close();
    return out.join('\n');
}
