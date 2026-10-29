import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { readLog } from '../src/core/log.ts'
import { flush, joinTeam, pull, resolveNote, share, sharedIds, teamStatus, unshare } from '../src/teams/client.ts'
import { migrateTeamDb, openTeamDb, SCHEMA_VERSION } from '../src/teams/schema.ts'
import { createTeamServer, invite, LIMITS, listMembers, removeMember, rotate } from '../src/teams/server.ts'

delete process.env.THENWISE_LOG // B2 reads the client's log
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw9-${p}-`))

async function team(names = ['alice', 'bob']) {
  const dir = tmp('srv')
  const app = createTeamServer({ dir, version: 'test' })
  const { port } = await app.listen()
  const base = `http://127.0.0.1:${port}`
  const db = openTeamDb(dir)
  const tokens: Record<string, string> = Object.fromEntries(names.map((n) => [n, invite(db, n)]))
  db.close()
  const req = (token: string | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }) })

  return { dir, app, base, tokens, req }
}
const CHAT = { project: 'org/alpha', head: 'first prompt', started_at: 1000, ended_at: 2000, turns: [{ id: 't1', at: 1000, line: 'why shards', passages: ['Eight shards for the exporter.'], paths: ['src/a.ts'] }] }
const NOTE = { title: 'Cache plan', text: 'Eight shards for the exporter.', project: 'alpha' }

test('T9-H1: a 0.1.5 team.db migrates to the current schema, and a newer one is refused', () => {
  const dir = tmp('old')
  const db = new DatabaseSync(join(dir, 'team.db'))
  db.exec(`CREATE TABLE members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER);
    CREATE TABLE notes (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (owner, id));
    CREATE TABLE tombs (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (owner, id));
    INSERT INTO members VALUES ('alice', 'h-alice', NULL);
    INSERT INTO notes VALUES ('alice', 'n1', 1700000000000, 'One', 'first note', 'alpha'), ('gone', 'g1', 1700000000001, 'Kept', 'a removed member kept this', '');
    INSERT INTO tombs VALUES ('alice', 'n0', 1700000000002);`)
  assert.deepEqual(migrateTeamDb(db), [1, 2, 3, 4])
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, SCHEMA_VERSION)
  const members = db.prepare('SELECT id, name, token_hash, disabled FROM members ORDER BY name').all() as any[]
  assert.deepEqual(members.map((m) => [m.name, m.token_hash, m.disabled]), [['alice', 'h-alice', 0], ['gone', null, 1]])
  assert.ok(members.every((m) => /^[0-9a-f]{32}$/.test(m.id)))
  assert.equal((db.prepare('SELECT count(*) n FROM notes WHERE owner_id IS NULL').get() as any).n, 0)
  assert.equal((db.prepare("SELECT n.text FROM notes n JOIN members m ON m.id = n.owner_id WHERE m.name = 'gone'").get() as any).text, 'a removed member kept this')
  assert.equal((db.prepare("SELECT count(*) n FROM notes_fts WHERE notes_fts MATCH 'removed'").get() as any).n, 1)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  assert.throws(() => openTeamDb(dir), /newer Thenwise/)
})

test('T9-H3: a share takes If-Match and answers with the new revision as an ETag; a stale one is a 409', async () => {
  const t = await team()
  try {
    const r1 = await t.req(t.tokens.alice!, '/v1/notes/n1', { method: 'PUT', body: NOTE, headers: { 'if-match': '*' } })
    const rev1 = (await r1.json()).rev
    assert.equal(r1.headers.get('etag'), `"${rev1}"`)
    const r2 = await t.req(t.tokens.alice!, '/v1/notes/n1', { method: 'PUT', body: NOTE, headers: { 'if-match': String(rev1) } })
    const rev2 = (await r2.json()).rev
    assert.ok(rev2 > rev1)
    const r3 = await t.req(t.tokens.alice!, '/v1/notes/n1', { method: 'PUT', body: NOTE, headers: { 'if-match': String(rev1) } })
    assert.equal(r3.status, 409)
    const j = await r3.json()
    assert.equal(j.error.code, 'stale')
    assert.equal(j.rev, rev2)
    assert.equal((await t.req(t.tokens.alice!, '/v1/notes/n1', { method: 'PUT', body: NOTE, headers: { 'if-match': '*' } })).status, 409, 'a note on the team is not new')
  } finally {
    await t.app.close()
  }
})

