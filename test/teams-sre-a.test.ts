// SRE wave A: rotate follows rank, restore checks its source, removal writes tombs, the server masks, failed sign-ins are counted.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { teamMain } from '../src/teams/cli.ts'
import { fetchShared, joinTeam, readCache, share } from '../src/teams/client.ts'
import { backupTeam, CHAT_QUOTA, createTeamServer, invite, listMembers, openTeamDb, removeMember, restoreTeam, rotate } from '../src/teams/server.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `twa-${p}-`))
const NOTE = { title: 'Cache plan', text: 'Eight shards for the exporter.', project: 'alpha' }

async function team(names: string[], roles: Record<string, string> = {}, now?: () => number) {
  const dir = tmp('srv')
  const app = createTeamServer({ dir, now })
  const { port } = await app.listen()
  const base = `http://127.0.0.1:${port}`
  const db = openTeamDb(dir)
  const tokens: Record<string, string> = Object.fromEntries(names.map((n) => [n, invite(db, n)]))
  for (const [n, role] of Object.entries(roles)) db.prepare('UPDATE members SET role = ? WHERE name = ?').run(role, n)
  const ids = Object.fromEntries(names.map((n) => [n, (db.prepare('SELECT id FROM members WHERE name = ?').get(n) as { id: string }).id]))
  db.close()
  const req = (token: string | null, path: string, method = 'GET', body?: unknown, h: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...h }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  return { dir, app, base, tokens, ids, req }
}

test('SRE-01: rotate follows rank', async () => {
  const t = await team(['root', 'adm', 'adm2', 'bob'], { adm: 'admin', adm2: 'admin' })
  try {
    const rot = (as: string, who: string) => t.req(t.tokens[as]!, `/v1/members/${t.ids[who]}/rotate`, 'POST')
    const r1 = await rot('adm', 'root')
    assert.equal(r1.status, 403)
    assert.equal((await r1.json()).error.code, 'owner_protected')
    assert.equal((await t.req(t.tokens.root!, '/v1/me')).status, 200, 'the owner token still works')
    assert.equal((await rot('adm', 'adm2')).status, 403)
    assert.equal((await rot('bob', 'adm')).status, 403)
    const own = await rot('bob', 'bob')
    assert.equal(own.status, 200, 'a member rotates their own token')
    assert.equal((await t.req((await own.json()).token, '/v1/me')).status, 200)
    assert.equal((await rot('adm', 'bob')).status, 200, 'an admin rotates a member')
    assert.equal((await rot('root', 'adm2')).status, 200, 'the owner rotates an admin')
    assert.equal((await rot('adm', 'adm')).status, 200, 'an admin rotates their own token')
    const db = openTeamDb(t.dir)
    assert.ok(rotate(db, 'root').startsWith('tw_'), 'the operator path still rotates the owner')
    db.close()
  } finally {
    await t.app.close()
  }
})

test('SRE-02: restore refuses a file that is not a team backup, and keeps the replaced team.db', async () => {
  const t = await team(['root', 'bob'])
  await t.app.close()
  const bad = join(tmp('bad'), 'graph.db')
  const g = new DatabaseSync(bad)
  g.exec('CREATE TABLE notes (id TEXT)')
  g.close()
  assert.throws(() => restoreTeam(t.dir, bad), /not a team backup/)
  const noOwner = join(tmp('no'), 'team.db')
  const good = join(tmp('ok'), 'team.db')
  backupTeam(t.dir, good)
  backupTeam(t.dir, noOwner)
  const n = new DatabaseSync(noOwner)
  n.exec("UPDATE members SET role = 'admin'")
  n.close()
  assert.throws(() => restoreTeam(t.dir, noOwner), /no live owner/)
  assert.deepEqual(readdirSync(t.dir).filter((f) => f.includes('before-restore')), [], 'nothing was moved by a refusal')
  const db = openTeamDb(t.dir)
  db.prepare("DELETE FROM members WHERE name = 'bob'").run()
  db.close()
  const r = restoreTeam(t.dir, good)
  assert.match(r.kept, /team\.db\.before-restore-\d{8}-\d{6}$/)
  const old = new DatabaseSync(r.kept)
  assert.equal((old.prepare('SELECT count(*) n FROM members').get() as any).n, 1, 'the kept file has the state before the restore')
  old.close()
  const now = openTeamDb(t.dir)
  assert.equal((now.prepare('SELECT count(*) n FROM members').get() as any).n, 2)
  now.close()
  assert.ok(existsSync(r.kept))
})

