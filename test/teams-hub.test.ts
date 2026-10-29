import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { flush, joinTeam, pull, share, sharedIds, unshare } from '../src/teams/client.ts'
import { migrateTeamDb, openTeamDb } from '../src/teams/schema.ts'
import { createTeamServer, invite } from '../src/teams/server.ts'
import type { ServerOptions } from '../src/teams/server.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw12-${p}-`))
const NOTE = { title: 'Cache plan', text: 'Eight shards for the exporter.', project: 'alpha' }
const DAY = 864e5

// The first name invited is the owner. `clock.now` moves time for expiry cases.
async function team(names = ['root', 'alice', 'bob'], extra: Partial<ServerOptions> = {}) {
  const dir = tmp('srv')
  const clock = { now: Date.now() }
  const app = createTeamServer({ dir, now: () => clock.now, ...extra })
  const { port } = await app.listen()
  const base = `http://127.0.0.1:${port}`
  const db = openTeamDb(dir)
  const tokens: Record<string, string> = Object.fromEntries(names.map((n) => [n, invite(db, n)]))
  db.close()
  const req = (token: string | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  const idOf = async (n: string) => (await (await req(tokens[n]!, '/v1/me')).json()).id as string
  const put = (n: string, id: string, body: object = NOTE, match = '*') => req(tokens[n]!, `/v1/notes/${id}`, { method: 'PUT', body, headers: { 'if-match': match } })
  const roleOf = async (n: string, role: string) => (await req(tokens.root!, `/v1/members/${await idOf(n)}`, { method: 'PATCH', body: { role } })).status
  // A person joined by invite code with the given role.
  const joinAs = async (name: string, role: string) => {
    const code = (await (await req(tokens.root!, '/v1/invites', { method: 'POST', body: { role } })).json()).code
    const j = await (await req(null, '/v1/join', { method: 'POST', body: { code, name } })).json()
    tokens[name] = j.token

    return j
  }

  return { dir, app, base, tokens, req, clock, idOf, put, roleOf, joinAs }
}
const cookies = (r: Response) => r.headers.getSetCookie()
const jar = (r: Response) => ({ cookie: cookies(r).map((c) => c.split(';')[0]).join('; '), csrf: /tw_csrf=([^;]+)/.exec(cookies(r).join(';'))![1]! })

test('T12-H1: an admin invites, a new person joins once with a code, and both are audited', async () => {
  const t = await team()
  try {
    const j = await t.joinAs('dana', 'editor')
    assert.equal(j.role, 'editor')
    assert.equal((await (await t.req(j.token, '/v1/me')).json()).role, 'editor')
    const code = (await (await t.req(t.tokens.root!, '/v1/invites', { method: 'POST', body: { role: 'member' } })).json()).code
    assert.equal((await t.req(null, '/v1/join', { method: 'POST', body: { code, name: 'erin' } })).status, 200)
    assert.equal((await t.req(null, '/v1/join', { method: 'POST', body: { code, name: 'frank' } })).status, 401, 'the code works once')
    const actions = (await (await t.req(t.tokens.root!, '/v1/audit')).json()).entries.map((e: any) => e.action)
    assert.ok(actions.includes('invite.create') && actions.includes('member.join'))
    assert.equal((await t.req(null, '/v1/join', { method: 'POST', body: { code: 'twi_x', name: 'bob' } })).status, 401)
  } finally {
    await t.app.close()
  }
})

test('T12-H2: a session cookie signs in, and /v1/me works with the cookie alone', async () => {
  const t = await team()
  try {
    const r = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.alice } })
    assert.equal(r.status, 200)
    const all = cookies(r)
    assert.match(all.find((c) => c.startsWith('tw_session='))!, /HttpOnly; Path=\/; SameSite=Strict; Max-Age=1209600$/)
    assert.ok(all.find((c) => c.startsWith('tw_csrf=') && !/HttpOnly/.test(c)))
    const me = await (await fetch(`${t.base}/v1/me`, { headers: { cookie: jar(r).cookie } })).json()
    assert.equal(me.name, 'alice')
    assert.equal((await t.req(null, '/v1/session', { method: 'POST', body: { token: 'tw_nope' } })).status, 401)
  } finally {
    await t.app.close()
  }
})

