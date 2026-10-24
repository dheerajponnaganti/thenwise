// The HTTP API and MCP endpoint, with a real server on a random port, over the Files store and over Postgres.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import pg from 'pg'

import type { Store } from '../src/core/store.ts'
import { createApp, staticVerifier } from '../src/server/server.ts'
import type { App, Verifier } from '../src/server/server.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { grantApp } from '../src/store-postgres/migrate.ts'
import { addMembership, createToken, pgVerifier, revokeToken } from '../src/store-postgres/pg-auth.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import { ID, SEED } from './conformance.ts'
import { MemIO } from './mem-io.ts'
import { pgSkip } from './pg-cluster.ts'
import { pgFixture, SCOPE_A, seedScope } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

interface Running {
  base: string
  token: string
  /** Notes in the store, to prove a retry did not write twice. */
  count(): Promise<number>
  stop(): Promise<void>
}

const NEW_NOTE = { type: 'decision', title: 'Retry pushes with backoff', summary: 'Exponential backoff up to 5 minutes.', body: '## Reason\nPush fails often.', edges: { about: ['Sync Engine'] } }

async function launch(store: Store | ((p: { id: string }) => Store), verify: Verifier, extra: { mcp?: boolean; timeoutMs?: number } = {}): Promise<{ app: App; base: string }> {
  const app = createApp({ store, verify, mcp: extra.mcp ?? true, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}), label: 'test' })
  const { host, port } = await app.listen()

  return { app, base: `http://${host}:${port}` }
}

function api(r: { base: string; token: string }) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${r.base}${path}`, { method, headers: { authorization: `Bearer ${r.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()

    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : undefined }
  }
}

