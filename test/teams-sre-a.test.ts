// SRE wave A: rotate follows rank, restore checks its source, removal writes tombs, the server masks, failed sign-ins are counted.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { fetchShared, joinTeam, readCache, share } from '../src/teams/client.ts'
import { backupTeam, createTeamServer, invite, openTeamDb, removeMember, restoreTeam, rotate } from '../src/teams/server.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `twa-${p}-`))
const NOTE = { title: 'Cache plan', text: 'Eight shards for the exporter.', project: 'alpha' }

async function team(names: string[], roles: Record<string, string> = {}) {
  const dir = tmp('srv')
  const app = createTeamServer({ dir })
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
  const t = await team(['root'])
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