test('T12-H3 T12-B4: an editor edits with If-Match and leaves a revision; a stale edit is a 409', async () => {
  const t = await team()
  try {
    const e1 = (await t.joinAs('ed1', 'editor')).token
    const e2 = (await t.joinAs('ed2', 'editor')).token
    const rev1 = (await (await t.put('alice', 'n1')).json()).rev
    const patch = (tok: string, match: number, body: object) => t.req(tok, '/v1/notes/alice/n1', { method: 'PATCH', body, headers: { 'if-match': String(match) } })
    const ok = await patch(e1, rev1, { text: 'Sixteen shards.' })
    assert.equal(ok.status, 200)
    const rev2 = (await ok.json()).rev
    assert.ok(rev2 > rev1)
    const stale = await patch(e2, rev1, { text: 'Four shards.' })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).rev, rev2)
    const revs = (await (await t.req(t.tokens.bob!, '/v1/notes/alice/n1/revisions')).json()).revisions
    assert.deepEqual(revs.map((r: any) => r.rev), [rev2, rev1])
    assert.equal(revs[0].edited_by_name, 'ed1')
    assert.equal(revs[1].text, NOTE.text, 'the old text is readable')
    assert.equal((await (await t.req(t.tokens.bob!, '/v1/notes/alice/n1')).json()).text, 'Sixteen shards.')
    assert.equal((await patch(t.tokens.bob!, rev2, { text: 'x' })).status, 403, 'a member does not edit others')
  } finally {
    await t.app.close()
  }
})

test('T12-H4: superseding marks the old note and the feed carries the change', async () => {
  const t = await team()
  try {
    await t.roleOf('bob', 'editor')
    const a = (await (await t.put('alice', 'a')).json()).rev
    await t.put('alice', 'b')
    const r = await t.req(t.tokens.bob!, '/v1/notes/alice/a/supersede', { method: 'POST', body: { by: 'b' } })
    assert.equal(r.status, 200)
    const feed = (await (await t.req(t.tokens.bob!, `/v1/notes?since=${a}`)).json()).notes.find((n: any) => n.id === 'a')
    assert.equal(feed.status, 'superseded')
    assert.equal(feed.superseded_by, 'b')
    assert.equal((await t.req(t.tokens.bob!, '/v1/notes/alice/a/supersede', { method: 'POST', body: { by: 'nope' } })).status, 400)
    await t.req(t.tokens.bob!, '/v1/notes/alice/b/pin', { method: 'POST' })
    assert.equal((await (await t.req(t.tokens.bob!, '/v1/notes?status=active')).json()).notes[0].pinned, true)
  } finally {
    await t.app.close()
  }
})

test('T12-H5: with the review queue on, a share waits for an admin and stays out of the feed', async () => {
  const t = await team()
  try {
    assert.equal((await t.req(t.tokens.root!, '/v1/settings', { method: 'PATCH', body: { review_queue: true } })).status, 200)
    assert.equal((await t.put('bob', 'q1')).status, 200)
    const get = (n: string) => t.req(t.tokens[n]!, '/v1/notes/bob/q1')
    assert.equal((await (await get('bob')).json()).status, 'pending')
    assert.equal((await get('alice')).status, 404)
    assert.equal((await (await t.req(t.tokens.alice!, '/v1/search?q=shards')).json()).notes.length, 0)
    assert.deepEqual((await (await t.req(t.tokens.alice!, '/v1/notes?since=0')).json()).notes, [])
    assert.equal((await get('root')).status, 200, 'an admin sees it')
    assert.equal((await t.req(t.tokens.bob!, '/v1/notes/bob/q1/approve', { method: 'POST' })).status, 403)
    assert.equal((await t.req(t.tokens.root!, '/v1/notes/bob/q1/approve', { method: 'POST' })).status, 200)
    assert.equal((await (await get('alice')).json()).status, 'active')
    assert.equal((await (await t.req(t.tokens.alice!, '/v1/notes?since=0')).json()).notes.length, 1)
  } finally {
    await t.app.close()
  }
})