function suite(name: string, start: () => Promise<Running>, opts: { changes: boolean }) {
  describe(`http api over ${name}`, () => {
    let r: Running
    before(async () => {
      r = await start()
    })
    after(() => r?.stop())

    test('health is open; everything else needs a valid bearer token', async () => {
      assert.deepEqual((await (await fetch(`${r.base}/v1/health`)).json()), { ok: true, schema_version: 1 })
      for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }] as Record<string, string>[]) {
        const res = await fetch(`${r.base}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'budget' }) })
        assert.equal(res.status, 401)
        assert.equal(res.headers.get('www-authenticate'), 'Bearer')
        assert.equal(((await res.json()) as any).error.code, 'unauthorized')
      }
      assert.equal((await fetch(`${r.base}/v1/nodes/${ID.rule}`)).status, 401)
      assert.equal((await fetch(`${r.base}/mcp`, { method: 'POST', body: '{}' })).status, 401)
    })

    test('search, match, links, get and manifest answer', async () => {
      const call = api(r)
      const s = await call('POST', '/v1/search', { text: 'CRDT merges budget', limit: 5 })
      assert.equal(s.status, 200)
      assert.ok(s.json.results.some((h: any) => h.id === ID.newDec && h.replaces === 'Merge budgets with CRDTs'))
      assert.ok(!s.json.results.some((h: any) => h.id === ID.oldDec || h.id === ID.rejected))
      const m = await call('POST', '/v1/match', { path: 'src/sync/conflict.ts' })
      assert.deepEqual(m.json.bySource.map((n: any) => n.id), [ID.newDec])
      const l = await call('POST', '/v1/links', { ids: [ID.task], depth: 1 })
      assert.deepEqual(l.json.neighbours.map((n: any) => [n.id, n.via]), [[ID.engine, 'about']])
      const g = await call('GET', `/v1/nodes/${ID.newDec}`)
      assert.equal(g.json.title, 'Server decides budget conflicts')
      assert.equal(g.headers.get('etag'), '"1"')
      assert.equal(g.json.links, undefined, 'internal fields stay inside')
      assert.equal((await call('GET', '/v1/nodes/dec_missing')).status, 404)
      const man = await call('GET', '/v1/manifest')
      assert.match(man.json.text, /<memory scope="project"/)
      assert.deepEqual(man.json.data.rules.map((x: any) => x.id), [ID.rule])
    })

    test('bad input gets a JSON error', async () => {
      const call = api(r)
      assert.equal((await call('POST', '/v1/search', {})).status, 400)
      assert.equal((await call('POST', '/v1/search', { text: 'x', surprise: 1 })).status, 400)
      assert.equal((await call('POST', '/v1/nodes', { type: 'episode', title: 'x' })).status, 400)
      assert.equal((await call('POST', '/v1/nodes', { type: 'rule', title: 'No dashes', summary: 's', status: 'active' })).status, 422, 'rules start in the inbox')
      assert.equal((await call('POST', '/v1/nodes', { type: 'rule', title: 'From a page', summary: 's', origin: 'web' })).status, 422)
      assert.equal((await call('POST', '/v1/nodes', { type: 'finding', title: 'No sources', summary: 's' })).status, 422)
      const raw = await fetch(`${r.base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${r.token}` }, body: '{not json' })
      assert.equal(raw.status, 400)
      assert.equal(((await raw.json()) as any).error.code, 'bad_request')
      assert.equal((await call('GET', '/v1/nothing')).status, 404)
      assert.equal((await call('DELETE', `/v1/nodes/${ID.rule}`)).status, 501)
    })

    test('a write with an Idempotency-Key happens once; a retry returns the same node', async () => {
      const call = api(r)
      const before = await r.count()
      const a = await call('POST', '/v1/nodes', NEW_NOTE, { 'idempotency-key': 'create-1' })
      assert.equal(a.status, 201)
      assert.match(a.json.id, /^dec_/)
      assert.equal(a.json.status, 'inbox')
      assert.equal(a.json.author, 'tester')
      const b = await call('POST', '/v1/nodes', NEW_NOTE, { 'idempotency-key': 'create-1' })
      assert.equal(b.status, 201)
      assert.equal(b.json.id, a.json.id)
      assert.equal(await r.count(), before + 1)
      const c = await call('POST', '/v1/nodes', NEW_NOTE, { 'idempotency-key': 'create-2' })
      assert.notEqual(c.json.id, a.json.id, 'another key is another write')
      assert.equal(await r.count(), before + 2)
      // Accepting twice with one key is one status change.
      const acc = await call('POST', `/v1/nodes/${a.json.id}/accept`, undefined, { 'idempotency-key': 'accept-1' })
      assert.equal(acc.json.status, 'active')
      assert.equal((await call('POST', `/v1/nodes/${a.json.id}/accept`, undefined, { 'idempotency-key': 'accept-1' })).status, 200)
    })

    test('PATCH needs If-Match and a stale version is a 409', async () => {
      const call = api(r)
      const made = (await call('POST', '/v1/nodes', { ...NEW_NOTE, title: 'Cache cursors per device' })).json
      assert.equal((await call('PATCH', `/v1/nodes/${made.id}`, { summary: 'x' })).status, 428)
      assert.equal((await call('PATCH', `/v1/nodes/${made.id}`, { summary: 'x' }, { 'if-match': 'abc' })).status, 400)
      assert.equal((await call('PATCH', `/v1/nodes/${made.id}`, { confidence: 'human' }, { 'if-match': '"1"' })).status, 400, 'provenance cannot be patched')
      const ok = await call('PATCH', `/v1/nodes/${made.id}`, { summary: 'Now with a TTL.' }, { 'if-match': '"1"' })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.version, 2)
      assert.equal(ok.json.summary, 'Now with a TTL.')
      assert.equal(ok.json.title, 'Cache cursors per device', 'untouched fields stay')
      assert.equal(ok.headers.get('etag'), '"2"')
      const stale = await call('PATCH', `/v1/nodes/${made.id}`, { summary: 'lost update' }, { 'if-match': '"1"' })
      assert.equal(stale.status, 409)
      assert.equal(stale.json.error.code, 'conflict')
      assert.equal((await call('GET', `/v1/nodes/${made.id}`)).json.summary, 'Now with a TTL.')
      assert.equal((await call('PATCH', `/v1/nodes/${ID.newDec}`, { summary: 'x' }, { 'if-match': '1' })).status, 422, 'a note written by a person is not rewritten')
      assert.equal((await call('PATCH', '/v1/nodes/dec_missing', { summary: 'x' }, { 'if-match': '1' })).status, 404)
    })

    test('accept, reject and retire change the status', async () => {
      const call = api(r)
      assert.equal((await call('POST', `/v1/nodes/${ID.inbox}/accept`)).json.status, 'active')
      assert.equal((await call('POST', `/v1/nodes/${ID.inbox}/reject`)).json.status, 'rejected')
      const retired = await call('POST', `/v1/nodes/${ID.task}/retire`, { validTo: '2026-10-22' })
      assert.equal(retired.json.status, 'archived')
      assert.equal(retired.json.validTo, '2026-10-22')
      assert.equal((await call('POST', '/v1/nodes/dec_missing/accept')).status, 404)
    })

    test('changes since a cursor', async () => {
      const call = api(r)
      const res = await call('GET', '/v1/changes?limit=2')
      if (!opts.changes) return assert.equal(res.status, 501)
      assert.equal(res.status, 200)
      assert.equal(res.json.events.length, 2)
      const next = await call('GET', `/v1/changes?since=${res.json.cursor}&limit=500`)
      assert.ok(next.json.events.length > 0)
      assert.ok(Number(next.json.events[0].seq) > Number(res.json.cursor))
      assert.equal((await call('GET', '/v1/changes?since=abc')).status, 400)
    })

    test('MCP: initialize, tools/list and tools/call', async () => {
      const post = async (msg: unknown) => {
        const res = await fetch(`${r.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg) })

        return { status: res.status, json: res.status === 202 ? undefined : ((await res.json()) as any) }
      }
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
      assert.equal(init.json.id, 1)
      assert.equal(init.json.result.protocolVersion, '2025-06-18')
      assert.ok(init.json.result.capabilities.tools)
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      assert.deepEqual(list.json.result.tools.map((t: any) => t.name), ['memory_search', 'memory_get', 'memory_links'])
      assert.equal(list.json.result.tools[0].inputSchema.required[0], 'text')
      const search = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { text: 'conflicts budget', limit: 3 } } })
      assert.match(search.json.result.content[0].text, /<memory scope="test"[\s\S]*Server decides budget conflicts[\s\S]*memory_get dec_/)
      const get = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_get', arguments: { id: ID.finding } } })
      assert.match(get.json.result.content[0].text, /CRDT merge cost on low-end phones/)
      assert.equal((await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_get', arguments: { id: 'dec_missing' } } })).json.result.isError, true)
      const links = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memory_links', arguments: { ids: [ID.engine], depth: 1, types: ['about'] } } })
      assert.match(links.json.result.content[0].text, /about/)
      assert.equal((await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory_forget', arguments: {} } })).json.error.code, -32602)
      assert.equal((await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'memory_search', arguments: {} } })).json.error.code, -32602)
      assert.equal((await post({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).json.error.code, -32601)
      assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json.error.code, -32600)
      assert.deepEqual((await post({ jsonrpc: '2.0', id: 10, method: 'ping' })).json.result, {})
      const hostile = await fetch(`${r.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${r.token}`, origin: 'https://evil.example' }, body: '{}' })
      assert.equal(hostile.status, 403)
      assert.equal((await fetch(`${r.base}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${r.token}` } })).status, 405)
    })
  })
}

