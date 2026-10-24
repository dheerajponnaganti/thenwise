// Phase 4: graph expansion for the prompt map (spec 05 §6 step 3). Two candidates, compared on the benchmark:
// typed: follow typed edges up to 2 hops from the seeds, score = seed · weight · 0.5^hop, never through hubs.
// ppr: Personalized PageRank from the seeds over the same edges (the HippoRAG idea, without AI extraction).
/** Edge weights from spec 02 §4 [hypothesis]; mentions only one hop from a seed. */
export const EDGE_WEIGHT = { about: 1, depends_on: 0.8, contradicts: 0.8, part_of: 0.6, derived_from: 0.6, supersedes: 0.6, mentions: 0.2 };
const SEEDS = 5;
export async function expandTyped(store, seeds) {
    const out = new Map(seeds.map(s => [s.id, s]));
    for (const seed of seeds.slice(0, SEEDS)) {
        const near = await store.links({ ids: [seed.id], depth: 2, limit: 50 });
        for (const n of near) {
            if (n.via === 'mentions' && n.hop > 1)
                continue;
            const score = seed.score * EDGE_WEIGHT[n.via] * 0.5 ** n.hop;
            const prev = out.get(n.id);
            if (!prev || prev.score < score)
                out.set(n.id, { id: n.id, score, why: [`${n.via} link from a match`] });
        }
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
/**
 * Personalized PageRank restricted to the seeds' 2-hop neighbourhood, restart probability 0.5,
 * 20 iterations. The final score keeps the lexical score's scale: rank mass times the top seed score.
 */
export async function expandPpr(store, seeds) {
    const top = seeds.slice(0, SEEDS);
    if (top.length === 0)
        return seeds;
    const near = await store.links({ ids: top.map(s => s.id), depth: 2, limit: 200 });
    const nodes = [...new Set([...top.map(s => s.id), ...near.map(n => n.id)])];
    const edges = await store.edgesOf(nodes, ['about', 'depends_on', 'contradicts', 'part_of', 'derived_from', 'supersedes', 'mentions']);
    const inSet = new Set(nodes);
    const adj = new Map();
    const hub = new Map();
    for (const id of nodes)
        hub.set(id, await store.isHub(id));
    for (const e of edges) {
        if (!inSet.has(e.from) || !inSet.has(e.to))
            continue;
        for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
            // Rank does not flow out of a hub.
            if (hub.get(a))
                continue;
            adj.set(a, [...(adj.get(a) ?? []), { to: b, w: EDGE_WEIGHT[e.type] }]);
        }
    }
    const total = top.reduce((s, x) => s + x.score, 0);
    const restart = new Map(top.map(s => [s.id, s.score / total]));
    let rank = new Map(restart);
    for (let it = 0; it < 20; it++) {
        const next = new Map();
        for (const [id, r] of restart)
            next.set(id, 0.5 * r);
        for (const [id, mass] of rank) {
            const out = adj.get(id) ?? [];
            const wsum = out.reduce((s, x) => s + x.w, 0);
            if (wsum === 0) {
                // Dangling mass returns to the seeds.
                for (const [sid, r] of restart)
                    next.set(sid, (next.get(sid) ?? 0) + 0.5 * mass * r);
                continue;
            }
            for (const x of out)
                next.set(x.to, (next.get(x.to) ?? 0) + (0.5 * mass * x.w) / wsum);
        }
        rank = next;
    }
    const scale = top[0].score / Math.max(...rank.values());
    const out = new Map(seeds.map(s => [s.id, s]));
    for (const [id, r] of rank) {
        const score = r * scale;
        const prev = out.get(id);
        if (!prev)
            out.set(id, { id, score, why: ['near a match in the graph'] });
        else if (prev.score < score)
            out.set(id, { ...prev, score });
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export const expanders = { typed: expandTyped, ppr: expandPpr };