// Reads the stored entries of a zip made by src/teams/zip.ts.
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50; ) {
    const size = buf.readUInt32LE(at + 18)
    const name = buf.subarray(at + 30, at + 30 + buf.readUInt16LE(at + 26)).toString()
    out.set(name, buf.subarray(at + 30 + name.length, at + 30 + name.length + size).toString())
    at += 30 + name.length + size
  }

  return out
}

test('T12-H6 T12-B6: the export has one vault-format file per note and an index per project; markup stays text', async () => {
  const t = await team()
  try {
    await t.put('alice', 'x1', { ...NOTE, text: 'Use <script>alert(1)</script> and <img src=x onerror=1>.', kind: 'decision', source: 's1, s2' })
    await t.put('bob', 'x2', { title: 'Other', text: 'plain', project: '' })
    const api = await (await t.req(t.tokens.bob!, '/v1/notes/alice/x1')).json()
    assert.match(api.text, /<script>alert\(1\)<\/script>/)
    assert.equal((await t.req(t.tokens.bob!, '/v1/export.zip')).status, 403)
    const r = await t.req(t.tokens.root!, '/v1/export.zip')
    assert.equal(r.headers.get('content-type'), 'application/zip')
    const files = unzip(Buffer.from(await r.arrayBuffer()))
    const note = [...files].find(([n]) => n.startsWith('alpha/alice-x1'))!
    assert.match(note[1], /^---\nthenwise: 1\nproject: "alpha"\nsources: \["s1", "s2"\]\nshared_by: "alice"\nkind: decision\nstatus: active\n---\n\n# Cache plan\n\nUse <script>/)
    const base = note[0].slice('alpha/'.length, -3)
    assert.match(files.get('alpha/Index.md')!, new RegExp(`\\[\\[${base}\\|Cache plan\\]\\]`))
    assert.ok(files.has('no-project/Index.md'))
  } finally {
    await t.app.close()
  }
})

test('T12-H7 T12-B7: the console folder is served with its headers, and CORS goes only to a listed origin', async () => {
  const dir = tmp('hub')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hub</title>')
  writeFileSync(join(dir, 'assets', 'app.abc123.js'), 'console.log(1)')
  const t = await team(['root'], { console: dir, allowOrigins: ['https://hub.example'] })
  try {
    const home = await fetch(`${t.base}/`)
    assert.match(await home.text(), /<title>Hub/)
    assert.equal(home.headers.get('cache-control'), 'no-cache')
    assert.equal(home.headers.get('content-security-policy'), "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
    const spa = await fetch(`${t.base}/notes/alice/x`)
    assert.match(await spa.text(), /<title>Hub/)
    const js = await fetch(`${t.base}/assets/app.abc123.js`)
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(js.headers.get('content-type')!, /javascript/)
    assert.equal((await fetch(`${t.base}/assets/missing.js`)).status, 404)
    assert.equal((await fetch(`${t.base}/..%2F..%2Fetc%2Fpasswd`)).status, 404)
    const pre = (origin: string) => fetch(`${t.base}/v1/notes`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT' } })
    const good = await pre('https://hub.example')
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://hub.example')
    assert.equal(good.headers.get('access-control-allow-credentials'), 'true')
    assert.match(good.headers.get('access-control-allow-headers')!, /x-thenwise-csrf/)
    const bad = await pre('https://evil.example')
    assert.equal(bad.headers.get('access-control-allow-origin'), null)
    assert.equal((await fetch(`${t.base}/v1/health`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null)
  } finally {
    await t.app.close()
  }
  assert.throws(() => createTeamServer({ dir: tmp('nohub'), console: tmp('empty') }), /no index.html/)
  assert.throws(() => createTeamServer({ dir: tmp('open'), host: '0.0.0.0' }), /--tls-behind-proxy/)
})

test('T12-H8 T12-B1: a viewer reads but never writes, and a member cannot reach admin routes; refusals are audited', async () => {
  const t = await team()
  try {
    await t.put('alice', 'v1')
    const v = (await t.joinAs('vera', 'viewer')).token
    for (const p of ['/v1/me', '/v1/notes', '/v1/notes/alice/v1', '/v1/search?q=shards', '/v1/tombs', '/v1/notes/alice/v1/revisions']) assert.equal((await t.req(v, p)).status, 200, p)
    assert.equal((await t.put('vera', 'w1')).status, 403)
    assert.equal((await t.req(v, '/v1/notes/v1', { method: 'DELETE', headers: { 'if-match': '*' } })).status, 403)
    assert.equal((await t.req(v, '/v1/notes/alice/v1/pin', { method: 'POST' })).status, 403)
    const bob = t.tokens.bob!
    assert.equal((await t.req(bob, '/v1/members')).status, 403)
    assert.equal((await t.req(bob, '/v1/settings', { method: 'PATCH', body: { name: 'Mine', review_queue: true } })).status, 403)
    assert.equal((await t.req(bob, '/v1/invites', { method: 'POST', body: {} })).status, 403)
    assert.deepEqual(await (await t.req(t.tokens.root!, '/v1/settings')).json(), { name: 'Team', review_queue: false })
    assert.equal((await t.req(t.tokens.root!, '/v1/notes/alice/w1')).status, 404, 'nothing was written')
    const denied = (await (await t.req(t.tokens.root!, '/v1/audit?action=denied')).json()).entries
    assert.equal(denied.length, 6)
    assert.ok(denied.some((e: any) => e.actor_name === 'bob' && e.target === 'GET /v1/members'))
  } finally {
    await t.app.close()
  }
})

test('T12-B2: a write with a session needs the CSRF header; a bearer token does not', async () => {
  const t = await team()
  try {
    const r = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.alice } })
    const { cookie, csrf } = jar(r)
    const write = (headers: Record<string, string>) => fetch(`${t.base}/v1/notes/c1`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'if-match': '*', ...headers }, body: JSON.stringify(NOTE) })
    assert.equal((await write({})).status, 403)
    assert.equal((await write({ 'x-thenwise-csrf': 'wrong' })).status, 403)
    assert.equal((await write({ 'x-thenwise-csrf': csrf, cookie: `tw_session=${cookie.split('=')[1]!.split(';')[0]}` })).status, 403, 'the csrf cookie is needed too')
    assert.equal((await write({ 'x-thenwise-csrf': csrf })).status, 200)
    assert.equal((await t.put('bob', 'c2')).status, 200)
    const out = await fetch(`${t.base}/v1/session`, { method: 'DELETE', headers: { cookie, 'x-thenwise-csrf': csrf } })
    assert.equal(out.status, 200)
    assert.equal((await fetch(`${t.base}/v1/me`, { headers: { cookie } })).status, 401, 'the session is gone')
  } finally {
    await t.app.close()
  }
})

