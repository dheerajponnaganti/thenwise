// Deterministic retrieval over the graph (Phase C). No model anywhere: BM25 over passages, fused by reciprocal rank
// fusion with a title lane, a graph lane and an exact lane. Every result carries the lanes that found it.
import { existsSync, renameSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, real, repoRoot } from "../ingest/repos.js";
import { MAX_SYN, SYN_WEIGHT, similarity, trigrams, TYPO_MIN } from "./language.js";
const STOP = new Set(`a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its me more most my no nor not of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours tell show find remember mean means made make get got use used using`.split(/\s+/));
export const GOOD = 0.5; // idf-weighted query coverage a passage needs to count as a match
const K = 60; // RRF constant
const SUBAGENT = 0.5; // weight of a subagent turn in ranking: crew briefs share boilerplate and crowd out the real answers
const DUP = 0.8; // word overlap above which two passages of one session count as the same text
const TERM_CACHE = 256; // words whose passage sets a server keeps; a long-lived one would otherwise keep every word ever asked
const HUB = 30; // a file touched by more than this many nodes is a hub
export const words = (q) => q.toLowerCase().match(/[\p{L}\p{N}\p{So}]+/gu) ?? [];
export const queryTerms = (q) => [...new Set(words(q).filter((w) => !STOP.has(w)))];
const fts = (terms) => terms.map((t) => `"${t}"`).join(' OR ');
const day = (at) => at.slice(0, 10);
/** An ISO date such as 2026-10-19 means the end of that day; a full timestamp stays as given. */
// Chat logs store UTC; the owner's notes, PR dates and questions use his own clock. Dates are shown and read in his
// time zone (MEMORY_TZ, else the system's), so "as of 13 October" means the end of 13 October where he is.
export const TZ = process.env.MEMORY_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const offsetMs = (ms) => {
    const p = parts(ms);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};
const zone = (ms) => {
    const m = Math.round(offsetMs(ms) / 60000);
    return `UTC${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
};
/** A timestamp in the owner's time zone ("2026-10-13 23:40 UTC+05:30"); plain dates stay as they are. */
export const local = (at) => {
    const ms = Date.parse(at);
    if (!at || /^\d{4}-\d{2}-\d{2}$/.test(at) || Number.isNaN(ms))
        return at || 'undated';
    const p = parts(ms);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${zone(ms)}`;
};
/** The local calendar day of a timestamp. */
export const localDay = (at) => local(at).slice(0, 10);
/** The end of a local day, as a UTC instant; a full timestamp is used as given. */
export const endOf = (d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
        return d;
    const guess = Date.parse(`${d}T23:59:59.999Z`);
    return new Date(guess - offsetMs(guess)).toISOString();
};
/** A rebuilt store that could not replace the open one (Windows refuses a rename over a file another process holds)
 * waits beside it as `<store>.next`. Whoever opens the store next swaps it in; while a reader still holds it, it waits. */
