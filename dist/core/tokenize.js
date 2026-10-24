// The tokenizer (spec 05 §3.1). Lowercase, NFKC, paths kept whole, camelCase and snake_case split, stopwords dropped.
// English stopwords: common function words only, so content words like "sync" or "cost" are never dropped.
const STOP = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves ' +
    'also am did does get got let lets may might must shall us use used using want wants way ways we\'re what\'s im ive dont didnt doesnt isnt wasnt cant whats hows thats theres one two').split(/\s+/));
const PATH = /[a-z0-9_.@-]+(?:\/[a-z0-9_.@-]+)+\/?/g;
const WORD = /[\p{L}\p{N}]+/gu;
/** True for a token worth indexing: not a stopword, and two or more characters unless it is a number. */
const keep = (t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t));
export function tokenize(text) {
    const norm = text.normalize('NFKC');
    const lower = norm.toLowerCase();
    const out = [];
    for (const m of lower.matchAll(PATH))
        out.push(m[0].replace(/[.]+$/, ''));
    for (const m of norm.matchAll(WORD)) {
        const w = m[0];
        const lw = w.toLowerCase();
        if (keep(lw))
            out.push(lw);
        // camelCase and PascalCase parts: footerLogic gives footer, logic.
        const parts = w.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
        if (parts.length > 1)
            for (const p of parts)
                if (keep(p.toLowerCase()))
                    out.push(p.toLowerCase());
    }
    return out;
}
/** Distinct query terms, in first-seen order. */
export function queryTerms(text) {
    return [...new Set(tokenize(text))];
}