test('T12-B3: an expired session, an expired invite and a disabled member are 401 and nothing is written', async () => {
  const t = await team()
  try {
    const r = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.alice } })
    const code = (await (await t.req(t.tokens.root!, '/v1/invites', { method: 'POST', body: { days: 1 } })).json()).code
    const bobId = await t.idOf('bob')
    assert.equal((await t.req(t.tokens.root!, `/v1/members/${bobId}`, { method: 'PATCH', body: { disabled: true } })).status, 200)
    assert.equal((await t.req(t.tokens.bob!, '/v1/me')).status, 401)
    assert.equal((await t.put('bob', 'd1')).status, 401)
    t.clock.now += 15 * DAY
    const gone = await fetch(`${t.base}/v1/me`, { headers: { cookie: jar(r).cookie } })
    assert.equal(gone.status, 401)
    assert.match(cookies(gone).join(';'), /tw_session=; .*Max-Age=0/, 'the browser is told to drop the cookie')
    assert.equal((await t.req(null, '/v1/join', { method: 'POST', body: { code, name: 'late' } })).status, 401)
    const db = new DatabaseSync(join(t.dir, 'team.db'))
    assert.equal((db.prepare("SELECT count(*) n FROM members WHERE name = 'late'").get() as any).n, 0)
    assert.equal((db.prepare("SELECT count(*) n FROM notes WHERE id = 'd1'").get() as any).n, 0)
    db.close()
  } finally {
    await t.app.close()
  }
})

