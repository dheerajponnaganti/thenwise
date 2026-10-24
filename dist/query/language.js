// Rewording without a model (Phase D): corpus synonyms mined at ingest, and a vocabulary for typo matching.
// Both are plain tables in the graph, built from counts, so every expansion can be explained.
export const MIN_PMI = 3; // pointwise mutual information (log2) a pair needs
export const MIN_WORD = 3; // a word must appear in this many units
export const MIN_PAIR = 4; // and the pair in this many units together
export const MAX_SYN = 2; // synonyms added per query word
export const SYN_WEIGHT = 0.6; // share of the original word's weight a synonym earns
export const TYPO_MIN = 0.5; // trigram similarity a vocabulary word needs
const LABELLED = new Set(['note', 'section', 'commit', 'pr']);
const STOPLIKE = new Set(['with', 'from', 'this', 'that', 'into', 'have', 'when', 'what', 'will', 'were', 'also', 'than', 'then', 'them', 'more']);
export const toks = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPLIKE.has(w));
/** The words a node is named by: title, aliases and the answers it gives (the text of a commit is not used, only its subject). */
function labelWords(title, extra) {
    const keys = [...(Array.isArray(extra?.aliases) ? extra.aliases : []), ...(Array.isArray(extra?.answers) ? extra.answers : [])];
    return toks([title, ...keys.filter((k) => typeof k === 'string')].join(' '));
}
/** Trigrams as in pg_trgm: two spaces before the word, one after. */
export const trigrams = (w) => {
    const p = `  ${w} `;
    const out = new Set();
    for (let i = 0; i + 3 <= p.length; i++)
        out.add(p.slice(i, i + 3));
    return out;
};
export const similarity = (a, b) => {
    let both = 0;
    for (const t of a)
        if (b.has(t))
            both++;
    return both / (a.size + b.size - both || 1);
};
/** Mines `synonyms(word, syn, pmi, n)` from the labelled nodes and the links between them. Replaces what the table holds. */
export function fillSynonyms(db) {
    db.exec('DELETE FROM synonyms');
    const rows = db.prepare('SELECT id, kind, title, extra FROM nodes ORDER BY id').all();
    const own = new Map();
    for (const r of rows)
        if (LABELLED.has(r.kind))
            own.set(r.id, labelWords(r.title, JSON.parse(r.extra || '{}')));
    const links = new Map();
    for (const e of db.prepare("SELECT src, dst FROM edges WHERE kind <> 'part_of' ORDER BY src, dst").all()) {
        if (!own.has(e.src) || !own.has(e.dst))
            continue;
        for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]])
            links.set(a, (links.get(a) ?? new Set()).add(b));
    }
    // A unit is one labelled node together with the labels of the nodes linked to it.
    const df = new Map();
    const pairs = new Map();
    for (const [id, mine] of own) {
        const ws = [...new Set([...mine, ...[...(links.get(id) ?? [])].slice(0, 6).flatMap((o) => own.get(o))])].sort().slice(0, 40);
        for (const w of ws)
            df.set(w, (df.get(w) ?? 0) + 1);
        for (let i = 0; i < ws.length; i++)
            for (let j = i + 1; j < ws.length; j++)
                pairs.set(`${ws[i]}\0${ws[j]}`, (pairs.get(`${ws[i]}\0${ws[j]}`) ?? 0) + 1);
    }
    const N = own.size;
    const ins = db.prepare('INSERT INTO synonyms VALUES (?,?,?,?)');
    for (const [k, n] of [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const [a, b] = k.split('\0');
        const da = df.get(a);
        const dbb = df.get(b);
        if (n < MIN_PAIR || da < MIN_WORD || dbb < MIN_WORD)
            continue;
        // Two forms of one word (cache, caches) are not synonyms.
        if (a.slice(0, 5) === b.slice(0, 5))
            continue;
        const pmi = Math.log2((n * N) / (da * dbb));
        if (pmi >= MIN_PMI)
            for (const [x, y] of [[a, b], [b, a]])
                ins.run(x, y, Math.round(pmi * 1000) / 1000, n);
    }
}
/** A vocabulary word is kept when a title has it, or at least three passages do. */
export const keepWord = (inTitles, inBodies) => inTitles > 0 || inBodies >= 3;
/** Builds `synonyms(word, syn, pmi, n)` and `vocab(word, df)`. Call after the nodes, edges and passages exist.
 * `vocab_t` and `vocab_b` hold the title and passage counts behind `vocab`, so an update can change them by the difference. */
export function buildLanguage(db) {
    db.exec('CREATE TABLE synonyms(word TEXT NOT NULL, syn TEXT NOT NULL, pmi REAL NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(word, syn)); CREATE TABLE vocab(word TEXT PRIMARY KEY, df INTEGER NOT NULL); CREATE TABLE vocab_t(word TEXT PRIMARY KEY, n INTEGER NOT NULL); CREATE TABLE vocab_b(word TEXT PRIMARY KEY, n INTEGER NOT NULL);');
    fillSynonyms(db);
    // Vocabulary for typo matching: every title word, plus body words that occur in at least three passages.
    const titleWords = new Map();
    for (const r of db.prepare('SELECT title FROM nodes').all())
        for (const w of new Set(toks(r.title)))
            titleWords.set(w, (titleWords.get(w) ?? 0) + 1);
    const body = new Map();
    for (const p of db.prepare('SELECT text FROM passages').iterate())
        for (const w of new Set(toks(p.text)))
            body.set(w, (body.get(w) ?? 0) + 1);
    const vi = db.prepare('INSERT INTO vocab VALUES (?,?)');
    const ti = db.prepare('INSERT INTO vocab_t VALUES (?,?)');
    const bi = db.prepare('INSERT INTO vocab_b VALUES (?,?)');
    for (const [w, n] of titleWords)
        ti.run(w, n);
    for (const [w, n] of body)
        bi.run(w, n);
    for (const w of [...new Set([...titleWords.keys(), ...body.keys()])].sort())
        if (keepWord(titleWords.get(w) ?? 0, body.get(w) ?? 0))
            vi.run(w, Math.max(titleWords.get(w) ?? 0, body.get(w) ?? 0));
}