// ---- Files store ---------------------------------------------------------------------------

suite(
  'the Files store',
  async () => {
    const io = new MemIO(Object.fromEntries(Object.entries(SEED).map(([p, t]) => [`/vault/${p}`, t])))
    const store = new FilesStore(io, '/vault', null)
    await store.open()
    const { app, base } = await launch(store, staticVerifier({ 'files-token': 'tester' }))

    return { base, token: 'files-token', count: async () => (await store.stats()).notes, stop: () => app.close() }
  },
  { changes: false },
)

// ---- Postgres ------------------------------------------------------------------------------

describe('http api over Postgres', { skip: pgSkip }, () => {
  let fx: PgFixture
  before(async () => {
    fx = await pgFixture()
  })
  after(() => fx?.stop())

  // The same checks, with row-level security enforced (the server's pool is an unprivileged role) and tokens in the database.
  const pgSuiteStart = async (): Promise<Running> => {
    const db = await fx.fresh()
    const roles = await db.pool.query("select 1 from pg_roles where rolname = 'app_user'")
    if (!roles.rows[0]) await db.pool.query('create role app_user login nosuperuser nobypassrls')
    await grantApp(db.pool, 'app_user')
    await seedScope(db.pool, SCOPE_A, SEED)
    await addMembership(db.pool, 'tester', SCOPE_A)
    const token = await createToken(db.pool, 'tester', 'test')
    const appPool = new pg.Pool({ ...fx.cluster.config(db.db, 'app_user'), max: 4 })
    const { app, base } = await launch(p => new PgStore(appPool, SCOPE_A, { principal: p.id }), pgVerifier(appPool, SCOPE_A))
    const owner = new PgStore(db.pool, SCOPE_A)

    return {
      base,
      token,
      count: async () => (await owner.stats()).notes,
      async stop() {
        await app.close()
        await appPool.end()
        await db.close()
      },
    }
  }

  suite('Postgres under row-level security', pgSuiteStart, { changes: true })

  test('a Postgres retry survives a server restart; revoked and foreign tokens are refused', async () => {
    const db = await fx.fresh()
    const app = new pg.Pool({ ...fx.cluster.config(db.db, 'app_user'), max: 4 })
    try {
      const roles = await db.pool.query("select 1 from pg_roles where rolname = 'app_user'")
      if (!roles.rows[0]) await db.pool.query('create role app_user login nosuperuser nobypassrls')
      await grantApp(db.pool, 'app_user')
      await seedScope(db.pool, SCOPE_A, SEED)
      await addMembership(db.pool, 'tester', SCOPE_A)
      await addMembership(db.pool, 'outsider', { kind: 'project', key: 'elsewhere' })
      const token = await createToken(db.pool, 'tester')
      const outsider = await createToken(db.pool, 'outsider')
      const owner = new PgStore(db.pool, SCOPE_A)
      const start = () => launch(p => new PgStore(app, SCOPE_A, { principal: p.id }), pgVerifier(app, SCOPE_A))
      const first = await start()
      const created = await api({ base: first.base, token })('POST', '/v1/nodes', NEW_NOTE, { 'idempotency-key': 'once' })
      await first.app.close()
      const second = await start()
      const again = await api({ base: second.base, token })('POST', '/v1/nodes', NEW_NOTE, { 'idempotency-key': 'once' })
      assert.equal(again.json.id, created.json.id, 'the database remembered the key, not the process')
      assert.equal((await owner.stats()).notes, 11)
      assert.equal((await api({ base: second.base, token: outsider })('GET', `/v1/nodes/${ID.rule}`)).status, 401, 'a member of another scope')
      assert.equal(await revokeToken(db.pool, token), true)
      assert.equal((await api({ base: second.base, token })('GET', `/v1/nodes/${ID.rule}`)).status, 401, 'revoked')
      await second.app.close()
    } finally {
      await app.end()
      await db.close()
    }
  })
})

test('a request that outlasts the timeout gets a JSON 503', async () => {
  const slow = { kind: 'files', search: () => new Promise(() => undefined) } as unknown as Store
  const { app, base } = await launch(slow, staticVerifier({ t: 'tester' }), { timeoutMs: 100 })
  try {
    const res = await api({ base, token: 't' })('POST', '/v1/search', { text: 'anything' })
    assert.equal(res.status, 503)
    assert.equal(res.json.error.code, 'timeout')
  } finally {
    await app.close()
  }
})