test('T12-B5: the 0.1.9 client shares, pulls and unshares against this server, and sends kind and source', async () => {
  const t = await team()
  try {
    const dir = tmp('cl')
    await joinTeam(dir, t.base, t.tokens.alice!)
    assert.match(await share(dir, 'k1', { ...NOTE, kind: 'dead_end', source: 'commit-1' }), /^1 sent/)
    const n = await (await t.req(t.tokens.bob!, '/v1/notes/alice/k1')).json()
    assert.equal(n.kind, 'dead_end')
    assert.equal(n.source, 'commit-1')
    assert.match(await pull(dir), /^1 shared/)
    assert.deepEqual(sharedIds(dir), ['k1'])
    assert.match(await unshare(dir, 'k1'), /^unshared/)
    assert.equal((await t.req(t.tokens.bob!, '/v1/notes/alice/k1')).status, 404)
    assert.match(await flush(dir), /nothing waiting/)
    assert.equal((await t.req(t.tokens.bob!, '/v1/notes/alice/k1/revisions')).status, 404, 'an unshare takes the old text with it')
  } finally {
    await t.app.close()
  }
})

test('T12-B8: migration 2 gives every old note a team, kind, status and revision, and the first member is the owner', () => {
  const dir = tmp('old')
  const db = new DatabaseSync(join(dir, 'team.db'))
  db.exec(`CREATE TABLE members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER);
    CREATE TABLE notes (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (owner, id));
    CREATE TABLE tombs (owner TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (owner, id));
    INSERT INTO members VALUES ('alice', 'h1', NULL), ('bob', 'h2', NULL);
    INSERT INTO notes VALUES ('alice', 'n1', 5, 'One', 'first', 'alpha'), ('bob', 'n2', 6, 'Two', 'second', '');`)
  migrateTeamDb(db)
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 4)
  const rows = db.prepare('SELECT n.kind, n.status, n.pinned, n.tags, n.team_id, t.id AS tid, n.shared_by = n.owner_id AS mine FROM notes n JOIN teams t ON t.id = n.team_id').all() as any[]
  assert.equal(rows.length, 2)
  for (const r of rows) assert.deepEqual([r.kind, r.status, r.pinned, r.tags, r.mine], ['note', 'active', 0, '[]', 1])
  assert.equal((db.prepare('SELECT count(*) n FROM members WHERE team_id = (SELECT id FROM teams)').get() as any).n, 2)
  assert.deepEqual((db.prepare('SELECT name, role FROM members ORDER BY name').all() as any[]).map((m) => m.role), ['owner', 'member'])
  assert.equal((db.prepare('SELECT count(*) n FROM note_revisions').get() as any).n, 2)
  db.close()
})

test('T12-B9: read counts are kept 90 days and dropped after; last seen stays', async () => {
  const t = await team()
  try {
    await t.put('alice', 'u1')
    const s = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.bob } })
    const read = () => fetch(`${t.base}/v1/notes/alice/u1`, { headers: { cookie: jar(s).cookie } })
    await read()
    await read()
    await t.req(t.tokens.alice!, '/v1/notes/alice/u1')
    const stats = await (await t.req(t.tokens.root!, '/v1/stats')).json()
    assert.deepEqual(stats.top.map((n: any) => [n.id, n.reads]), [['u1', 2]], 'only session reads count')
    assert.ok(stats.members.find((m: any) => m.name === 'bob').last_seen)
    t.clock.now += 91 * DAY
    assert.equal((await t.req(t.tokens.root!, '/v1/health')).status, 200)
    const db = new DatabaseSync(join(t.dir, 'team.db'))
    assert.equal((db.prepare('SELECT count(*) n FROM note_reads').get() as any).n, 0)
    assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as any).n, 0, 'expired sessions go too')
    assert.ok((db.prepare("SELECT last_seen FROM members WHERE name = 'bob'").get() as any).last_seen)
    db.close()
  } finally {
    await t.app.close()
  }
})

