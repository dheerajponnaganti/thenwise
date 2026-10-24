// The in-memory index over one vault (spec 03 §7): parsed notes, the lexicon, and the derived graph.
// The lexicon updates one note at a time; the graph (links, backlinks, hubs, supersede heads) is
// recomputed after each change because it is cheap at Files-mode scale.
import { adjacency, findHubs, resolveLinks, supersedeHeads, walkLinks } from "./graph.js";
import { docTerms, Lexicon } from "./lexicon.js";
/** Project-relative path, forward slashes, no leading ./ or trailing slash. */
export const normPath = (p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
/** A url without fragment, tracking parameters or a trailing slash. */
export function normUrl(u) {
    const s = u.trim().replace(/#.*$/, '');
    const [base, query] = s.split('?');
    const kept = (query ?? '').split('&').filter(kv => kv !== '' && !/^(utm_[a-z]+|fbclid|gclid|ref)=/i.test(kv));
    return `${base.replace(/\/+$/, '')}${kept.length ? `?${kept.join('&')}` : ''}`.toLowerCase();
}
export const DEFAULT_CONFIG = { hubs: { exclude: [], minDegree: 20, percentile: 95 } };
/** A stable id for a note that has none yet (hand notes before import). Never written to disk. */
export function provisionalId(path) {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++)
        h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
    return `tmp_${h.toString(36)}_${path.length}`;
}
export function termsOf(n) {
    return docTerms({ title: n.title, aliases: n.aliases.join(' '), summary: n.summary, headings: n.headings.join(' '), body: n.body });
}
export class VaultIndex {
    byPath = new Map();
    byId = new Map();
    lexicon = new Lexicon();
    /** Paths whose id is shared with another file: the checker reports them; only the first is indexed. */
    duplicateIds = new Map();
    edges = [];
    unresolved = [];
    adj = { out: new Map(), in: new Map() };
    hubs = new Set();
    supersedeHead = new Map();
    supersedeCycles = [];
    /** Normalised file-source path or url → node ids citing it (layer 1, spec 05 §5). */
    bySource = new Map();
    /** Entity paths, longest first: a touched file under one of them reaches that entity. */
    entityPaths = [];
    dirty = true;
    config;
    constructor(config = DEFAULT_CONFIG) {
        this.config = config;
    }
    idOf(n) {
        return n.id ?? provisionalId(n.path);
    }
    /** Adds or replaces the note at `n.path`. `terms` may come from the cache to skip tokenizing. */
    upsert(n, terms) {
        this.removePath(n.path);
        const id = this.idOf(n);
        const holder = this.byId.get(id);
        if (holder && holder.path !== n.path) {
            const list = this.duplicateIds.get(id) ?? [holder.path];
            list.push(n.path);
            this.duplicateIds.set(id, list);
            this.byPath.set(n.path, n);
            this.dirty = true;
            return;
        }
        this.byPath.set(n.path, n);
        this.byId.set(id, n);
        this.lexicon.add(id, terms ?? termsOf(n));
        this.dirty = true;
    }
    removePath(path) {
        const n = this.byPath.get(path);
        if (!n)
            return;
        this.byPath.delete(path);
        const id = this.idOf(n);
        if (this.byId.get(id)?.path === path) {
            this.byId.delete(id);
            this.lexicon.remove(id);
            // The next file with the same id takes it over; the rest register as duplicates again.
            const dups = this.duplicateIds.get(id)?.filter(p => p !== path) ?? [];
            this.duplicateIds.delete(id);
            for (const p of dups) {
                const nn = this.byPath.get(p);
                if (nn)
                    this.upsert(nn);
            }
        }
        else {
            const left = this.duplicateIds.get(id)?.filter(p => p !== path);
            if (left && left.length > 1)
                this.duplicateIds.set(id, left);
            else
                this.duplicateIds.delete(id);
        }
        this.dirty = true;
    }
    /** Recomputes links, backlinks, hubs and supersede heads if anything changed. */
    refreshGraph() {
        if (!this.dirty)
            return;
        const nodes = [...this.byId.entries()].map(([id, n]) => ({ id, path: n.path, title: n.title, aliases: n.aliases, links: n.links }));
        const { edges, unresolved } = resolveLinks(nodes);
        this.edges = edges;
        this.unresolved = unresolved;
        this.adj = adjacency(edges);
        const exclude = this.config.hubs.exclude.map(p => [...this.byId.entries()].find(([, n]) => n.path === p || n.title === p)?.[0]).filter((x) => !!x);
        this.hubs = findHubs([...this.byId.keys()], this.adj, { ...this.config.hubs, exclude });
        const s = supersedeHeads(edges);
        this.supersedeHead = s.head;
        this.supersedeCycles = s.cycles;
        this.bySource = new Map();
        this.entityPaths = [];
        for (const [id, n] of this.byId) {
            const keys = new Set();
            for (const src of n.sources)
                if (src.kind === 'file')
                    keys.add(normPath(src.ref));
                else if (src.kind === 'url')
                    keys.add(normUrl(src.ref));
            for (const u of n.urls)
                keys.add(normUrl(u));
            for (const k of keys)
                this.bySource.set(k, [...(this.bySource.get(k) ?? []), id]);
            if (n.type === 'entity')
                for (const p of n.paths)
                    this.entityPaths.push({ prefix: normPath(p), id });
        }
        this.entityPaths.sort((a, b) => b.prefix.length - a.prefix.length || a.id.localeCompare(b.id));
        this.dirty = false;
    }
    /**
     * Lexical retrieval with the status rules of spec 05 §3.4: rejected and archived dropped,
     * superseded replaced by the newest version, inbox kept only when asked for.
     */
    search(text, opts) {
        this.refreshGraph();
        const hits = this.lexicon.search(text, opts.seeds ?? Math.max(opts.limit * 3, 10), id => {
            const n = this.byId.get(id);
            if (!n)
                return false;
            if (opts.types && !opts.types.includes(n.type))
                return false;
            return n.status !== 'rejected' && n.status !== 'archived' && (opts.includeInbox || n.status !== 'inbox');
        });
        const best = new Map();
        for (const h of hits) {
            const n = this.byId.get(h.id);
            if (!n)
                continue;
            let id = h.id;
            let replaces;
            if (n.status === 'superseded') {
                const head = this.supersedeHead.get(h.id);
                const hn = head ? this.byId.get(head) : undefined;
                // A superseded node with no live replacement is withheld: it is no longer true.
                if (!head || head === h.id || !hn || hn.status === 'rejected' || hn.status === 'archived')
                    continue;
                id = head;
                replaces = n.title;
            }
            const why = Object.entries(h.matched).map(([f, terms]) => `${f}: ${[...new Set(terms)].join(', ')}`);
            const prev = best.get(id);
            if (!prev || prev.score < h.score)
                best.set(id, { id, score: h.score, why, ...(replaces ? { replaces } : {}) });
        }
        return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit);
    }
    /** Neighbours over typed edges, both directions, up to `depth` hops, never through hubs. */
    links(ids, opts) {
        this.refreshGraph();
        return walkLinks(this.adj, this.hubs, id => this.byId.has(id), ids, opts);
    }
    /** Exact-match candidates for a touched path or url (raw ids; callers apply status rules). */
    matchExact(key) {
        this.refreshGraph();
        const bySource = key.path ? (this.bySource.get(normPath(key.path)) ?? []) : key.url ? (this.bySource.get(normUrl(key.url)) ?? []) : [];
        const byEntity = [];
        if (key.path) {
            const p = normPath(key.path);
            for (const e of this.entityPaths)
                if (p === e.prefix || p.startsWith(`${e.prefix}/`))
                    byEntity.push(e.id);
        }
        return { bySource: [...bySource], byEntity };
    }
    stats() {
        this.refreshGraph();
        const byType = {};
        for (const n of this.byId.values())
            byType[n.type] = (byType[n.type] ?? 0) + 1;
        return { notes: this.byId.size, byType, edges: this.edges.length, hubs: this.hubs.size, unresolved: this.unresolved.length };
    }
}