test('SRE-03: removing a member with their notes tombs each note and a client drops it', async () => {
  const t = await team(['root', 'bob'])
  try {
    const [m1, m2] = [tmp('m1'), tmp('m2')]
    await joinTeam(m1, t.base, t.tokens.bob!)
    await joinTeam(m2, t.base, t.tokens.root!)
    await share(m1, 'b1', NOTE)
    await fetchShared(m2)
    assert.ok(Object.keys(readCache(m2).notes).some((k) => k.includes('b1')))
    const db = openTeamDb(t.dir)
    assert.equal(removeMember(db, 'bob').notes, 1)
    db.close()
    assert.deepEqual((await (await t.req(t.tokens.root!, '/v1/tombs?since=0')).json()).tombs.map((x: any) => x.id), ['b1'])
    await fetchShared(m2)
    assert.deepEqual(Object.keys(readCache(m2).notes), [])
  } finally {
    await t.app.close()
  }
})

test('SRE-09: a raw PUT with a secret is stored masked', async () => {
  const t = await team(['root'])
  try {
    const tok = `ghp_${'a1B2c3D4e5'.repeat(4)}`
    const put = await t.req(t.tokens.root!, '/v1/notes/s1', 'PUT', { title: `t ${tok}`, text: `use ${tok} here`, project: '' }, { 'if-match': '*' })
    assert.equal(put.status, 200)
    const n = await (await t.req(t.tokens.root!, '/v1/notes/root/s1')).json()
    assert.ok(!n.text.includes('ghp_') && !n.title.includes('ghp_'), JSON.stringify(n))
    const c = await t.req(t.tokens.root!, '/v1/chats/s1', 'PUT', { project: 'p', head: tok, started_at: 1, ended_at: 2, turns: [{ id: 't1', at: 1, line: tok, passages: [`key ${tok}`] }] }, { 'if-match': '*' })
    assert.equal(c.status, 200, JSON.stringify(await c.json()))
    const n1 = await t.req(t.tokens.root!, '/v1/notes/root/s1')
    const ed = await t.req(t.tokens.root!, '/v1/notes/root/s1', 'PATCH', { text: `edited ${tok}` }, { 'if-match': n1.headers.get('etag')!.replace(/"/g, '') })
    assert.equal(ed.status, 200, JSON.stringify(await ed.clone().json()))
    assert.ok(!(await ed.json()).text.includes('ghp_'), 'an edit is masked too')
    const db = openTeamDb(t.dir)
    assert.equal((db.prepare("SELECT count(*) n FROM chat_passages WHERE text LIKE '%ghp_%' OR line LIKE '%ghp_%'").get() as any).n, 0)
    assert.equal((db.prepare("SELECT count(*) n FROM chats WHERE head LIKE '%ghp_%'").get() as any).n, 0)
    db.close()
  } finally {
    await t.app.close()
  }
})

test('SRE-10: 30 bad tokens give 429 from the 21st and one audit row', async () => {
  // The limit counts per clock minute: a frozen clock stops the run from crossing into a new minute.
  const frozen = Date.now()
  const t = await team(['root'], {}, () => frozen)
  try {
    const codes: number[] = []
    for (let i = 0; i < 30; i++) codes.push((await t.req(`tw_bad${i}`, '/v1/me')).status)
    assert.deepEqual(codes.slice(0, 20), Array(20).fill(401))
    assert.deepEqual(codes.slice(20), Array(10).fill(429))
    assert.equal((await t.req(t.tokens.root!, '/v1/me')).status, 200, 'a good token still works')
    const db = openTeamDb(t.dir)
    const rows = db.prepare("SELECT details FROM audit WHERE action = 'auth.failed'").all() as { details: string }[]
    db.close()
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0]!.details).failures, 30)
  } finally {
    await t.app.close()
  }
})

