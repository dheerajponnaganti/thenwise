// Passage index (Phase C): every text node is cut into passages of about 600 to 900 characters and indexed in
// FTS5 with a porter stemmer. Built inside `memory ingest`, so the graph and its index rebuild together.
const MIN = 600;
const MAX = 900;
/** Cut text at paragraph, then sentence, then word boundaries into pieces of MIN..MAX characters (the last may be shorter). */
export function splitPassages(text) {
    const units = [];
    for (const para of text.trim().split(/\n\s*\n/)) {
        let p = para.trim();
        while (p.length > MAX) {
            // Prefer the last sentence end, then the last space, inside the window.
            const win = p.slice(0, MAX);
            const sent = Math.max(win.lastIndexOf('. '), win.lastIndexOf('? '), win.lastIndexOf('! '), win.lastIndexOf('.\n'));
            const cutAt = sent >= MIN / 2 ? sent + 1 : win.lastIndexOf(' ') >= MIN / 2 ? win.lastIndexOf(' ') : MAX;
            units.push(p.slice(0, cutAt).trim());
            p = p.slice(cutAt).trim();
        }
        if (p)
            units.push(p);
    }
    const out = [];
    let cur = '';
    for (const u of units) {
        // A stub (under half of MIN) joins the next unit instead of standing alone, so a passage may reach MAX + MIN / 2.
        if (cur && cur.length >= MIN / 2 && cur.length + u.length + 2 > MAX)
            (out.push(cur), (cur = u));
        else
            cur = cur ? `${cur}\n\n${u}` : u;
        if (cur.length >= MIN)
            (out.push(cur), (cur = ''));
    }
    if (cur) {
        // A short tail joins the previous passage when it fits, so no passage is a stub.
        if (out.length && cur.length < MIN / 3 && out[out.length - 1].length + cur.length + 2 <= MAX + MIN / 3)
            out[out.length - 1] += `\n\n${cur}`;
        else
            out.push(cur);
    }
    return out;
}
/** A note's front matter `answers:` and `aliases:` as lines of text (other kinds have none; a file's aliases are paths). */
export function noteKeys(kind, extra) {
    if (kind !== 'note')
        return [];
    const x = JSON.parse(extra || '{}');
    return [...(Array.isArray(x.answers) ? x.answers : []), ...(Array.isArray(x.aliases) ? x.aliases : [])].filter((a) => typeof a === 'string' && !!a);
}
/** Create passages, passages_fts and titles_fts from the nodes table. Deterministic: nodes are read in id order. */
/** The passages of a node: a teammate's turn keeps the ones its sharer sent, everything else is split here. */
export function passagesOf(text, title, extra) {
    if (extra.includes('"passages"')) {
        try {
            const p = JSON.parse(extra).passages;
            if (Array.isArray(p) && p.length)
                return [...p];
        }
        catch { /* fall through to a split */ }
    }
    return splitPassages(text || title || '');
}
export function buildPassageIndex(db) {
    db.exec(`CREATE TABLE passages(pid TEXT PRIMARY KEY, node TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX passages_node ON passages(node, n);
CREATE VIRTUAL TABLE passages_fts USING fts5(text, content='passages', content_rowid='rowid', tokenize='porter unicode61');
CREATE VIRTUAL TABLE titles_fts USING fts5(title, tokenize='porter unicode61');`);
    const ins = db.prepare('INSERT INTO passages(pid, node, n, text) VALUES (?,?,?,?)');
    for (const r of db.prepare("SELECT id, kind, title, text, extra FROM nodes WHERE kind <> 'file' ORDER BY id").all()) {
        // A node with no body (a commit with only a subject) still gets one passage: its title.
        const parts = passagesOf(r.text, r.title, r.extra);
        // Paraphrase keys (front matter `answers:` and `aliases:`) get a passage of their own, so a reworded question finds the note.
        const k = noteKeys(r.kind, r.extra);
        if (k.length)
            parts.push(k.join('\n'));
        parts.forEach((p, i) => ins.run(`${r.id}#p${i}`, r.id, i, p));
    }
    db.exec("INSERT INTO passages_fts(passages_fts) VALUES('rebuild')");
    // The title lane also indexes paraphrase keys, so they weigh as much as the title.
    const ti = db.prepare('INSERT INTO titles_fts(rowid, title) VALUES (?,?)');
    for (const r of db.prepare('SELECT rowid, kind, title, extra FROM nodes ORDER BY rowid').all())
        ti.run(r.rowid, [r.title, ...noteKeys(r.kind, r.extra)].join(' '));
}
