// HTTP API in front of any Store (spec 07 §5), with an optional MCP endpoint (see mcp.ts).
// JSON in and out, Bearer tokens checked by SHA-256 hash, Idempotency-Key on writes, If-Match on PATCH.
// Fields are the Store's camelCase names (NodeInput in, NodeRecord out), not the snake_case of the Markdown front matter.
import { createServer } from 'node:http';
import { cryptoRandom, newId } from "../core/ids.js";
import { buildManifest, DEFAULT_MANIFEST } from "../core/manifest.js";
import { CONFIDENCES, EDGE_TYPES, FRONT_MATTER_EDGES, NODE_TYPES, ORIGINS, SCHEMA_VERSION, SOURCE_KINDS, STATUSES } from "../core/model.js";
import { hashToken } from "../host/token.js";
import { StoreError } from "../core/store.js";
import { handleMcp, NODE_BODY_CAP } from "./mcp.js";
/** A fixed token table (tests, single-user local use). Tokens are hashed at once and never kept in clear. */
export function staticVerifier(tokens) {
    const byHash = new Map(Object.entries(tokens).map(([token, id]) => [hashToken(token), { id }]));
    return async (h) => byHash.get(h) ?? null;
}
export const BODY_LIMIT = 1_048_576;
class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const bad = (message) => new HttpError(400, 'bad_request', message);
const STORE_STATUS = { not_found: 404, conflict: 409, invalid: 422, unavailable: 503 };
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function asObj(v) {
    if (!isObj(v))
        throw bad('the body must be a JSON object');
    return v;
}
function str(o, k, max, required = false) {
    const v = o[k];
    if (v === undefined || v === null) {
        if (required)
            throw bad(`${k} is required`);
        return undefined;
    }
    if (typeof v !== 'string')
        throw bad(`${k} must be a string`);
    if (v.length > max)
        throw bad(`${k} is longer than ${max} characters`);
    if (required && v.trim() === '')
        throw bad(`${k} is required`);
    return v;
}
function strList(o, k) {
    const v = o[k];
    if (v === undefined || v === null)
        return undefined;
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string') || v.length > 200)
        throw bad(`${k} must be a list of at most 200 strings`);
    return v;
}
function oneOf(o, k, allowed) {
    const v = o[k];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'string' || !allowed.includes(v))
        throw bad(`${k} must be one of ${allowed.join(', ')}`);
    return v;
}
const known = (o, fields) => {
    const extra = Object.keys(o).filter(k => !fields.includes(k));
    if (extra.length > 0)
        throw bad(`unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
};
const NODE_FIELDS = ['type', 'title', 'summary', 'body', 'status', 'confidence', 'origin', 'author', 'aliases', 'tags', 'edges', 'sources', 'paths', 'urls', 'validFrom', 'due', 'done'];
const PATCH_FIELDS = ['title', 'summary', 'body', 'aliases', 'tags', 'edges', 'sources', 'paths', 'urls', 'validFrom', 'due', 'done'];
/** Fields shared by create and patch. */
function commonFields(o) {
    const out = {};
    const set = (k, v) => {
        if (v !== undefined)
            out[k] = v;
    };
    set('title', str(o, 'title', 120));
    set('summary', str(o, 'summary', 200));
    set('body', str(o, 'body', 200_000));
    set('aliases', strList(o, 'aliases'));
    set('tags', strList(o, 'tags'));
    set('paths', strList(o, 'paths'));
    set('urls', strList(o, 'urls'));
    set('validFrom', str(o, 'validFrom', 40));
    set('due', str(o, 'due', 40));
    if (o.done !== undefined && o.done !== null) {
        if (typeof o.done !== 'boolean')
            throw bad('done must be true or false');
        out.done = o.done;
    }
    if (o.edges !== undefined && o.edges !== null) {
        const e = asObj(o.edges);
        const edges = {};
        for (const [t, targets] of Object.entries(e)) {
            if (!FRONT_MATTER_EDGES.includes(t))
                throw bad(`edges.${t} is not an edge type (${FRONT_MATTER_EDGES.join(', ')})`);
            if (!Array.isArray(targets) || targets.some(x => typeof x !== 'string'))
                throw bad(`edges.${t} must be a list of titles`);
            edges[t] = targets;
        }
        out.edges = edges;
    }
    if (o.sources !== undefined && o.sources !== null) {
        if (!Array.isArray(o.sources) || o.sources.length > 100)
            throw bad('sources must be a list of at most 100');
        out.sources = o.sources.map(s => {
            const x = asObj(s);
            known(x, ['kind', 'ref', 'hash', 'at']);
            return { kind: oneOf(x, 'kind', SOURCE_KINDS) ?? (() => { throw bad('sources[].kind is required'); })(), ref: str(x, 'ref', 2000, true), hash: str(x, 'hash', 200) ?? null, at: str(x, 'at', 40) ?? null };
        });
    }
    return out;
}
function parseNewNode(raw, author) {
    const o = asObj(raw);
    known(o, NODE_FIELDS);
    const type = oneOf(o, 'type', NODE_TYPES.filter((t) => t !== 'episode'));
    if (!type)
        throw bad('type is required (episodes are written by the system, not through this API)');
    const c = commonFields(o);
    if (!c.title)
        throw bad('title is required');
    const input = {
        type,
        title: c.title,
        summary: c.summary ?? '',
        body: c.body ?? '',
        status: oneOf(o, 'status', STATUSES) ?? 'inbox',
        confidence: oneOf(o, 'confidence', CONFIDENCES) ?? 'agent',
        origin: oneOf(o, 'origin', ORIGINS) ?? 'local',
        author: str(o, 'author', 200) ?? author,
        ...c,
    };
    // Spec 08 §2: web text never becomes a rule, and nothing creates an active rule without a person accepting it.
    if (input.type === 'rule' && input.origin === 'web')
        throw new HttpError(422, 'invalid', 'a rule cannot come from the web');
    if (input.type === 'rule' && input.status !== 'inbox')
        throw new HttpError(422, 'invalid', 'a new rule starts in the inbox; accept it to make it active');
    if (input.type === 'finding' && !input.sources?.length)
        throw new HttpError(422, 'invalid', 'a finding needs at least one source');
    return input;
}
/** The write form of a stored node: PATCH changes some fields and keeps the rest. */
function toInput(n) {
    const edges = {};
    for (const l of n.links)
        if (l.type !== 'mentions')
            (edges[l.type] ??= []).push(l.target);
    return {
        type: n.type,
        title: n.title,
        summary: n.summary,
        body: n.body,
        status: n.status,
        confidence: n.confidence,
        origin: n.origin,
        author: n.author,
        aliases: n.aliases,
        tags: n.tags,
        edges,
        sources: n.sources,
        paths: n.paths,
        urls: n.urls,
        ...(n.validFrom ? { validFrom: n.validFrom } : {}),
        ...(n.due ? { due: n.due } : {}),
        ...(n.done !== null ? { done: n.done } : {}),
    };
}
export function publicNode(n, cap = NODE_BODY_CAP) {
    const { links: _links, issues: _issues, hasFrontMatter: _fm, bodyLines: _bl, path: _path, ...rest } = n;
    return { ...rest, ...(n.body.length > cap ? { body: n.body.slice(0, cap), bodyTruncated: true } : {}) };
}
const pointer = (n) => ({ id: n.id, type: n.type, title: n.title, summary: n.summary, status: n.status, origin: n.origin });
export function createApp(opts) {
    const label = opts.label ?? 'memory';
    const now = opts.now ?? (() => new Date().toISOString());
    const mint = opts.newId ?? ((prefix) => newId(prefix, Date.now(), cryptoRandom));
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const storeFor = (p) => (typeof opts.store === 'function' ? opts.store(p) : opts.store);
    // In-process replay cache for stores that keep no idempotency keys of their own (Files). Postgres also keeps them durably.
    const replays = new Map();
    const REPLAY_MAX = 1000;
    const readBody = async (req) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > BODY_LIMIT)
                throw new HttpError(413, 'payload_too_large', `the body is larger than ${BODY_LIMIT} bytes`);
            chunks.push(chunk);
        }
        if (size === 0)
            return {};
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw bad('the body is not valid JSON');
        }
    };
    const handle = async (req) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const path = url.pathname.replace(/\/+$/, '') || '/';
        if (method === 'GET' && path === '/v1/health')
            return { status: 200, body: { ok: true, schema_version: SCHEMA_VERSION } };
        const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
        const principal = m ? await opts.verify(hashToken(m[1])) : null;
        if (!principal)
            return { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: { code: 'unauthorized', message: 'a valid bearer token is required' } } };
        if (path === '/mcp') {
            if (!opts.mcp)
                throw new HttpError(404, 'not_found', 'the MCP endpoint is off');
            const origin = req.headers.origin;
            const allowed = opts.allowedOrigins ?? [];
            if (origin && !allowed.includes(origin) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin))
                throw new HttpError(403, 'forbidden', 'origin not allowed');
            if (method !== 'POST')
                return { status: 405, headers: { allow: 'POST' }, body: { error: { code: 'method_not_allowed', message: 'POST JSON-RPC messages to this endpoint' } } };
            return handleMcp(storeFor(principal), await readBody(req), { label });
        }
        const store = storeFor(principal);
        const idemKey = req.headers['idempotency-key'];
        const writes = method === 'POST' || method === 'PATCH' || method === 'DELETE';
        if (typeof idemKey === 'string' && (idemKey === '' || idemKey.length > 200))
            throw bad('Idempotency-Key must be 1 to 200 characters');
        // The key names one operation: scoping it by principal, method and path stops one client's key from replaying another's call.
        const storeKey = typeof idemKey === 'string' && writes ? `${principal.id}|${method} ${path}|${idemKey}` : undefined;
        const replay = storeKey ? replays.get(storeKey) : undefined;
        if (replay)
            return { ...replay, headers: { ...replay.headers, 'idempotent-replayed': 'true' } };
        const reply = await route(store, principal, method, path, url, req, storeKey);
        if (storeKey && reply.status < 300) {
            if (replays.size >= REPLAY_MAX)
                replays.delete(replays.keys().next().value);
            replays.set(storeKey, reply);
        }
        return reply;
    };
    const route = async (store, principal, method, path, url, req, key) => {
        const ok = (body, status = 200) => ({ status, body });
        const writeOpts = (extra = {}) => ({ now: now(), newId: mint, ...(key ? { idempotencyKey: key } : {}), actor: principal.id, ...extra });
        if (method === 'GET' && path === '/v1/manifest') {
            const data = await store.manifestData({ maxTopics: DEFAULT_MANIFEST.maxTopics });
            const manifest = buildManifest(data, { ...DEFAULT_MANIFEST, vaultPath: label, backend: store.kind });
            return ok({ ...manifest, data: { rules: data.rules.map(pointer), tasks: data.tasks.map(pointer), topics: data.topics.map(t => ({ ...pointer(t.node), count: t.count })), notes: data.notes, byType: data.byType } });
        }
        if (method === 'POST' && path === '/v1/search') {
            const o = asObj(await readBody(req));
            known(o, ['text', 'limit', 'types', 'includeInbox']);
            const text = str(o, 'text', 2000, true);
            const types = strList(o, 'types');
            if (types?.some(t => !NODE_TYPES.includes(t)))
                throw bad(`types must be among ${NODE_TYPES.join(', ')}`);
            const hits = await store.search({ text, limit: clampInt(o.limit, 1, 50, 10), includeInbox: o.includeInbox === true, ...(types ? { types: types } : {}) });
            return ok({ results: await withPointers(store, hits) });
        }
        if (method === 'POST' && path === '/v1/match') {
            const o = asObj(await readBody(req));
            known(o, ['path', 'url', 'command', 'scopes']);
            if (o.command !== undefined)
                throw new HttpError(501, 'not_implemented', 'matching by command is not supported yet');
            const k = { ...(str(o, 'path', 2000) ? { path: str(o, 'path', 2000) } : {}), ...(str(o, 'url', 2000) ? { url: str(o, 'url', 2000) } : {}) };
            if (!k.path && !k.url)
                throw bad('path or url is required');
            const r = await store.matchExact(k);
            const recs = await store.getMany([...r.bySource, ...r.byEntity]);
            return ok({ bySource: r.bySource.flatMap(id => (recs.has(id) ? [pointer(recs.get(id))] : [])), byEntity: r.byEntity.flatMap(id => (recs.has(id) ? [pointer(recs.get(id))] : [])) });
        }
        if (method === 'POST' && path === '/v1/links') {
            const o = asObj(await readBody(req));
            known(o, ['ids', 'depth', 'types', 'limit', 'direction', 'skipHubs', 'scopes']);
            const ids = strList(o, 'ids');
            if (!ids?.length)
                throw bad('ids is required');
            const types = strList(o, 'types');
            if (types?.some(t => !EDGE_TYPES.includes(t)))
                throw bad(`types must be among ${EDGE_TYPES.join(', ')}`);
            if (o.depth !== undefined && o.depth !== 1 && o.depth !== 2)
                throw bad('depth must be 1 or 2');
            const found = await store.links({ ids, depth: o.depth === 2 ? 2 : 1, limit: clampInt(o.limit, 1, 200, 20), ...(types ? { types: types } : {}) });
            const recs = await store.getMany(found.map(f => f.id));
            return ok({ neighbours: found.flatMap(f => (recs.has(f.id) ? [{ ...pointer(recs.get(f.id)), hop: f.hop, via: f.via, from: f.from }] : [])) });
        }
        if (method === 'GET' && path === '/v1/changes') {
            const feed = store;
            if (!feed.changesSince)
                throw new HttpError(501, 'not_implemented', `the ${store.kind} store keeps no change log`);
            const since = url.searchParams.get('since');
            if (since !== null && !/^\d{1,18}$/.test(since))
                throw bad('since must be a cursor from an earlier call');
            return ok(await feed.changesSince(since, clampInt(url.searchParams.get('limit'), 1, 500, 100)));
        }
        if (method === 'POST' && path === '/v1/nodes') {
            const node = await store.put(parseNewNode(await readBody(req), principal.id), writeOpts());
            return { status: 201, headers: { etag: `"${node.version}"`, location: `/v1/nodes/${node.id}` }, body: publicNode(node) };
        }
        const id = /^\/v1\/nodes\/([^/]+)(?:\/(accept|reject|retire))?$/.exec(path);
        if (id) {
            const nodeId = decodeURIComponent(id[1]);
            const action = id[2];
            if (method === 'GET' && !action) {
                const node = await store.get(nodeId);
                if (!node)
                    throw new HttpError(404, 'not_found', `no node ${nodeId}`);
                return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) };
            }
            if (method === 'PATCH' && !action) {
                const header = req.headers['if-match'];
                if (typeof header !== 'string')
                    throw new HttpError(428, 'precondition_required', 'send If-Match: <version> with every update');
                const expected = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
                if (!expected)
                    throw bad('If-Match must be a node version, for example "3"');
                const o = asObj(await readBody(req));
                known(o, PATCH_FIELDS);
                const current = await store.get(nodeId);
                if (!current)
                    throw new HttpError(404, 'not_found', `no node ${nodeId}`);
                // The version check is repeated by the store inside its transaction; this one only gives a clear early answer.
                const input = { ...toInput(current), ...commonFields(o) };
                if (input.type === 'finding' && !input.sources?.length)
                    throw new HttpError(422, 'invalid', 'a finding needs at least one source');
                const node = await store.put(input, writeOpts({ id: nodeId, expectedVersion: Number(expected[1]) }));
                return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) };
            }
            if (method === 'POST' && action) {
                const o = asObj(await readBody(req));
                known(o, ['reason', 'validTo']);
                const status = action === 'accept' ? 'active' : action === 'reject' ? 'rejected' : 'archived';
                const validTo = action === 'retire' ? (str(o, 'validTo', 40) ?? now().slice(0, 10)) : undefined;
                const node = await store.setStatus(nodeId, status, { now: now(), ...(validTo ? { validTo } : {}), ...(key ? { idempotencyKey: key } : {}), actor: principal.id });
                return { status: 200, headers: { etag: `"${node.version}"` }, body: publicNode(node) };
            }
            if (method === 'DELETE' && !action)
                throw new HttpError(501, 'not_implemented', 'deleting nodes is not supported yet; retire the node instead');
        }
        if (/^\/v1\/(edges|episodes|asof|doctor)(\/|$)/.test(path))
            throw new HttpError(501, 'not_implemented', `${path} is not supported yet`);
        throw new HttpError(404, 'not_found', `no route for ${method} ${path}`);
    };
    const server = createServer((req, res) => {
        void respond(req, res);
    });
    // Slow clients are cut off by Node itself; the per-request timer below covers slow stores.
    server.requestTimeout = timeoutMs;
    server.headersTimeout = Math.min(timeoutMs, 60_000);
    const respond = async (req, res) => {
        let timer;
        let reply;
        try {
            const timeout = new Promise((_, rej) => {
                timer = setTimeout(() => rej(new HttpError(503, 'timeout', `no answer within ${timeoutMs} ms`)), timeoutMs);
            });
            reply = await Promise.race([handle(req), timeout]);
        }
        catch (e) {
            reply = failure(e);
        }
        finally {
            clearTimeout(timer);
        }
        if (res.writableEnded || res.destroyed)
            return;
        const payload = reply.body === undefined ? '' : JSON.stringify(reply.body);
        res.writeHead(reply.status, { ...(payload ? { 'content-type': 'application/json; charset=utf-8' } : {}), 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', ...reply.headers });
        res.end(payload);
    };
    return {
        server,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            // 127.0.0.1 unless the owner chooses otherwise: the API has no TLS of its own.
            server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
                const a = server.address();
                resolve({ host: a.address, port: a.port });
            });
        }),
        close: () => new Promise((resolve, reject) => {
            server.close(e => (e ? reject(e) : resolve()));
            server.closeAllConnections();
        }),
    };
}
function failure(e) {
    if (e instanceof HttpError)
        return { status: e.status, body: { error: { code: e.code, message: e.message } } };
    if (e instanceof StoreError)
        return { status: STORE_STATUS[e.code], body: { error: { code: e.code, message: e.message } } };
    // Anything else is a bug or an outage; the details stay in the server log, not in the response.
    console.error('memory server error:', e);
    return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}
function clampInt(v, min, max, fallback) {
    if (v === undefined || v === null || v === '')
        return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
        throw bad(`must be a whole number from ${min} to ${max}`);
    return n;
}
/** Search hits as pointers: what a caller needs to decide whether to open a node. */
export async function withPointers(store, hits) {
    const recs = await store.getMany(hits.map(h => h.id));
    return hits.flatMap(h => (recs.has(h.id) ? [{ ...pointer(recs.get(h.id)), score: h.score, why: h.why, ...(h.replaces ? { replaces: h.replaces } : {}) }] : []));
}