test('SRE-10: a request with no credential is not a failed sign-in', async () => {
  const t = await team(['root'])
  try {
    const codes: number[] = []
    for (let i = 0; i < 30; i++) codes.push((await t.req(null, '/v1/me')).status)
    assert.deepEqual(codes, Array(30).fill(401))
    const db = openTeamDb(t.dir)
    assert.equal((db.prepare("SELECT count(*) n FROM audit WHERE action = 'auth.failed'").get() as any).n, 0)
    db.close()
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h item 1: an admin cannot demote, disable, rotate, remove or promote another admin, or change settings; the owner can', async () => {
  const t = await team(['root', 'a1', 'a2', 'bob'], { a1: 'admin', a2: 'admin' })
  try {
    const as = (who: string, path: string, method = 'GET', body?: unknown) => t.req(t.tokens[who]!, path, method, body)
    const m = (n: string) => `/v1/members/${t.ids[n]}`
    assert.equal((await as('a1', m('a2'), 'PATCH', { role: 'editor' })).status, 403, 'demote')
    assert.equal((await as('a1', m('a2'), 'PATCH', { disabled: true })).status, 403, 'disable')
    assert.equal((await as('a1', m('a2'), 'PATCH', { expires_at: null })).status, 403, 'change expiry')
    assert.equal((await as('a1', `${m('a2')}/rotate`, 'POST')).status, 403, 'rotate')
    assert.equal((await as('a1', `${m('a2')}?notes=keep`, 'DELETE')).status, 403, 'remove')
    assert.equal((await as('a1', m('bob'), 'PATCH', { role: 'admin' })).status, 403, 'promote')
    assert.equal((await as('a1', '/v1/invites', 'POST', { role: 'admin' })).status, 403, 'invite an admin')
    assert.equal((await as('a1', '/v1/settings', 'PATCH', { review_queue: true })).status, 403, 'settings')
    assert.equal((await as('a1', '/v1/chat-settings', 'PATCH', { chat_retention_days: 30 })).status, 403, 'chat settings')
    assert.deepEqual(await (await as('a2', '/v1/me')).json(), { id: t.ids.a2, name: 'a2', role: 'admin' }, 'a2 is untouched')
    assert.equal((await as('a1', m('bob'), 'PATCH', { role: 'editor' })).status, 200, 'an admin still manages an editor')
    assert.equal((await as('a1', '/v1/invites', 'POST', { role: 'editor' })).status, 200)
    assert.equal((await as('a1', `${m('a1')}/rotate`, 'POST')).status, 200, 'an admin rotates their own token')
    assert.equal((await as('root', m('bob'), 'PATCH', { role: 'admin' })).status, 200, 'the owner promotes')
    assert.equal((await as('root', m('a2'), 'PATCH', { role: 'editor' })).status, 200, 'the owner demotes')
    assert.equal((await as('root', `${m('bob')}/rotate`, 'POST')).status, 200, 'the owner rotates an admin')
    assert.equal((await as('root', '/v1/settings', 'PATCH', { review_queue: true })).status, 200)
    assert.equal((await as('root', '/v1/chat-settings', 'PATCH', { chat_retention_days: 30 })).status, 200)
    assert.equal((await as('root', `${m('bob')}?notes=keep`, 'DELETE')).status, 200, 'the owner removes an admin')
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h item 1: an admin cannot unshare or pause the chats of an admin or the owner', async () => {
  const t = await team(['root', 'a1', 'a2', 'ed'], { a1: 'admin', a2: 'admin', ed: 'editor' })
  try {
    const as = (who: string, path: string, method = 'GET', body?: unknown) => t.req(t.tokens[who]!, path, method, body, method === 'DELETE' && path.startsWith('/v1/chats/') ? { 'if-match': '*' } : {})
    const chat = { project: 'p', head: 'h', started_at: 1, ended_at: 2, turns: [{ id: 't1', at: 1, passages: ['x'] }] }
    for (const n of ['root', 'a1', 'a2', 'ed']) for (const s of ['s1', 's2']) assert.equal((await t.req(t.tokens[n]!, `/v1/chats/${s}`, 'PUT', chat, { 'if-match': '*' })).status, 200)
    for (const [who, code] of [['a2', 'forbidden'], ['root', 'owner_protected']]) {
      for (const [path, method, body] of [[`/v1/chats/${who}/s1`, 'DELETE'], [`/v1/shared-projects/${who}/p`, 'PATCH', { status: 'paused' }], [`/v1/shared-projects/${who}/p`, 'DELETE']] as const) {
        const r = await as('a1', path, method, body)
        assert.equal(r.status, 403, `${method} ${path}`)
        assert.equal((await r.json()).error.code, code)
      }
    }
    const left = await (await as('root', '/v1/shared-projects')).json()
    assert.deepEqual(left.projects.filter((x: any) => x.owner !== 'ed').map((x: any) => [x.owner, x.status, x.chats]), [['a1', 'active', 2], ['a2', 'active', 2], ['root', 'active', 2]], 'nothing changed')
    assert.equal((await as('a1', '/v1/chats/ed/s1', 'DELETE')).status, 200, 'an admin unshares an editor')
    assert.equal((await as('a1', '/v1/shared-projects/ed/p', 'PATCH', { status: 'paused' })).status, 200, 'and pauses them')
    assert.equal((await as('ed', '/v1/shared-projects/ed/p', 'PATCH', { status: 'active' })).status, 200, 'a member acts on their own')
    assert.equal((await as('a1', '/v1/shared-projects/a1/p', 'PATCH', { status: 'paused' })).status, 200)
    assert.equal((await as('root', '/v1/chats/a2/s1', 'DELETE')).status, 200, 'the owner acts on anyone')
    assert.equal((await as('root', '/v1/shared-projects/a2/p', 'PATCH', { status: 'paused' })).status, 200)
    assert.equal((await as('root', '/v1/shared-projects/a2/p', 'DELETE')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h item 2: team invite --days week fails and leaves no member row', async () => {
  const dir = tmp('days')
  const flags = (days: string) => (n: string) => (n === 'dir' ? dir : n === 'days' ? days : undefined)
  for (const days of ['week', '0', '-3', 'Infinity', '1e20']) assert.equal(await teamMain(['team', 'invite', 'bob'], flags(days)), 2, days)
  const db = openTeamDb(dir)
  try {
    assert.deepEqual(listMembers(db), [])
    for (const at of [NaN, Infinity, 9e15]) assert.throws(() => invite(db, 'bob', at), /expiry/)
    assert.deepEqual(listMembers(db), [], 'the server function refuses before any write')
    // A failed invite row takes the member row with it.
    db.exec('DROP TABLE invites')
    assert.throws(() => invite(db, 'carol'))
    assert.deepEqual(listMembers(db), [])
  } finally {
    db.close()
  }
})

test('GHSA-qr4h item 2: a member row left with no expiry never yields a token that never expires', async () => {
  const t = await team(['root', 'bob'])
  try {
    const db = openTeamDb(t.dir)
    db.exec("UPDATE members SET expires_at = NULL")
    const tok = rotate(db, 'bob')
    db.close()
    const year = Date.now() + 365 * 864e5
    const exp = (n: string) => {
      const d = openTeamDb(t.dir)
      const e = listMembers(d).find((x) => x.name === n)!.expires_at
      d.close()
      return e
    }
    assert.ok(exp('bob')! > Date.now() && exp('bob')! <= year + 60000, `bob expires_at ${exp('bob')}`)
    assert.equal((await t.req(tok, '/v1/me')).status, 200)
    const r = await (await t.req(t.tokens.root!, `/v1/members/${t.ids.root}/rotate`, 'POST')).json()
    assert.ok(r.token)
    assert.ok(exp('root')! > Date.now() && exp('root')! <= year + 60000, 'the HTTP rotate too')
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h item 3: a 3.75 MB chat counts its full size against the quota', async () => {
  const t = await team(['root'])
  try {
    const paths = Array.from({ length: 200 }, (_, j) => `src/${'a'.repeat(480)}/${j}.ts`)
    const prs = Array.from({ length: 20 }, (_, j) => `https://github.com/o/r/pull/${j}${'9'.repeat(260)}`)
    const body = { project: 'p', head: 'h', started_at: 1, ended_at: 2, turns: Array.from({ length: 36 }, (_, i) => ({ id: `t${i}`, at: 1, line: 'l'.repeat(300), passages: ['x'], paths, prs, dead_text: 'd'.repeat(160) })) }
    const size = Buffer.byteLength(JSON.stringify(body))
    assert.ok(size > 3.7e6 && size < 4 * 1024 * 1024, String(size))
    assert.equal((await t.req(t.tokens.root!, '/v1/chats/big', 'PUT', body, { 'if-match': '*' })).status, 200)
    const bytes = (await (await t.req(t.tokens.root!, '/v1/chats?since=0&mine=only')).json()).chats[0].bytes
    assert.ok(bytes >= size * 0.95, `counted ${bytes} of ${size}`)
    const db = openTeamDb(t.dir)
    const m = db.prepare("SELECT id, team_id FROM members WHERE name = 'root'").get() as { id: string; team_id: string }
    db.prepare("INSERT INTO chats (team_id, owner_id, owner, project, session, rev, started_at, ended_at, head, turns, bytes, updated_at) VALUES (?, ?, 'root', 'p', 'fat', 1, 0, 0, '', 0, ?, 0)").run(m.team_id, m.id, CHAT_QUOTA - bytes - 1e6)
    db.close()
    assert.equal((await t.req(t.tokens.root!, '/v1/chats/big2', 'PUT', body, { 'if-match': '*' })).status, 413, 'the quota sees the full size')
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h items 3 and 5: rows stored before the fix are counted in full and their times capped', async () => {
  const t = await team(['root'])
  const body = { project: 'p', head: 'h', started_at: 1, ended_at: 2, turns: [{ id: 't1', at: 1, line: 'l', passages: ['one', 'two'], paths: ['src/a.ts'], prs: ['https://github.com/o/r/pull/1'], shas: ['abc1234'], dead_end: true, dead_kind: 'tried', dead_text: 'it broke' }] }
  try {
    assert.equal((await t.req(t.tokens.root!, '/v1/chats/s1', 'PUT', body, { 'if-match': '*' })).status, 200)
  } finally {
    await t.app.close()
  }
  const db = new DatabaseSync(join(t.dir, 'team.db'))
  const want = (db.prepare('SELECT bytes FROM chats').get() as { bytes: number }).bytes
  assert.ok(want > 60, `a push counts paths, links and lines too: ${want}`)
  db.exec(`UPDATE chats SET bytes = 6, ended_at = 9e15; UPDATE chat_passages SET at = 9e15; UPDATE members SET expires_at = 9e15;
    INSERT INTO invites (code_hash, team_id, role, created_by, expires_at) SELECT 'h', id, 'admin', 'not-the-owner', 9e15 FROM teams;
    PRAGMA user_version = 5`)
  db.close()
  const again = openTeamDb(t.dir)
  assert.equal((again.prepare('SELECT bytes FROM chats').get() as { bytes: number }).bytes, want, 'the migration counts what a push counts')
  assert.deepEqual({ ...(again.prepare('SELECT max(c.ended_at) e, max(p.at) a, (SELECT max(expires_at) FROM members) x, (SELECT count(*) FROM invites WHERE used_by IS NULL) i FROM chats c, chat_passages p').get() as object) }, { e: 8.64e15, a: 8.64e15, x: 8.64e15, i: 0 })
  again.close()
})

test('GHSA-qr4h item 4: past the sign-in limit a wrong token gets 429 with Retry-After and one log line a window; the right token works', async (tt) => {
  let clock = Date.now()
  const t = await team(['root'], {}, () => clock)
  const err = tt.mock.method(console, 'error', () => undefined)
  try {
    const lines = () => err.mock.calls.map((c) => String(c.arguments[0])).filter((l) => /sign-in/.test(l))
    for (let i = 0; i < 20; i++) assert.equal((await t.req(`tw_bad${i}`, '/v1/me')).status, 401)
    const r = await t.req('tw_bad20', '/v1/me')
    assert.equal(r.status, 429)
    assert.ok(Number(r.headers.get('retry-after')) >= 1 && Number(r.headers.get('retry-after')) <= 60)
    for (let i = 0; i < 5; i++) assert.equal((await t.req(null, '/v1/session', 'POST', { token: `tw_more${i}` })).status, 429)
    assert.equal((await t.req(t.tokens.root!, '/v1/me')).status, 200, 'a good token still works')
    assert.equal((await t.req(null, '/v1/session', 'POST', { token: t.tokens.root })).status, 200)
    assert.equal(lines().length, 1, lines().join('\n'))
    assert.ok(!lines()[0]!.includes('tw_bad') && !lines()[0]!.includes('tw_more'), 'no token in the log')
    clock += 60_000
    for (let i = 0; i < 21; i++) await t.req(`tw_next${i}`, '/v1/me')
    assert.equal(lines().length, 2, 'one line for the next window')
  } finally {
    await t.app.close()
  }
})

test('GHSA-qr4h item 5: a time past the largest date is a 400 naming the field', async () => {
  const t = await team(['root', 'bob'])
  try {
    const chat = (over: Record<string, unknown>, at = 1) => ({ project: 'p', head: 'h', started_at: 1, ended_at: 2, turns: [{ id: 't1', at, passages: ['x'] }], ...over })
    for (const [body, field] of [[chat({}, 9e15), 'turns[0].at'], [chat({ started_at: 9e15 }), 'started_at'], [chat({ ended_at: 9e15 }), 'ended_at']] as const) {
      const r = await t.req(t.tokens.root!, '/v1/chats/s1', 'PUT', body, { 'if-match': '*' })
      assert.equal(r.status, 400)
      assert.ok((await r.json()).error.message.includes(field), field)
    }
    assert.equal((await t.req(t.tokens.root!, '/v1/chats/s1', 'PUT', chat({}, 8.64e15), { 'if-match': '*' })).status, 200, 'the largest date itself is fine')
    const p = await t.req(t.tokens.root!, `/v1/members/${t.ids.bob}`, 'PATCH', { expires_at: 9e15 })
    assert.equal(p.status, 400)
    assert.match((await p.json()).error.message, /expires_at/)
  } finally {
    await t.app.close()
  }
})
