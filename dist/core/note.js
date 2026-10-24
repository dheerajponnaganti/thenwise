// Reads one Markdown file into a ParsedNote (spec 03 §2). Pure: no IO.
import { parseFrontMatter } from "./frontmatter.js";
import { CONFIDENCES, FRONT_MATTER_EDGES, NODE_TYPES, ORIGINS, SOURCE_KINDS, STATUSES } from "./model.js";
const WIKILINK = /!?\[\[([^\]\n]+?)\]\]/g;
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** The link target inside `[[target|label]]` or `[[target#heading]]`. */
export function linkTarget(inner) {
    return (inner.split('|')[0] ?? '').split('#')[0].trim();
}
/** Every `[[link]]` target in a text, outside fenced code blocks. */
export function wikilinks(text) {
    const out = [];
    for (const m of stripCode(text).matchAll(WIKILINK)) {
        const t = linkTarget(m[1] ?? '');
        if (t !== '')
            out.push(t);
    }
    return out;
}
function stripCode(text) {
    return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}
/** `kind:ref[@hash][ YYYY-MM-DD]`. Returns null when the text is not a source. */
export function parseSource(raw) {
    const s = raw.trim();
    const colon = s.indexOf(':');
    if (colon <= 0)
        return null;
    const kind = s.slice(0, colon);
    if (!SOURCE_KINDS.includes(kind))
        return null;
    let rest = s.slice(colon + 1).trim();
    let at = null;
    const date = /\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/.exec(rest);
    if (date) {
        at = date[1] ?? null;
        rest = rest.slice(0, date.index).trim();
    }
    let hash = null;
    const atSign = rest.lastIndexOf('@');
    // A hash has no slash or colon after the @; this keeps user@host in URLs intact.
    if (atSign > 0 && !/[/:]/.test(rest.slice(atSign + 1))) {
        hash = rest.slice(atSign + 1) || null;
        rest = rest.slice(0, atSign);
    }
    if (rest === '')
        return null;
    return { kind, ref: rest, hash, at };
}
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strOrNull = (v) => (v === null || v === undefined || Array.isArray(v) ? null : String(v));
const list = (v) => {
    if (v === null || v === undefined)
        return [];
    const items = Array.isArray(v) ? v : [v];
    return items.filter((x) => typeof x === 'string' || typeof x === 'number').map(String).map(s => s.trim()).filter(Boolean);
};
const oneOf = (v, allowed, fallback, field, issues) => {
    if (v === undefined || v === null)
        return fallback;
    if (typeof v === 'string' && allowed.includes(v))
        return v;
    issues.push(`${field}: "${String(v)}" is not one of ${allowed.join(', ')}`);
    return fallback;
};
function fileStem(path) {
    const name = path.split('/').pop() ?? path;
    return name.replace(/\.md$/i, '');
}
export function parseNote(path, text) {
    const fm = parseFrontMatter(text);
    const d = fm.data;
    const issues = [...fm.issues];
    const hasType = d.type !== undefined && d.type !== null;
    const type = hasType ? oneOf(d.type, NODE_TYPES, 'note', 'type', issues) : 'note';
    const title = str(d.title).trim() || fileStem(path);
    const sources = [];
    for (const raw of list(d.sources)) {
        const src = parseSource(raw);
        if (src)
            sources.push(src);
        else
            issues.push(`sources: cannot read "${raw}" (expected kind:ref[@hash][ date])`);
    }
    const links = [];
    for (const type of FRONT_MATTER_EDGES)
        for (const raw of list(d[type]))
            links.push({ type, target: wikilinks(raw)[0] ?? raw });
    for (const target of wikilinks(fm.body))
        links.push({ type: 'mentions', target });
    const headings = [];
    let inFence = false;
    for (const line of fm.body.split('\n')) {
        if (/^```/.test(line))
            inFence = !inFence;
        const h = inFence ? null : HEADING.exec(line);
        if (h)
            headings.push(h[1] ?? '');
    }
    const version = typeof d.version === 'number' ? d.version : 1;
    const done = typeof d.done === 'boolean' ? d.done : null;
    return {
        path,
        id: strOrNull(d.id),
        type,
        title,
        summary: str(d.summary).trim(),
        aliases: list(d.aliases),
        tags: list(d.tags),
        status: oneOf(d.status, STATUSES, 'active', 'status', issues),
        confidence: oneOf(d.confidence, CONFIDENCES, hasType ? 'human' : 'imported', 'confidence', issues),
        origin: oneOf(d.origin, ORIGINS, 'local', 'origin', issues),
        validFrom: strOrNull(d.valid_from),
        validTo: strOrNull(d.valid_to),
        recordedAt: strOrNull(d.recorded_at),
        updatedAt: strOrNull(d.updated_at),
        version,
        author: str(d.author),
        sources,
        paths: list(d.paths),
        urls: list(d.urls),
        done,
        due: strOrNull(d.due),
        headings,
        body: fm.body,
        bodyLines: fm.body.split('\n').length,
        links,
        issues,
        hasFrontMatter: fm.hasFrontMatter,
    };
}