test('T12-B10: the owner cannot be removed or changed; make-owner hands the team over', async () => {
  const t = await team()
  try {
    const rootId = await t.idOf('root')
    const bobId = await t.idOf('bob')
    await t.roleOf('alice', 'admin')
    const a = t.tokens.alice!
    assert.equal((await t.req(a, `/v1/members/${rootId}`, { method: 'DELETE' })).status, 400, 'notes=keep|delete is required')
    assert.equal((await t.req(a, `/v1/members/${rootId}?notes=keep`, { method: 'DELETE' })).status, 409)
    assert.equal((await t.req(a, `/v1/members/${rootId}`, { method: 'PATCH', body: { disabled: true } })).status, 409)
    assert.equal((await t.req(a, `/v1/members/${bobId}`, { method: 'PATCH', body: { role: 'owner' } })).status, 400)
    assert.equal((await t.req(a, `/v1/members/${bobId}/make-owner`, { method: 'POST' })).status, 403, 'only the owner hands over')
    assert.equal((await t.req(t.tokens.root!, `/v1/members/${bobId}/make-owner`, { method: 'POST' })).status, 200)
    const roles = Object.fromEntries((await (await t.req(a, '/v1/members')).json()).members.map((m: any) => [m.name, m.role]))
    assert.deepEqual(roles, { alice: 'admin', bob: 'owner', root: 'admin' })
    assert.equal((await t.req(a, `/v1/members/${bobId}/rotate`, { method: 'POST' })).status, 403, 'an admin cannot rotate the owner')
    const rot = await (await t.req(t.tokens.bob!, `/v1/members/${await t.idOf('root')}/rotate`, { method: 'POST' })).json()
    assert.equal((await t.req(t.tokens.root!, '/v1/me')).status, 401)
    assert.equal((await t.req(rot.token, '/v1/me')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('a zip past 65,535 files is refused instead of crashing', async () => {
  const { zip } = await import('../src/teams/zip.ts')
  assert.ok(zip([['a.md', 'x']]))
  assert.equal(zip(Array.from({ length: 65_536 }, (_, i): [string, string] => [`n${i}.md`, ''])), undefined)
})

test('a Hub on another host: cookies are cross-site, the session hands over its CSRF value, and a write with it works', async () => {
  const origin = 'https://hub.example.org'
  const t = await team(['root'], { allowOrigins: [origin] })
  try {
    const r = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.root }, headers: { origin } })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('access-control-allow-origin'), origin)
    const { cookie, csrf } = jar(r)
    for (const c of cookies(r)) assert.match(c, /SameSite=None; Secure/)
    const body = await (await t.req(null, '/v1/session/csrf', { headers: { origin, cookie } })).json()
    assert.equal(body.csrf, csrf, 'the Hub gets the value it cannot read from the cookie')
    assert.equal((await t.req(t.tokens.root!, '/v1/session/csrf')).status, 400, 'a token has no CSRF value')
    const w = await t.req(null, '/v1/notes/x1', { method: 'PUT', body: NOTE, headers: { origin, cookie, 'if-match': '*', 'x-thenwise-csrf': body.csrf } })
    assert.equal(w.status, 200)
    const bad = await t.req(null, '/v1/notes/x2', { method: 'PUT', body: NOTE, headers: { origin, cookie, 'if-match': '*' } })
    assert.equal(bad.status, 403, 'a write without the header is still refused')
  } finally {
    await t.app.close()
  }
})

test('without --allow-origin the session cookies stay SameSite=Strict', async () => {
  const t = await team(['root'])
  try {
    const r = await t.req(null, '/v1/session', { method: 'POST', body: { token: t.tokens.root } })
    for (const c of cookies(r)) assert.match(c, /SameSite=Strict/)
  } finally {
    await t.app.close()
  }
})
