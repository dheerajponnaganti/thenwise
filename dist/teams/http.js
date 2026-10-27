// Input checks for the team server: a bad value is a 400 with a code, never a guess.
export class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/** A whole number from a query value, within bounds; `dflt` when absent. */
export function clampInt(v, dflt, min, max, name) {
    if (v === null || v === '')
        return dflt;
    if (!/^-?\d+$/.test(v))
        throw new HttpError(400, 'bad_request', `${name} must be a whole number`);
    const n = Number(v);
    if (n < min || n > max)
        throw new HttpError(400, 'bad_request', `${name} must be between ${min} and ${max}`);
    return n;
}
/** A string field of a JSON body, at most `max` characters. */
export function str(body, key, max) {
    const v = body[key];
    if (typeof v !== 'string')
        throw new HttpError(400, 'bad_request', `${key} must be text`);
    if (v.length > max)
        throw new HttpError(400, 'bad_request', `${key} is longer than ${max} characters`);
    return v;
}
/** The request body as a JSON object, at most `max` bytes. */
export async function readBody(req, max) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
        size += ch.length;
        if (size > max)
            throw new HttpError(413, 'too_large', `the body is larger than ${max} bytes`);
        chunks.push(ch);
    }
    let v;
    try {
        v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'bad_request', 'the body is not JSON');
    }
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new HttpError(400, 'bad_request', 'the body must be a JSON object');
    return v;
}
/** An If-Match header: a revision, or `*` for a note that must not exist yet. */
export function ifMatch(h) {
    const v = (Array.isArray(h) ? h[0] : h)?.trim().replace(/^"|"$/g, '');
    if (v === '*')
        return '*';
    if (!v || !/^\d+$/.test(v))
        throw new HttpError(400, 'bad_request', 'If-Match must be a revision number or *');
    return Number(v);
}
/** One of a fixed list of words. */
export function oneOf(v, list, name) {
    if (typeof v !== 'string' || !list.includes(v))
        throw new HttpError(400, 'bad_request', `${name} must be one of ${list.join(', ')}`);
    return v;
}
/** A short list of short words (note tags). */
export function tagList(v) {
    if (!Array.isArray(v) || v.length > 20 || v.some((t) => typeof t !== 'string' || !t || t.length > 40))
        throw new HttpError(400, 'bad_request', 'tags must be a list of up to 20 words of up to 40 characters');
    return v;
}
/** A whole number field of a JSON body, within bounds. */
export function intField(v, min, max, name) {
    if (!Number.isSafeInteger(v) || v < min || v > max)
        throw new HttpError(400, 'bad_request', `${name} must be a whole number from ${min} to ${max}`);
    return v;
}
/** The client's own order of a change (a whole number, 0 when absent). */
export function seqOf(v) {
    if (v === undefined || v === null || v === '')
        return 0;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0)
        throw new HttpError(400, 'bad_request', 'seq must be a whole number');
    return n;
}
export const CHAT_LIMITS = { passages: 2000, bytes: 2 * 1024 * 1024, passage: 1200, body: 4 * 1024 * 1024 };
const bad = (m) => new HttpError(400, 'bad_request', m);
const wordList = (v, name, max, len) => {
    if (v === undefined)
        return [];
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x || x.length > len))
        throw bad(`${name} must be a list of up to ${max} texts of up to ${len} characters`);
    return v;
};
// A path is relative to the repo: no drive, no leading slash or home, no climbing out.
const relative = (p) => !/^([/\\~]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes('..');
/** The unit of one shared chat: passages and their metadata only. Absolute paths, `cwd`, and anything past the limits are a 400 naming the field. */
export function chatUnit(body) {
    for (const k of ['cwd', 'extra'])
        if (k in body)
            throw bad(`${k} must not be sent`);
    if (!Array.isArray(body.turns))
        throw bad('turns must be a list');
    let count = 0;
    let bytes = 0;
    const turns = body.turns.map((t, i) => {
        if (!t || typeof t !== 'object' || Array.isArray(t))
            throw bad(`turns[${i}] must be an object`);
        const o = t;
        if ('cwd' in o || 'extra' in o)
            throw bad(`turns[${i}].cwd must not be sent`);
        if (!Array.isArray(o.passages) || !o.passages.length)
            throw bad(`turns[${i}].passages must be a non-empty list`);
        count += o.passages.length;
        if (count > CHAT_LIMITS.passages)
            throw bad(`passages: more than ${CHAT_LIMITS.passages} in one chat`);
        const passages = o.passages.map((p, j) => {
            if (typeof p !== 'string' || !p)
                throw bad(`turns[${i}].passages[${j}] must be text`);
            if (p.length > CHAT_LIMITS.passage)
                throw bad(`turns[${i}].passages[${j}] is longer than ${CHAT_LIMITS.passage} characters`);
            bytes += Buffer.byteLength(p);
            return p;
        });
        const paths = wordList(o.paths, `turns[${i}].paths`, 200, 500);
        if (!paths.every(relative))
            throw bad(`turns[${i}].paths must be relative to the repo, never absolute`);
        const shas = wordList(o.shas, `turns[${i}].shas`, 20, 40);
        if (!shas.every((x) => /^[0-9a-f]{4,40}$/.test(x)))
            throw bad(`turns[${i}].shas must be commit shas`);
        return {
            id: str(o, 'id', 120),
            at: intField(o.at, 0, Number.MAX_SAFE_INTEGER, `turns[${i}].at`),
            line: o.line === undefined ? '' : str(o, 'line', 300),
            kind: o.kind === undefined ? 'turn' : oneOf(o.kind, ['turn', 'summary'], `turns[${i}].kind`),
            passages,
            paths,
            shas,
            prs: wordList(o.prs, `turns[${i}].prs`, 20, 300),
            dead_end: o.dead_end === true,
            dead_kind: o.dead_kind === undefined ? '' : str(o, 'dead_kind', 40),
            dead_text: o.dead_text === undefined ? '' : str(o, 'dead_text', 160),
        };
    });
    if (bytes > CHAT_LIMITS.bytes)
        throw bad(`passages: more than ${CHAT_LIMITS.bytes} bytes in one chat`);
    const project = str(body, 'project', 200);
    if (!project)
        throw bad('project must not be empty');
    return {
        project,
        head: str(body, 'head', 200),
        started_at: intField(body.started_at, 0, Number.MAX_SAFE_INTEGER, 'started_at'),
        ended_at: intField(body.ended_at, 0, Number.MAX_SAFE_INTEGER, 'ended_at'),
        mask: body.mask === undefined ? 0 : intField(body.mask, 0, 1e6, 'mask'),
        turns,
        bytes,
    };
}
