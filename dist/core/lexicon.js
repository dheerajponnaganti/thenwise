// Weighted per-field BM25 (spec 05 §3.2). Documents can be added and removed one at a time,
// so a changed note costs one remove plus one add, not a full rebuild.
import { queryTerms, tokenize } from "./tokenize.js";
export const FIELDS = ['title', 'aliases', 'summary', 'headings', 'body'];
/** Starting weights [hypothesis, tuned on the benchmark]. */
export const FIELD_WEIGHTS = { title: 3, aliases: 3, summary: 2, headings: 1.5, body: 1 };
export const K1 = 1.2;
export const B = 0.75;
export function docTerms(fields) {
    const out = {};
    for (const f of FIELDS) {
        const text = fields[f];
        if (!text)
            continue;
        const tf = {};
        for (const t of tokenize(text))
            tf[t] = (tf[t] ?? 0) + 1;
        out[f] = tf;
    }
    return out;
}
export class Lexicon {
    postings = { title: new Map(), aliases: new Map(), summary: new Map(), headings: new Map(), body: new Map() };
    lengths = { title: new Map(), aliases: new Map(), summary: new Map(), headings: new Map(), body: new Map() };
    totals = { title: 0, aliases: 0, summary: 0, headings: 0, body: 0 };
    /** Document frequency across all fields: a term counts once per document. */
    df = new Map();
    docs = new Map();
    get size() {
        return this.docs.size;
    }
    /** True when the term occurs in at least one document. */
    knows(term) {
        return this.df.has(term);
    }
    has(id) {
        return this.docs.has(id);
    }
    add(id, terms) {
        if (this.docs.has(id))
            this.remove(id);
        this.docs.set(id, terms);
        const seen = new Set();
        for (const f of FIELDS) {
            const tf = terms[f];
            if (!tf)
                continue;
            let len = 0;
            for (const [t, n] of Object.entries(tf)) {
                len += n;
                let p = this.postings[f].get(t);
                if (!p)
                    this.postings[f].set(t, (p = new Map()));
                p.set(id, n);
                seen.add(t);
            }
            this.lengths[f].set(id, len);
            this.totals[f] += len;
        }
        for (const t of seen)
            this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    remove(id) {
        const terms = this.docs.get(id);
        if (!terms)
            return;
        const seen = new Set();
        for (const f of FIELDS) {
            const tf = terms[f];
            if (!tf)
                continue;
            for (const t of Object.keys(tf)) {
                const p = this.postings[f].get(t);
                p?.delete(id);
                if (p && p.size === 0)
                    this.postings[f].delete(t);
                seen.add(t);
            }
            this.totals[f] -= this.lengths[f].get(id) ?? 0;
            this.lengths[f].delete(id);
        }
        for (const t of seen) {
            const n = (this.df.get(t) ?? 1) - 1;
            if (n <= 0)
                this.df.delete(t);
            else
                this.df.set(t, n);
        }
        this.docs.delete(id);
    }
    /** Scores every document that shares a term with the query. `filter` drops documents before ranking. */
    search(text, limit, filter) {
        const terms = queryTerms(text);
        const n = this.docs.size;
        if (n === 0 || terms.length === 0)
            return [];
        const scores = new Map();
        for (const t of terms) {
            const df = this.df.get(t);
            if (!df)
                continue;
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            for (const f of FIELDS) {
                const p = this.postings[f].get(t);
                if (!p)
                    continue;
                const avg = this.totals[f] / Math.max(1, this.lengths[f].size);
                for (const [id, tf] of p) {
                    if (filter && !filter(id))
                        continue;
                    const len = this.lengths[f].get(id) ?? 0;
                    const s = FIELD_WEIGHTS[f] * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / Math.max(1, avg))));
                    let hit = scores.get(id);
                    if (!hit)
                        scores.set(id, (hit = { id, score: 0, matched: {} }));
                    hit.score += s;
                    (hit.matched[f] ??= []).push(t);
                }
            }
        }
        return [...scores.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
    }
}