test('T9-H4: two machines of one person never overwrite each other silently', async () => {
  const t = await team()
  try {
    const [m1, m2] = [tmp('m1'), tmp('m2')]
    await joinTeam(m1, t.base, t.tokens.alice!)
    await joinTeam(m2, t.base, t.tokens.alice!)
    assert.match(await share(m1, 'x', { ...NOTE, text: 'from the laptop' }), /^1 sent/)
    // The desktop never saw the laptop's revision; its change is newer, so it goes over the team's copy once.
    assert.match(await share(m2, 'x', { ...NOTE, text: 'from the desktop' }), /^1 sent/)
    const now = await (await t.req(t.tokens.bob!, '/v1/notes/alice/x')).json()
    assert.equal(now.text, 'from the desktop')
    // A change the laptop made before the desktop's arrives late: the team keeps the newer copy and says so.
    const s = JSON.parse(readFileSync(join(m1, 'team.json'), 'utf8'))
    s.queue = [{ op: 'put', id: 'x', rev: s.lastRev + 1, at: now.updated_at - 1000, note: { ...NOTE, text: 'stale laptop edit' } }]
    writeFileSync(join(m1, 'team.json'), JSON.stringify(s))
    assert.match(await flush(m1), /the team has a newer copy of x/)
    assert.equal((await (await t.req(t.tokens.bob!, '/v1/notes/alice/x')).json()).text, 'from the desktop')
  } finally {
    await t.app.close()
  }
})

test('T9-H5: a server behind a path prefix can be joined', async () => {
  const t = await team()
  const target = new URL(t.base)
  const proxy = createServer((req, res) => {
    if (!req.url?.startsWith('/thenwise/')) return res.writeHead(404).end()
    const up = request({ host: target.hostname, port: target.port, path: req.url.slice('/thenwise'.length), method: req.method, headers: req.headers }, (r) => (res.writeHead(r.statusCode ?? 502, r.headers), r.pipe(res)))
    req.pipe(up)
  })
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok))
  try {
    const dir = tmp('pre')
    assert.equal(await joinTeam(dir, `http://127.0.0.1:${(proxy.address() as any).port}/thenwise/`, t.tokens.alice!), 'alice')
    assert.match(await share(dir, 'p1', NOTE), /^1 sent/)
  } finally {
    proxy.close()
    await t.app.close()
  }
})

test('T9-H6: search folds accents, matches whole words, and shows the hit in a snippet', async () => {
  const t = await team()
  try {
    const put = (id: string, title: string, text: string) => t.req(t.tokens.alice!, `/v1/notes/${id}`, { method: 'PUT', body: { title, text, project: '' }, headers: { 'if-match': '*' } })
    await put('r', 'Résumé of the plan', `${'Long opening words about other things. '.repeat(20)}The résumé lists the shard count.`)
    await put('g', 'Gear', 'Only part of the gear is here.')
    const find = async (q: string) => (await (await t.req(t.tokens.bob!, `/v1/search?q=${encodeURIComponent(q)}`)).json()).notes
    const hit = await find('resume')
    assert.deepEqual(hit.map((n: any) => n.id), ['r'])
    assert.match(hit[0].snippet, /\*\*résumé\*\*/i)
    assert.deepEqual(await find('art'), [])
  } finally {
    await t.app.close()
  }
})

test('T9-H7: feeds give what changed after a revision, in revision order', async () => {
  const t = await team()
  try {
    const h = (m: string) => ({ 'if-match': m })
    const start = (await (await t.req(t.tokens.alice!, '/v1/notes/z0', { method: 'PUT', body: NOTE, headers: h('*') })).json()).rev
    for (const id of ['n1', 'n2', 'n3']) await t.req(t.tokens.alice!, `/v1/notes/${id}`, { method: 'PUT', body: NOTE, headers: h('*') })
    await t.req(t.tokens.alice!, '/v1/notes/n1', { method: 'DELETE', headers: h('*') })
    const notes = (await (await t.req(t.tokens.bob!, `/v1/notes?since=${start}`)).json()).notes
    assert.deepEqual(notes.map((n: any) => n.id), ['n2', 'n3'])
    assert.ok(notes[0].rev < notes[1].rev)
    assert.deepEqual((await (await t.req(t.tokens.bob!, `/v1/tombs?since=${start}`)).json()).tombs.map((x: any) => x.id), ['n1'])
  } finally {
    await t.app.close()
  }
})