export function swapPending(path) {
    if (!existsSync(`${path}.next`))
        return;
    try {
        renameSync(`${path}.next`, path);
    }
    catch { } // still held open: the next opener tries again
}
export class Graph {
    db;
    nodes = new Map();
    adj = new Map();
    deg = new Map();
    passageCount;
    // Off by default: mined pairs are often topical neighbours, not synonyms, and expansion is untested on the real
    // questions. `--expand` turns it on; typo fixes stay on, since they only replace words that appear nowhere.
    expand = false;
    /** Pseudo-relevance feedback on weak queries. */
    feedback = true;
    /** The project folder results are limited to (plus global notes); undefined searches everything. */
    scope;
    /** Roots to leave out even when the scope is everything (paused projects in the all-projects fallback). */
    hide;
    roots;
    known = [];
    keyRoots = new Map(); // a chat folder's name in ~/.claude/projects -> its project folder
    vocab;
    idfCache = new Map();
    /** Fast path for hooks: nodes and edges are read from SQLite when asked for, so a big store costs no more than a small one.
     *  Only get/has on nodes and adj, ofKind, bySource and isHub are valid then; iterating `nodes` would see only what was loaded. */
    lazy;
    constructor(path, opts = {}) {
        this.lazy = !!opts.lazy;
        swapPending(path);
        this.db = new DatabaseSync(path, { readOnly: true });
        this.db.exec('PRAGMA busy_timeout = 5000'); // an update may be committing
        if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'passages'").get())
            throw new Error(`${path} has no passage index: run \`memory ingest\` again`);
        if (this.lazy) {
            const self = this;
            const load = (r) => ({ ...r, extra: JSON.parse(r.extra || '{}') });
            const one = this.db.prepare('SELECT id, kind, title, at, until, project, source, extra FROM nodes WHERE id = ?');
            const edgesOf = this.db.prepare('SELECT src, dst, kind, at, extra FROM edges WHERE src = ? OR dst = ? ORDER BY src, dst, kind');
            this.nodes = new (class extends Map {
                get(id) {
                    if (!super.has(id)) {
                        const r = one.get(id);
                        if (r)
                            super.set(id, load(r));
                    }
                    return super.get(id);
                }
                has(id) { return this.get(id) !== undefined; }
            })();
            this.adj = new (class extends Map {
                get(id) {
                    if (!super.has(id)) {
                        const list = [];
                        // Same order as the eager build: by (src, dst, kind), a self-link listed in both directions.
                        for (const e of edgesOf.all(id, id)) {
                            const x = JSON.parse(e.extra || '{}');
                            if (e.src === id)
                                list.push({ to: e.dst, kind: e.kind, out: true, extra: x, at: e.at });
                            if (e.dst === id)
                                list.push({ to: e.src, kind: e.kind, out: false, extra: x, at: e.at });
                        }
                        super.set(id, list);
                    }
                    return super.get(id);
                }
            })();
            this.passageCount = this.db.prepare('SELECT count(*) n FROM passages').get().n;
            return;
        }
        for (const r of this.db.prepare('SELECT id, kind, title, at, until, project, source, extra FROM nodes ORDER BY id').all())
            this.nodes.set(r.id, { ...r, extra: JSON.parse(r.extra || '{}') });
        for (const e of this.db.prepare('SELECT src, dst, kind, at, extra FROM edges ORDER BY src, dst, kind').all()) {
            const x = JSON.parse(e.extra || '{}');
            for (const [a, b, out] of [[e.src, e.dst, true], [e.dst, e.src, false]]) {
                if (!this.adj.has(a))
                    this.adj.set(a, []);
                this.adj.get(a).push({ to: b, kind: e.kind, out, extra: x, at: e.at });
            }
            if (e.kind !== 'part_of')
                for (const id of [e.src, e.dst])
                    this.deg.set(id, (this.deg.get(id) ?? 0) + 1);
        }
        this.passageCount = this.db.prepare('SELECT count(*) n FROM passages').get().n;
    }
    /** Limits results to one project: the repository that holds `folder` (a worktree counts as its main repo), plus global notes.
     *  A folder outside any repository (a home folder, a scratch folder) is no project, so everything stays in scope. */
    scopeTo(folder) {
        const repo = repoRoot(folder);
        this.scope = repo ? real(repo) : undefined;
    }
    /** The project folder a node belongs to, or '' when it belongs to none (vault notes, personal rules). */
    rootOf(n) {
        if (!this.roots)
            this.buildRoots();
        const r = this.roots.get(n.id);
        if (r !== undefined)
            return r;
        const known = this.known;
        const byPath = (p) => [...known].filter((k) => p === k || p.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
        const byName = (name) => [...known].find((k) => basename(k) === name) ?? '';
        let root = '';
        if (n.kind === 'turn' || n.kind === 'summary')
            root = this.roots.get(n.source) ?? '';
        else if (n.kind === 'pr')
            root = n.extra.repo ? projectRoot(n.extra.repo) : byName(n.project);
        else if (n.kind === 'note' || n.kind === 'section' || n.kind === 'rule' || n.kind === 'doc')
            root = byPath(n.source.replace(/\\/g, '/'));
        else if (n.kind === 'memory' || n.kind === 'plan')
            root = this.keyRoots.get(n.project) ?? known.find((k) => k.replace(/[^A-Za-z0-9]/g, '-') === n.project) ?? '';
        else if (n.extra?.curated)
            root = byName(n.project) || (this.keyRoots.get(n.project) ?? '');
        this.roots.set(n.id, root);
        return root;
    }
    buildRoots() {
        this.roots = new Map();
        const cache = new Map();
        const of = (f) => (f ? (cache.get(f) ?? (cache.set(f, projectRoot(f)), cache.get(f))) : '');
        const team = [];
        for (const n of this.ofKind('session', 'commit')) {
            if (n.extra?.team) {
                team.push(n);
                continue;
            }
            // A chat run outside any repository (a home folder) is about no one project, so it counts as global.
            // A cwd that no longer exists (repo moved or deleted) keeps its own path as the project instead of turning global.
            if (n.kind === 'session') {
                const cwd = String(n.extra?.cwd ?? '');
                this.roots.set(n.id, repoRoot(cwd) ? of(cwd) : cwd && !existsSync(cwd) ? resolve(cwd) : '');
                this.keyRoots.set(n.project, this.roots.get(n.id));
            }
            else if (n.kind === 'commit')
                this.roots.set(n.id, of(n.source));
        }
        this.known = [...new Set(this.roots.values())].filter(Boolean);
        // A teammate's chat belongs to this machine's checkout of its project (by GitHub slug, else folder name), or to none.
        // Slugs come from the store's meta (written at ingest); a root it does not list falls back to the folder name, never to git.
        let slugs = {};
        try {
            slugs = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key = 'slugs'").get()?.value ?? '{}');
        }
        catch { /* older store: folder names only */ }
        for (const n of team) {
            const p = String(n.extra.project ?? n.project);
            this.roots.set(n.id, this.known.find((k) => slugs[k] === p) ?? this.known.find((k) => basename(k) === p) ?? '');
        }
    }
    inScope(n) {
        if (!n || n.kind === 'file' || (this.scope === undefined && !this.hide))
            return true;
        const r = this.rootOf(n);
        // Teammates' chats of a project this machine does not hold show only when everything is searched.
        return !(r && this.hide?.(r)) && (this.scope === undefined || r === this.scope || (r === '' && !n.extra?.team));
    }
    projectName(n) {
        const r = this.rootOf(n);
        const ses = n.kind === 'session' ? n : n.kind === 'turn' || n.kind === 'summary' ? this.nodes.get(n.source) : undefined;
        const cwd = String(ses?.extra?.cwd ?? '');
        if (!r && cwd)
            return basename(cwd);
        return r ? basename(r) : n.kind === 'session' || n.kind === 'turn' || n.kind === 'summary' || n.kind === 'commit' || n.kind === 'pr' || n.kind === 'team' ? n.project || 'global' : 'global';
    }
    isHub(id) {
        if (this.nodes.get(id)?.kind !== 'file')
            return false;
        if (!this.lazy)
            return (this.deg.get(id) ?? 0) > HUB;
        // Same count as the eager build: every non-part_of edge counts once per end.
        const q = (c) => this.db.prepare(`SELECT count(*) n FROM edges WHERE ${c} = ? AND kind != 'part_of'`).get(id).n;
        return q('src') + q('dst') > HUB;
    }
    /** Nodes of these kinds, from SQLite when lazy. */
    ofKind(...kinds) {
        if (!this.lazy)
            return [...this.nodes.values()].filter((n) => kinds.includes(n.kind));
        const rows = this.db.prepare(`SELECT id, kind, title, at, until, project, source, extra FROM nodes WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id`).all(...kinds);
        return rows.map((r) => Map.prototype.get.call(this.nodes, r.id) ?? this.nodes.set(r.id, { ...r, extra: JSON.parse(r.extra || '{}') }).get(r.id));
    }
    /** Up to `n` node ids containing `s`, in id order. */
    idsContaining(s, n) {
        if (!this.lazy)
            return [...this.nodes.keys()].filter((k) => k.includes(s)).slice(0, n);
        return this.db.prepare('SELECT id FROM nodes WHERE instr(id, ?) > 0 ORDER BY id LIMIT ?').all(s, n).map((r) => r.id);
    }
    /** Turns and summaries recorded under one session. */
    bySource(source) {
        if (!this.lazy)
            return [...this.nodes.values()].filter((n) => n.source === source && (n.kind === 'turn' || n.kind === 'summary'));
        const rows = this.db.prepare("SELECT id FROM nodes WHERE kind IN ('turn', 'summary') AND source = ? ORDER BY id").all(source);
        return rows.map((r) => this.nodes.get(r.id));
    }
    /** One-hop neighbours, never through part_of and never to a hub. */
    neighbours(id) {
        return (this.adj.get(id) ?? []).filter((e) => e.kind !== 'part_of' && !this.isHub(e.to) && this.inScope(this.nodes.get(e.to)));
    }
    passages(node) {
        return this.db.prepare('SELECT pid, n, text FROM passages WHERE node = ? ORDER BY n').all(node);
    }
    fullText(node) {
        return this.db.prepare('SELECT text FROM nodes WHERE id = ?').get(node)?.text ?? '';
    }
    /** Rowids of the passages containing one (stemmed) term, and its idf. */
    /** Weight of a highlighted span for choosing an excerpt: its rarest plain word. A span of markdown bold can hold quotes
     * or dots that are not valid inside an FTS query, so only plain words are looked up. */
    wordIdf(span) {
        const ws = words(span);
        return ws.length ? Math.max(...ws.map((t) => this.term(t).idf)) : 0;
    }
    term(t) {
        let v = this.idfCache.get(t);
        // Least recently used goes first: a hit moves to the end, and past TERM_CACHE words the oldest is dropped.
        if (v)
            (this.idfCache.delete(t), this.idfCache.set(t, v));
        if (!v) {
            const m = `"${t}"`;
            // Lazy: sorted rowids in a typed array, so a word in half the passages costs 4 bytes each, not a Set entry (and a row object) each.
            let set;
            if (this.lazy) {
                const ids = new Uint32Array(this.db.prepare('SELECT count(*) n FROM passages_fts WHERE passages_fts MATCH ?').get(m).n);
                let i = 0;
                for (const r of this.db.prepare('SELECT rowid FROM passages_fts WHERE passages_fts MATCH ? ORDER BY rowid').iterate(m))
                    ids[i++] = r.rowid;
                set = { size: ids.length, has: (r) => { let lo = 0, hi = ids.length - 1; while (lo <= hi) {
                        const mid = (lo + hi) >> 1;
                        if (ids[mid] === r)
                            return true;
                        ids[mid] < r ? (lo = mid + 1) : (hi = mid - 1);
                    } return false; } };
            }
            else
                set = new Set(this.db.prepare('SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?').all(m).map((r) => r.rowid));
            v = { set, idf: Math.log(1 + (this.passageCount - set.size + 0.5) / (set.size + 0.5)) };
            this.idfCache.set(t, v);
            if (this.idfCache.size > TERM_CACHE)
                this.idfCache.delete(this.idfCache.keys().next().value);
        }
        return v;
    }
    termSets(terms) {
        return terms.map((t) => ({ t, ...this.term(t) }));
    }
    has(table) {
        return !!this.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table);
    }
    /** Up to MAX_SYN mined synonyms of a word that occur in the corpus, strongest first. */
    synonyms(word, not) {
        if (!this.has('synonyms'))
            return [];
        const rows = this.db.prepare('SELECT syn FROM synonyms WHERE word = ? ORDER BY pmi DESC, n DESC, syn').all(word);
        return rows.map((r) => this.term(r.syn)).map((v, i) => ({ t: rows[i].syn, ...v })).filter((a) => a.set.size > 0 && !not.has(a.t)).slice(0, MAX_SYN);
    }
    /** The vocabulary word closest to a misspelt one by trigram similarity (at least TYPO_MIN), that occurs in some passage. */
    nearest(word) {
        if (word.length < 4 || !this.has('vocab'))
            return undefined;
        this.vocab ??= this.db.prepare('SELECT word, df FROM vocab ORDER BY word').all();
        const tg = trigrams(word);
        const cands = this.vocab.filter((v) => Math.abs(v.word.length - word.length) <= 3 && v.word !== word).map((v) => ({ ...v, sim: similarity(tg, trigrams(v.word)) })).filter((v) => v.sim >= TYPO_MIN);
        // Checked without the term cache: a long list of near misses would push out the words actually asked.
        const occurs = this.db.prepare('SELECT 1 FROM passages_fts WHERE passages_fts MATCH ? LIMIT 1');
        return cands.sort((a, b) => b.sim - a.sim || b.df - a.df || (a.word < b.word ? -1 : 1)).find((v) => (this.idfCache.get(v.word)?.set.size ?? (occurs.get(`"${v.word}"`) ? 1 : 0)) > 0)?.word;
    }
    /** Nodes named exactly in the query: PR numbers, shas, paths, note titles. Each comes with the reason. */
    exact(q) {
        const out = new Map();
        const add = (id, why) => out.has(id) || out.set(id, why);
        // A bare #n ("the #1 cause", "step #2") is a PR only when the query also says PR or pull, or names the PR's repo.
        const prSaid = /\b(?:PRs?|pull)\b/i.test(q);
        const qWords = q.toLowerCase().split(/[^\w.-]+/);
        const repoNamed = (id) => qWords.includes(id.slice(3).split('#')[0].split('/').pop().toLowerCase());
        for (const m of q.matchAll(/(\bPRs?\s*#?|pull request\s*#?|#)(\d{1,5})\b/gi)) {
            for (const r of this.db.prepare("SELECT id FROM nodes WHERE kind = 'pr' AND id LIKE ? ORDER BY id").all(`pr:%#${m[2]}`))
                if (m[1] !== '#' || prSaid || repoNamed(r.id))
                    add(r.id, `PR #${m[2]}`);
        }
        for (const m of q.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
            if (!/\d/.test(m[0]) || !/[a-f]/.test(m[0]))
                continue;
            for (const r of this.db.prepare("SELECT id FROM nodes WHERE kind = 'commit' AND id LIKE ? ORDER BY id").all(`commit:%:${m[0]}%`))
                add(r.id, `commit ${m[0]}`);
        }
        const cands = new Set([...q.matchAll(/[\w@.~/-]*[/.][\w@.~/-]*\w/g)].map((m) => m[0]));
        // The whole query as one path: absolute, Windows, with spaces, brackets or parentheses, or a `note:` prefix.
        const whole = q.trim().replace(/^(?:note|file|path):\s*/i, '').replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '');
        if (whole.length < 300 && whole.includes('/') && !whole.includes('\n'))
            cands.add(whole);
        for (const c of cands) {
            const p = c.replace(/^~/, '').replace(/\.+$/, '');
            if (!/[/]|\.[A-Za-z0-9]{1,6}$/.test(p) || /^\d+(\.\d+)*$/.test(p))
                continue;
            const esc = p.replace(/^\//, '').replace(/[\\%_]/g, '\\$&');
            const rows = this.db.prepare("SELECT id FROM nodes WHERE kind = 'file' AND (id LIKE ? ESCAPE '\\' OR (? NOT LIKE '%/%' AND title = ?)) ORDER BY id").all(`%/${esc}`, p, p);
            // Files under the session's project first, so a common name (README.md) does not fill the limit with other repos.
            const mine = (id) => (this.scope !== undefined && id.startsWith(`file:${this.scope}/`) ? 0 : 1);
            for (const r of rows.sort((a, b) => mine(a.id) - mine(b.id)).slice(0, 5))
                add(r.id, `path ${p}`);
        }
        const lq = q.toLowerCase();
        for (const n of this.ofKind('note')) {
            const t = n.title.toLowerCase();
            const base = n.id.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
            // Kept at 5 characters: raising it to 8 or two words (0.1.7 plan) cost a gold answer and gained none on the benchmark.
            if ((t.length >= 5 && lq.includes(t)) || (base.length >= 5 && lq.includes(base)))
                add(n.id, `note title "${n.title}"`);
        }
        return [...out].filter(([id]) => this.inScope(this.nodes.get(id))).map(([id, why]) => ({ id, why }));
    }
    /** Rows from `run(limit)` that pass `ok`, widening the limit until `want` pass, so other projects cannot fill it. */
    widen(run, ok, want) {
        for (let lim = want;; lim *= 4) {
            const rows = run(lim);
            const good = rows.filter(ok);
            if (good.length >= want || rows.length < lim || lim >= want * 64)
                return good.slice(0, want);
        }
    }
    /** Ranked passages for a query. `filter` keeps only nodes it accepts (as-of dates, kinds). When no early result covers
     * half the query, the rare words that the first three results share are searched too, at synonym weight: the answer
     * often says it in other words than the question. */
    search(q, opts = {}) {
        const first = this.run(q, opts, []);
        if (!this.feedback || first.hits.length < 3 || first.good.length > 0)
            return first;
        const asked = new Set(first.terms);
        const top = first.hits.slice(0, 3).map((h) => new Set(words(h.text).filter((w) => w.length >= 4 && !STOP.has(w) && !asked.has(w))));
        // A word counts when two of the three agree on it: three unrelated results add nothing.
        const shared = [...new Set(top.flatMap((t) => [...t]))].filter((w) => top.filter((t) => t.has(w)).length >= 2);
        const add = shared.map((w) => ({ w, idf: this.term(w).idf })).filter((x) => x.idf > 0).sort((a, b) => b.idf - a.idf || (a.w < b.w ? -1 : 1)).slice(0, 5).map((x) => x.w);
        return add.length ? this.run(q, opts, add) : first;
    }
    run(q, opts, feedback) {
        const terms = queryTerms(q);
        const sets = this.termSets(terms);
        const known = sets.filter((s) => s.set.size > 0).map((s) => ({ ...s, alt: [] }));
        let missing = sets.filter((s) => s.set.size === 0).map((s) => s.t);
        // Typos: a word found nowhere is tried against the vocabulary by trigram similarity.
        const fixed = [];
        for (const m of missing) {
            const to = this.nearest(m);
            if (!to || known.some((s) => s.t === to))
                continue;
            fixed.push({ from: m, to });
            known.push({ t: to, ...this.term(to), alt: [] });
        }
        missing = missing.filter((m) => !fixed.some((f) => f.from === m));
        // Synonyms: at most MAX_SYN per query word, counted at SYN_WEIGHT of the word's weight.
        const expanded = [];
        if (this.expand) {
            const taken = new Set(known.map((s) => s.t));
            for (const s of known) {
                s.alt = this.synonyms(s.t, taken);
                for (const a of s.alt)
                    taken.add(a.t);
                if (s.alt.length)
                    expanded.push({ from: s.t, to: s.alt.map((a) => a.t) });
            }
        }
        if (feedback.length) {
            const extra = feedback.map((t) => ({ t, ...this.term(t) })).filter((a) => a.set.size > 0);
            for (const s of known)
                s.alt = [...s.alt, ...extra.filter((a) => !s.alt.some((x) => x.t === a.t))];
        }
        const every = known.flatMap((s) => [s.t, ...s.alt.map((a) => a.t)]);
        const exact = this.exact(q);
        const ok = (n) => !!n && this.inScope(n) && (!opts.filter || opts.filter(n));
        if (!known.length && !exact.length)
            return { terms, missing, expanded, fixed, feedback, hits: [], good: [] };
        const wsum = known.reduce((a, s) => a + s.idf, 0) || 1;
        // A query word absent from the passage but present elsewhere in its turn or the neighbouring turns of its session counts at half weight.
        const near = new Map();
        const nearRows = (rowid) => {
            let v = near.get(rowid);
            if (!v) {
                const id = this.db.prepare('SELECT node FROM passages WHERE rowid = ?').get(rowid)?.node;
                const n = id ? this.nodes.get(id) : undefined;
                const ids = new Set(id ? [id] : []);
                if (n && (n.kind === 'turn' || n.kind === 'summary')) {
                    const sib = this.bySource(n.source).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
                    const i = sib.findIndex((x) => x.id === id);
                    for (const x of [sib[i - 1], sib[i + 1]])
                        if (x)
                            ids.add(x.id);
                }
                v = [...ids].flatMap((x) => this.db.prepare('SELECT rowid FROM passages WHERE node = ?').all(x).map((r) => r.rowid)).filter((r) => r !== rowid);
                near.set(rowid, v);
            }
            return v;
        };
        const covs = new Map();
        const cov = (rowid) => {
            let c = covs.get(rowid);
            if (c === undefined) {
                let direct = 0;
                let ctx = 0;
                let rows;
                for (const s of known) {
                    if (s.set.has(rowid))
                        direct += s.idf;
                    else if (s.alt.some((x) => x.set.has(rowid)))
                        direct += SYN_WEIGHT * s.idf;
                    else if (s.idf > 0 && (rows ??= nearRows(rowid)).some((r) => s.set.has(r)))
                        ctx += s.idf / 2;
                }
                c = (direct + (direct > 0 ? ctx : 0)) / wsum;
                covs.set(rowid, c);
            }
            return c;
        };
        const lanes = new Map(); // lane name -> passage ids in rank order
        const rowOf = new Map();
        const row = (pid) => {
            let r = rowOf.get(pid);
            if (r === undefined) {
                r = this.db.prepare('SELECT rowid FROM passages WHERE pid = ?').get(pid).rowid;
                rowOf.set(pid, r);
            }
            return r;
        };
        const bestOf = (node, anyPassage) => {
            const ps = this.passages(node);
            let best;
            for (const p of ps) {
                const c = cov(row(p.pid));
                if (!best || c > best.c)
                    best = { pid: p.pid, c };
            }
            return best && (best.c > 0 || anyPassage) ? best.pid : anyPassage ? ps[0]?.pid : undefined;
        };
        // Lane 1: BM25 over passages.
        const bmSql = this.db.prepare('SELECT p.pid, p.node FROM passages_fts f JOIN passages p ON p.rowid = f.rowid WHERE passages_fts MATCH ? ORDER BY bm25(passages_fts), p.pid LIMIT ?');
        const bm = known.length ? this.widen((l) => bmSql.all(fts(every), l), (r) => ok(this.nodes.get(r.node)), 400) : [];
        lanes.set('bm25', bm.map((r) => r.pid));
        // Lane 2: title matches, mapped to the node's best passage.
        const tiSql = this.db.prepare('SELECT n.id FROM titles_fts f JOIN nodes n ON n.rowid = f.rowid WHERE titles_fts MATCH ? ORDER BY bm25(titles_fts), n.id LIMIT ?');
        // Subagent briefs repeat their boilerplate in the title, so they stay out of this lane.
        const ti = known.length ? this.widen((l) => tiSql.all(fts(every), l), (r) => ok(this.nodes.get(r.id)) && !this.nodes.get(r.id).extra?.subagent, 60) : [];
        lanes.set('title', ti.flatMap((r) => bestOf(r.id, false) ?? []));
        // Lane 4: exact references. A named file has no text: its records (the commits and chats that touched it) join the
        // graph lane by how well they match, then by date. Newest-first at exact weight answered with the latest touch, not the best one.
        const exactIds = [];
        const byFile = [];
        for (const e of exact) {
            if (!ok(this.nodes.get(e.id)))
                continue;
            const own = this.passages(e.id)[0];
            if (own)
                exactIds.push(own.pid);
            else {
                const near = [...new Set(this.neighbours(e.id).map((x) => x.to))].filter((id) => ok(this.nodes.get(id))).sort((a, b) => (this.nodes.get(b).at < this.nodes.get(a).at ? -1 : 1)).slice(0, 60);
                for (const id of near) {
                    const pid = bestOf(id, true);
                    if (pid)
                        byFile.push({ pid, c: cov(row(pid)), at: this.nodes.get(id).at });
                }
            }
        }
        lanes.set('exact', exactIds);
        // Lane 3: the graph. Passages of nodes one hop from the strongest hits.
        const strong = [];
        for (const pid of lanes.get('bm25')) {
            const id = pid.replace(/#p\d+$/, '');
            if (cov(row(pid)) >= GOOD && !strong.includes(id))
                strong.push(id);
            if (strong.length >= 5)
                break;
        }
        const fileNear = byFile.sort((a, b) => b.c - a.c || (b.at < a.at ? -1 : 1)).slice(0, 15).map((x) => x.pid);
        const seen = new Set([...strong, ...fileNear.map((pid) => pid.replace(/#p\d+$/, ''))]);
        const graph = [...fileNear];
        for (const s of strong) {
            for (const e of this.neighbours(s)) {
                if (seen.has(e.to) || !ok(this.nodes.get(e.to)))
                    continue;
                seen.add(e.to);
                const pid = bestOf(e.to, false);
                if (pid)
                    graph.push(pid);
            }
        }
        lanes.set('graph', graph);
        // Reciprocal rank fusion. The exact lane counts double: the query named the thing.
        const weight = { bm25: 1, title: 1, graph: 0.7, exact: 2 };
        const score = new Map();
        const found = new Map();
        for (const [lane, pids] of lanes) {
            pids.forEach((pid, i) => {
                const sub = this.nodes.get(pid.replace(/#p\d+$/, ''))?.extra?.subagent ? SUBAGENT : 1;
                score.set(pid, (score.get(pid) ?? 0) + (weight[lane] * sub) / (K + i + 1));
                found.set(pid, [...(found.get(pid) ?? []), lane]);
            });
        }
        const order = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        const hl = known.length ? fts(every) : '';
        const get = this.db.prepare('SELECT p.n, p.text, p.rowid, ' + (hl ? "highlight(passages_fts, 0, '**', '**') AS shown" : 'p.text AS shown') + ' FROM passages p ' + (hl ? 'JOIN passages_fts ON passages_fts.rowid = p.rowid AND passages_fts MATCH ? ' : '') + 'WHERE p.pid = ?');
        const hits = [];
        const perNode = new Map();
        const seenText = new Map(); // per session: word sets of the passages already listed
        for (const [pid, sc] of order) {
            const node = this.nodes.get(pid.replace(/#p\d+$/, ''));
            if ((perNode.get(node.id) ?? 0) >= 2)
                continue;
            const r = (hl ? get.get(hl, pid) : get.get(pid));
            if (!r)
                continue; // no highlight row when the passage has no query word (exact lane): fall back below
            // Near-duplicates in one session (sibling briefs) take one slot; the exact lane is kept as asked for.
            const ws = new Set(words(r.text));
            const prior = seenText.get(node.source) ?? [];
            if (!found.get(pid).includes('exact') && prior.some((o) => [...ws].filter((w) => o.has(w)).length / Math.max(ws.size, o.size) >= DUP))
                continue;
            seenText.set(node.source, [...prior, ws]);
            perNode.set(node.id, (perNode.get(node.id) ?? 0) + 1);
            hits.push({ pid, node, n: r.n, text: r.text, shown: r.shown, score: sc, cov: cov(r.rowid), lanes: found.get(pid), project: this.projectName(node), idf: (w) => this.wordIdf(w) });
            if (hits.length >= (opts.limit ?? 200))
                break;
        }
        // Exact-lane passages without a query word are not found by the highlight join; add them plainly.
        for (const pid of lanes.get('exact')) {
            if (hits.some((h) => h.pid === pid))
                continue;
            const r = this.db.prepare('SELECT n, text, rowid FROM passages WHERE pid = ?').get(pid);
            const node = this.nodes.get(pid.replace(/#p\d+$/, ''));
            hits.push({ pid, node, n: r.n, text: r.text, shown: r.text, score: score.get(pid), cov: cov(r.rowid), lanes: found.get(pid), project: this.projectName(node), idf: (w) => this.wordIdf(w) });
        }
        hits.sort((a, b) => b.score - a.score || (a.pid < b.pid ? -1 : 1));
        // A passage is a match when it covers enough of the query, or the query named its node exactly.
        const good = hits.filter((h) => h.cov >= GOOD || h.lanes.includes('exact'));
        return { terms, missing, expanded, fixed, feedback, hits, good };
    }
}
export { day };
