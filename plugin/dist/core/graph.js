// Links, backlinks, hubs and supersede chains (spec 03 §3, 05 §3.3, 02 §4). Pure.
const key = (s) => s.trim().toLowerCase();
const stem = (path) => key((path.split('/').pop() ?? path).replace(/\.md$/i, ''));
/** Resolves every raw link: title, then alias, then file name; two matches at one step is ambiguous. */
export function resolveLinks(nodes) {
    const byTitle = new Map();
    const byAlias = new Map();
    const byStem = new Map();
    const push = (m, k, id) => {
        const list = m.get(k);
        if (list) {
            if (!list.includes(id))
                list.push(id);
        }
        else
            m.set(k, [id]);
    };
    for (const n of nodes) {
        push(byTitle, key(n.title), n.id);
        for (const a of n.aliases)
            push(byAlias, key(a), n.id);
        push(byStem, stem(n.path), n.id);
        // A link may name a path inside the vault: [[decisions/foo]].
        push(byStem, key(n.path.replace(/\.md$/i, '')), n.id);
    }
    const edges = [];
    const unresolved = [];
    const seen = new Set();
    for (const n of nodes) {
        for (const l of n.links) {
            const k = key(l.target);
            let hit;
            for (const m of [byTitle, byAlias, byStem]) {
                const found = m.get(k);
                if (found && found.length > 0) {
                    hit = found;
                    break;
                }
            }
            if (!hit)
                unresolved.push({ from: n.id, type: l.type, target: l.target, reason: 'missing', candidates: [] });
            else if (hit.length > 1)
                unresolved.push({ from: n.id, type: l.type, target: l.target, reason: 'ambiguous', candidates: hit });
            else {
                const to = hit[0];
                // Self-links and repeated identical edges carry no information.
                const sig = `${n.id}|${l.type}|${to}`;
                if (to !== n.id && !seen.has(sig)) {
                    seen.add(sig);
                    edges.push({ type: l.type, from: n.id, to });
                }
            }
        }
    }
    return { edges, unresolved };
}
export function adjacency(edges) {
    const out = new Map();
    const inn = new Map();
    for (const e of edges) {
        let o = out.get(e.from);
        if (!o)
            out.set(e.from, (o = []));
        o.push(e);
        let i = inn.get(e.to);
        if (!i)
            inn.set(e.to, (i = []));
        i.push(e);
    }
    return { out, in: inn };
}
/**
 * Hubs: listed by the user, or with a total degree at or above max(minDegree, the p-th percentile).
 * Hubs can be results, but traversal never goes through them.
 */
export function findHubs(ids, adj, opts) {
    const degree = (id) => (adj.out.get(id)?.length ?? 0) + (adj.in.get(id)?.length ?? 0);
    const sorted = ids.map(degree).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((opts.percentile / 100) * sorted.length) - 1));
    const cut = Math.max(opts.minDegree, sorted[idx] ?? 0);
    const hubs = new Set(opts.exclude);
    for (const id of ids)
        if (degree(id) >= cut)
            hubs.add(id);
    return hubs;
}
/**
 * For every node in a supersede chain, the newest node that replaces it.
 * `cycles` lists nodes caught in a supersede loop (the checker reports them; they map to themselves).
 */
export function supersedeHeads(edges) {
    // newer supersedes older: edge from = newer, to = older.
    const newerOf = new Map();
    for (const e of edges) {
        if (e.type !== 'supersedes')
            continue;
        let l = newerOf.get(e.to);
        if (!l)
            newerOf.set(e.to, (l = []));
        l.push(e.from);
    }
    const head = new Map();
    const cycles = new Set();
    const walk = (id, path) => {
        const cached = head.get(id);
        if (cached)
            return cached;
        if (path.has(id)) {
            for (const p of path)
                cycles.add(p);
            return id;
        }
        const newer = newerOf.get(id);
        if (!newer || newer.length === 0)
            return id;
        path.add(id);
        // Two nodes superseding one: the lexically last id wins (ULIDs sort by time, so the newest).
        const next = [...newer].sort().pop();
        const h = walk(next, path);
        path.delete(id);
        const result = cycles.has(id) ? id : h;
        head.set(id, result);
        return result;
    };
    for (const older of newerOf.keys())
        walk(older, new Set());
    return { head, cycles: [...cycles] };
}
/** Neighbours over typed edges, both directions, up to `depth` hops, never expanding through a hub after the first hop. */
export function walkLinks(adj, hubs, has, ids, opts) {
    const seen = new Map();
    let frontier = ids.filter(has);
    for (const id of frontier)
        seen.set(id, { id, hop: 0, via: 'mentions', from: id });
    for (let hop = 1; hop <= opts.depth && frontier.length > 0; hop++) {
        const next = [];
        for (const id of frontier) {
            if (hop > 1 && hubs.has(id))
                continue;
            for (const e of [...(adj.out.get(id) ?? []), ...(adj.in.get(id) ?? [])]) {
                if (opts.types && !opts.types.includes(e.type))
                    continue;
                const other = e.from === id ? e.to : e.from;
                if (seen.has(other))
                    continue;
                seen.set(other, { id: other, hop, via: e.type, from: id });
                next.push(other);
            }
        }
        frontier = next;
    }
    return [...seen.values()].filter(x => x.hop > 0).slice(0, opts.limit);
}