test('T9-H8 T9-H9: a removed name is not reused by someone else; --again brings the same person back; rotate', async () => {
  const t = await team(['root', 'alice', 'bob'])
  try {
    const id = (await (await t.req(t.tokens.alice!, '/v1/me')).json()).id
    const rev = (await (await t.req(t.tokens.alice!, '/v1/notes/k1', { method: 'PUT', body: NOTE, headers: { 'if-match': '*' } })).json()).rev
    const db = openTeamDb(t.dir)
    removeMember(db, 'alice', true)
    assert.equal((await t.req(t.tokens.alice!, '/v1/me')).status, 401)
    assert.throws(() => invite(db, 'alice'), /--again/)
    const back = invite(db, 'alice', undefined, { again: true })
    assert.equal((await (await t.req(back, '/v1/me')).json()).id, id)
    assert.equal((await t.req(back, '/v1/notes/k1', { method: 'PUT', body: NOTE, headers: { 'if-match': String(rev) } })).status, 200, 'the old notes are hers')
    const carol = invite(db, 'carol')
    assert.notEqual((await (await t.req(carol, '/v1/me')).json()).id, id)
    const rows = listMembers(db)
    assert.deepEqual(rows.map((m) => m.name), ['alice', 'bob', 'carol', 'root'])
    assert.ok(rows.find((m) => m.name === 'alice')!.last_seen)
    const fresh = rotate(db, 'bob')
    db.close()
    assert.equal((await t.req(t.tokens.bob!, '/v1/me')).status, 401)
    assert.equal((await t.req(fresh, '/v1/me')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('T9-B2: a refused token stops the syncs, logs once, and status says what to do', async () => {
  const t = await team()
  try {
    const dir = tmp('bob')
    await joinTeam(dir, t.base, t.tokens.bob!)
    const db = openTeamDb(t.dir)
    removeMember(db, 'bob', true)
    db.close()
    await share(dir, 'q1', NOTE)
    for (let i = 0; i < 10; i++) assert.match(await flush(dir), /refused your token/)
    assert.equal(readLog(dir).filter((e) => e.ev === 'token_refused').length, 1)
    assert.match(teamStatus(dir)[0]!, /ask for a new invite/)
    assert.equal(JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8')).queue.length, 1, 'the change waits')
  } finally {
    await t.app.close()
  }
})

test('T9-B3: bad input is a 400 with a code on /v1; the old routes are a 404 that says to update', async () => {
  const t = await team()
  try {
    const code = async (r: Response) => (assert.ok(r.status >= 400, String(r.status)), (await r.json()).error.code)
    assert.equal(await code(await t.req(t.tokens.alice!, '/v1/notes?limit=abc')), 'bad_request')
    assert.equal(await code(await t.req(t.tokens.alice!, '/v1/notes?offset=-5')), 'bad_request')
    assert.equal(await code(await t.req(t.tokens.alice!, '/v1/notes/x', { method: 'PUT', body: NOTE, headers: { 'if-match': 'soon' } })), 'bad_request')
    assert.equal(await code(await t.req(t.tokens.alice!, '/v1/notes/x', { method: 'PUT', body: { ...NOTE, text: 'x'.repeat(300 * 1024) }, headers: { 'if-match': '*' } })), 'too_large')
    assert.equal(await code(await t.req(t.tokens.alice!, '/v1/nothing')), 'not_found')
    const old = await t.req(t.tokens.alice!, '/notes/x', { method: 'PUT', body: '{"title": 1}' })
    assert.equal(old.status, 404)
    assert.match((await old.json()).error, /update Thenwise/)
    for (const h of ['x-content-type-options', 'cache-control', 'referrer-policy', 'content-security-policy']) assert.ok(old.headers.get(h), h)
  } finally {
    await t.app.close()
  }
})

test('T9-B4: past the read limit a token gets 429 with Retry-After; another token is not affected', async () => {
  const t = await team()
  try {
    for (let i = 0; i < LIMITS.reads; i++) assert.equal((await t.req(t.tokens.alice!, '/v1/me')).status, 200)
    const r = await t.req(t.tokens.alice!, '/v1/me')
    assert.equal(r.status, 429)
    assert.ok(Number(r.headers.get('retry-after')) > 0)
    assert.equal((await t.req(t.tokens.bob!, '/v1/me')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('T9-B7: a rejoin keeps what was shared, and pull restores it so an unshare works without the file', async () => {
  const t = await team()
  try {
    const dir = tmp('re')
    await joinTeam(dir, t.base, t.tokens.alice!)
    const file = join(dir, 'plan.md')
    writeFileSync(file, '---\nid: plan-1\ntitle: Plan\n---\nthe plan\n')
    const n = resolveNote(dir, join(dir, 'claude'), file)
    await share(dir, n.id, n)
    unlinkSync(file)
    await joinTeam(dir, t.base, t.tokens.alice!)
    assert.deepEqual(sharedIds(dir), ['plan-1'], 'a rejoin keeps the list')
    const s = JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8'))
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ ...s, shared: {} })) // as a 0.1.5 rejoin left it
    assert.match(await pull(dir), /^1 shared note/)
    assert.match(await unshare(dir, 'plan-1'), /^unshared/)
    assert.equal((await t.req(t.tokens.bob!, '/v1/notes/alice/plan-1')).status, 404)
  } finally {
    await t.app.close()
  }
})

// A small validator for the JSON Schema the spec uses: type (also a list), required, properties, items, enum, $ref.
function check(spec: any, schema: any, v: unknown, at = '$'): string[] {
  if (schema.$ref) return check(spec, schema.$ref.slice(2).split('/').reduce((o: any, k: string) => o[k], spec), v, at)
  const types = [schema.type ?? []].flat()
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
  if (types.length && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return [`${at}: ${kind}, not ${types.join(' or ')}`]
  if (schema.enum && !schema.enum.includes(v)) return [`${at}: not one of ${schema.enum}`]
  const errs: string[] = []
  if (kind === 'object') {
    for (const k of schema.required ?? []) if (!(k in (v as object))) errs.push(`${at}.${k}: missing`)
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in (v as object)) errs.push(...check(spec, s, (v as any)[k], `${at}.${k}`))
  }
  if (kind === 'array' && schema.items) (v as unknown[]).forEach((x, i) => errs.push(...check(spec, schema.items, x, `${at}[${i}]`)))

  return errs
}

test('T9-B5: every /v1 route in openapi.json answers as its spec says, and others are 404', async () => {
  const spec = JSON.parse(readFileSync('openapi.json', 'utf8'))
  const t = await team()
  try {
    const tok = t.tokens.alice!
    const bob = t.tokens.bob!
    const ids = { alice: '', bob: '' }
    ids.alice = (await (await t.req(tok, '/v1/me')).json()).id
    ids.bob = (await (await t.req(bob, '/v1/me')).json()).id
    const codes: string[] = []
    const invited = async (role: string) => {
      const r = await t.req(tok, '/v1/invites', { method: 'POST', body: { role, days: 1 } })
      codes.push((await r.clone().json()).code)

      return r
    }
    const joined: { id: string; token: string }[] = []
    const join = async (name: string) => {
      const r = await t.req(null, '/v1/join', { method: 'POST', body: { code: codes.shift(), name } })
      joined.push(await r.clone().json())

      return r
    }
    const rev = (await (await t.req(tok, '/v1/notes/c1', { method: 'PUT', body: NOTE, headers: { 'if-match': '*' } })).json()).rev
    // Thunks, run one at a time: the writes depend on each other.
    const calls: [string, string, () => Promise<Response>, number][] = [
      ['/v1/health', 'get', () => t.req(null, '/v1/health'), 200],
      ['/v1/me', 'get', () => t.req(tok, '/v1/me'), 200],
      ['/v1/me', 'get', () => t.req('nope', '/v1/me'), 401],
      ['/v1/search', 'get', () => t.req(tok, '/v1/search?q=shards'), 200],
      ['/v1/notes', 'get', () => t.req(tok, '/v1/notes?since=0&owner=me'), 200],
      ['/v1/notes/{owner}/{id}', 'get', () => t.req(tok, '/v1/notes/alice/c1'), 200],
      ['/v1/notes/{owner}/{id}', 'get', () => t.req(tok, '/v1/notes/alice/none'), 404],
      ['/v1/notes/{id}', 'put', () => t.req(tok, '/v1/notes/c1', { method: 'PUT', body: NOTE, headers: { 'if-match': String(rev) } }), 200],
      ['/v1/notes/{id}', 'put', () => t.req(tok, '/v1/notes/c1', { method: 'PUT', body: NOTE, headers: { 'if-match': String(rev) } }), 409],
      ['/v1/session', 'post', () => t.req(null, '/v1/session', { method: 'POST', body: { token: tok } }), 200],
      ['/v1/session', 'delete', () => t.req(tok, '/v1/session', { method: 'DELETE' }), 200],
      ['/v1/session/csrf', 'get', () => t.req(tok, '/v1/session/csrf'), 400],
      ['/v1/invites', 'post', () => invited('member'), 200],
      ['/v1/join', 'post', () => join('dan'), 200],
      ['/v1/join', 'post', () => t.req(null, '/v1/join', { method: 'POST', body: { code: 'twi_nope', name: 'dan' } }), 401],
      ['/v1/invites', 'post', () => invited('viewer'), 200],
      ['/v1/join', 'post', () => join('eve'), 200],
      ['/v1/members', 'get', () => t.req(tok, '/v1/members'), 200],
      ['/v1/members', 'get', () => t.req(bob, '/v1/members'), 403],
      ['/v1/members/{id}', 'patch', () => t.req(tok, `/v1/members/${joined[0]!.id}`, { method: 'PATCH', body: { role: 'editor' } }), 200],
      ['/v1/members/{id}/rotate', 'post', () => t.req(tok, `/v1/members/${joined[0]!.id}/rotate`, { method: 'POST' }), 200],
      ['/v1/settings', 'get', () => t.req(tok, '/v1/settings'), 200],
      ['/v1/settings', 'patch', () => t.req(tok, '/v1/settings', { method: 'PATCH', body: { name: 'Acme', review_queue: false } }), 200],
      ['/v1/audit', 'get', () => t.req(tok, '/v1/audit'), 200],
      ['/v1/stats', 'get', () => t.req(tok, '/v1/stats'), 200],
      ['/v1/export.zip', 'get', () => t.req(tok, '/v1/export.zip'), 200],
      ['/v1/chats/{session}', 'put', () => t.req(tok, '/v1/chats/s1', { method: 'PUT', body: CHAT, headers: { 'if-match': '*' } }), 200],
      ['/v1/chats/{session}', 'put', () => t.req(tok, '/v1/chats/s1', { method: 'PUT', body: CHAT, headers: { 'if-match': '*' } }), 409],
      ['/v1/chats', 'get', () => t.req(bob, '/v1/chats?since=0'), 200],
      ['/v1/chats/search', 'get', () => t.req(bob, '/v1/chats/search?q=shards'), 200],
      ['/v1/chats/{owner}/{session}', 'get', () => t.req(bob, '/v1/chats/alice/s1'), 200],
      ['/v1/chats/{owner}/{session}', 'get', () => t.req(bob, '/v1/chats/alice/none'), 404],
      ['/v1/shared-projects', 'get', () => t.req(bob, '/v1/shared-projects'), 200],
      ['/v1/chat-settings', 'get', () => t.req(tok, '/v1/chat-settings'), 200],
      ['/v1/chat-settings', 'patch', () => t.req(tok, '/v1/chat-settings', { method: 'PATCH', body: { chat_retention_days: null } }), 200],
      ['/v1/chats/{owner}/{session}', 'delete', () => t.req(tok, '/v1/chats/alice/s1', { method: 'DELETE', headers: { 'if-match': '*' } }), 200],
      ['/v1/chats/{session}', 'delete', () => t.req(tok, '/v1/chats/s2', { method: 'DELETE', headers: { 'if-match': '*' } }), 200],
      ['/v1/shared-projects/{owner}/{project}', 'patch', async () => (await t.req(tok, '/v1/chats/s3', { method: 'PUT', body: CHAT, headers: { 'if-match': '*' } }), t.req(tok, '/v1/shared-projects/alice/org%2Falpha', { method: 'PATCH', body: { status: 'paused' } })), 200],
      ['/v1/shared-projects/{owner}/{project}', 'delete', async () => (await t.req(tok, '/v1/chats/s3', { method: 'PUT', body: CHAT, headers: { 'if-match': '*' } }), t.req(tok, '/v1/shared-projects/alice/org%2Falpha', { method: 'DELETE' })), 200],
      ['/v1/chat-tombs', 'get', () => t.req(bob, '/v1/chat-tombs?since=0'), 200],
      ['/v1/notes/{owner}/{id}', 'patch', async () => t.req(tok, '/v1/notes/alice/c1', { method: 'PATCH', body: { title: 'Edited' }, headers: { 'if-match': String((await (await t.req(tok, '/v1/notes/alice/c1')).json()).rev) } }), 200],
      ['/v1/notes/{owner}/{id}/revisions', 'get', () => t.req(tok, '/v1/notes/alice/c1/revisions'), 200],
      ['/v1/notes/{owner}/{id}/pin', 'post', () => t.req(tok, '/v1/notes/alice/c1/pin', { method: 'POST' }), 200],
      ['/v1/notes/{owner}/{id}/unpin', 'post', () => t.req(tok, '/v1/notes/alice/c1/unpin', { method: 'POST' }), 200],
      ['/v1/notes/{owner}/{id}/approve', 'post', () => t.req(tok, '/v1/notes/alice/c1/approve', { method: 'POST' }), 409],
      ['/v1/notes/{owner}/{id}/retire', 'post', () => t.req(tok, '/v1/notes/alice/c1/retire', { method: 'POST' }), 200],
      ['/v1/notes/{owner}/{id}/supersede', 'post', async () => (await t.req(tok, '/v1/notes/c2', { method: 'PUT', body: NOTE, headers: { 'if-match': '*' } }), t.req(tok, '/v1/notes/alice/c1/supersede', { method: 'POST', body: { by: 'c2' } })), 200],
      ['/v1/members/{id}', 'delete', () => t.req(tok, `/v1/members/${joined[0]!.id}?notes=keep`, { method: 'DELETE' }), 200],
      ['/v1/members/{id}/make-owner', 'post', () => t.req(tok, `/v1/members/${joined[1]!.id}/make-owner`, { method: 'POST' }), 200],
      ['/v1/notes/{id}', 'delete', () => t.req(tok, '/v1/notes/c1', { method: 'DELETE', headers: { 'if-match': '*' } }), 200],
      ['/v1/tombs', 'get', () => t.req(tok, '/v1/tombs?since=0'), 200],
    ]
    const covered = new Set<string>()
    for (const [path, method, p, want] of calls) {
      const r = await p()
      assert.equal(r.status, want, `${method} ${path}`)
      let res = spec.paths[path][method].responses[String(want)]
      if (res.$ref) res = res.$ref.slice(2).split('/').reduce((o: any, k: string) => o[k], spec)
      if (path === '/v1/export.zip') assert.equal(r.headers.get('content-type'), 'application/zip')
      else assert.deepEqual(check(spec, res.content['application/json'].schema, await r.json()), [], `${method} ${path} ${want}`)
      covered.add(`${method} ${path}`)
    }
    for (const [path, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops as object)) assert.ok(covered.has(`${m} ${path}`), `not checked: ${m} ${path}`)
    assert.equal((await t.req(tok, '/v1/nothing')).status, 404)
  } finally {
    await t.app.close()
  }
})

test('T17-B5: the v1 part of openapi.json is byte for byte what 0.1.16 shipped; only 1.1 additions are new', () => {
  const old = JSON.parse(readFileSync('test/fixtures/openapi-v1.json', 'utf8'))
  const now = JSON.parse(readFileSync('openapi.json', 'utf8'))
  assert.equal(now.info.version, '1.1')
  assert.deepEqual({ ...now.info, version: '1' }, old.info)
  for (const part of ['paths', 'parameters', 'responses', 'schemas', 'securitySchemes']) {
    const [o, n] = part === 'paths' ? [old.paths, now.paths] : [old.components[part], now.components[part]]
    for (const k of Object.keys(o)) assert.equal(JSON.stringify(n[k]), JSON.stringify(o[k]), `${part} ${k} changed`)
  }
  assert.ok(Object.keys(now.paths).every((p) => p in old.paths || /^\/v1\/(chats|chat-tombs|chat-settings|shared-projects|session\/csrf)/.test(p)))
})

test('a shared Markdown file keeps its kind from type or kind in the front matter', () => {
  const dir = tmp('kind')
  const note = (fm: string) => {
    writeFileSync(join(dir, 'n.md'), `---\n${fm}\n---\nbody\n`)
    return resolveNote(dir, join(dir, 'claude'), join(dir, 'n.md')).kind
  }
  assert.equal(note('type: decision'), 'decision')
  assert.equal(note('kind: dead_end'), 'dead_end')
  assert.equal(note('kind: poem'), undefined) // not a known kind: the server files it as a note
})
