// The checker (spec 06 §6). Phase 0 rules; staleness and manifest size arrive with Phases 1 and 2.
import { isValidId } from "./ids.js";
export const MAX_BODY_LINES = 300;
export const NEAR_DUPLICATE = 0.8;
// shortcut: trigrams shared by more than this many titles are skipped as blocking keys; similar titles still share rarer ones. Raise if near-duplicates are missed on huge vaults.
const BLOCK_MAX = 200;
const isTyped = (n) => n.type !== 'note';
/** Character trigrams of a title, for near-duplicate detection. */
function trigrams(s) {
    const t = `  ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const out = new Set();
    for (let i = 0; i + 3 <= t.length; i++)
        out.add(t.slice(i, i + 3));
    return out;
}
export function similarity(a, b) {
    return jaccard(trigrams(a), trigrams(b));
}
function jaccard(x, y) {
    let both = 0;
    for (const g of x)
        if (y.has(g))
            both++;
    return both / Math.max(1, x.size + y.size - both);
}
export function doctor(index, unavailable = []) {
    index.refreshGraph();
    const out = [];
    const add = (severity, rule, path, message) => out.push({ severity, rule, path, message });
    const pathOf = (id) => index.byId.get(id)?.path ?? id;
    for (const p of unavailable)
        add('warning', 'unavailable', p, 'file could not be read (cloud placeholder or no permission); skipped, never overwritten');
    for (const n of index.byPath.values()) {
        for (const issue of n.issues)
            add('error', 'parse', n.path, issue);
        if (n.id === null)
            add(isTyped(n) ? 'warning' : 'info', 'missing-id', n.path, 'no id yet; `doctor --fix` adds one');
        else if (!isValidId(n.id))
            add('error', 'bad-id', n.path, `id "${n.id}" is not <prefix>_<ULID>`);
        if (isTyped(n) && n.summary === '')
            add('warning', 'missing-summary', n.path, 'typed note without a summary; pointers will be weak');
        if (n.summary.length > 200)
            add('warning', 'long-summary', n.path, `summary is ${n.summary.length} characters (at most 200)`);
        if (n.title.length > 120)
            add('warning', 'long-title', n.path, `title is ${n.title.length} characters (at most 120)`);
        if (n.type === 'finding' && !n.sources.some(s => s.at !== null))
            add('error', 'finding-undated', n.path, 'a finding needs at least one dated source');
        if (n.status === 'superseded' && n.validTo === null)
            add('warning', 'superseded-open', n.path, 'superseded but valid_to is not set');
        if (n.bodyLines > MAX_BODY_LINES)
            add('info', 'long-body', n.path, `${n.bodyLines} lines (over ${MAX_BODY_LINES})`);
    }
    for (const [id, paths] of index.duplicateIds)
        add('error', 'duplicate-id', paths.join(', '), `id ${id} is used by ${paths.length} files`);
    // Titles must be unique within a vault (one scope).
    const titles = new Map();
    for (const n of index.byId.values()) {
        const k = n.title.toLowerCase();
        titles.set(k, [...(titles.get(k) ?? []), n.path]);
    }
    for (const paths of titles.values())
        if (paths.length > 1)
            add('error', 'duplicate-title', paths.join(', '), 'two or more notes share this title; links to it are ambiguous');
    for (const id of index.supersedeCycles)
        add('error', 'supersede-cycle', pathOf(id), 'part of a supersedes loop');
    const supersededTargets = new Set(index.edges.filter(e => e.type === 'supersedes').map(e => e.to));
    for (const [id, n] of index.byId)
        if (n.status === 'superseded' && !supersededTargets.has(id))
            add('warning', 'superseded-orphan', n.path, 'status is superseded but no note supersedes it');
    for (const u of index.unresolved) {
        const where = pathOf(u.from);
        if (u.reason === 'missing')
            add('warning', 'unresolved-link', where, `${u.type} link [[${u.target}]] matches no note`);
        else
            add('warning', 'ambiguous-link', where, `${u.type} link [[${u.target}]] matches ${u.candidates.map(pathOf).join(', ')}`);
    }
    for (const [id, n] of index.byId) {
        const degree = (index.adj.out.get(id)?.length ?? 0) + (index.adj.in.get(id)?.length ?? 0);
        if (degree === 0)
            add('info', 'orphan', n.path, 'no links in or out');
    }
    // Blocking (as in entity resolution): only titles sharing an uncommon trigram are compared,
    // so this stays near linear instead of comparing every pair.
    const list = [...index.byId.values()];
    const grams = list.map(n => trigrams(n.title));
    const buckets = new Map();
    for (let i = 0; i < list.length; i++) {
        const shared = new Map();
        for (const g of grams[i]) {
            const bucket = buckets.get(g);
            if (bucket && bucket.length <= BLOCK_MAX)
                for (const j of bucket)
                    shared.set(j, (shared.get(j) ?? 0) + 1);
            if (bucket)
                bucket.push(i);
            else
                buckets.set(g, [i]);
        }
        for (const j of shared.keys()) {
            const a = list[j];
            const b = list[i];
            if (a.title.toLowerCase() === b.title.toLowerCase())
                continue;
            // Exact similarity from the precomputed sets: the bucket counts skip common trigrams, so they only pick candidates.
            const s = jaccard(grams[i], grams[j]);
            if (s >= NEAR_DUPLICATE)
                add('info', 'near-duplicate', `${a.path}, ${b.path}`, `titles ${Math.round(s * 100)}% alike`);
        }
    }
    const rank = { error: 0, warning: 1, info: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));
}
