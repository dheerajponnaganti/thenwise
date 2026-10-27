import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { backupTeam, createTeamServer, invite, LIMITS, openTeamDb, removeMember, restoreTeam } from '../src/teams/server.ts'
import { migrateTeamDb } from '../src/teams/schema.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw17-${p}-`))
async function team(names = ['alice', 'bob'], roles: Record<string, string> = {}, now?: () => number) {
  const dir = tmp('srv')
  const app = createTeamServer({ dir, version: 'test', now })
  const { port } = await app.listen()
  const db = openTeamDb(dir)
  const tokens: Record<string, string> = Object.fromEntries(names.map((n) => [n, invite(db, n, undefined, roles[n] ? { role: roles[n] } : {})]))
  db.close()
  const req = (token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })

  return { dir, app, tokens, req }
}
const turn = (i: number, text = `turn ${i} about shards and caches`) => ({ id: `t${i}`, at: 1000 + i, line: `prompt ${i}`, passages: [text, `${text} second piece`], paths: ['src/a.ts'], shas: ['abc1234'], prs: ['https://github.com/o/r/pull/1'], dead_end: i === 3, dead_kind: i === 3 ? 'tried' : '' })
const unit = (n = 40, over: Record<string, unknown> = {}) => ({ project: 'org/alpha', head: 'first prompt', started_at: 1000, ended_at: 5000, mask: 1, turns: Array.from({ length: n }, (_, i) => turn(i)), ...over })
const push = (t: Awaited<ReturnType<typeof team>>, who: string, session: string, body: unknown, match = '*') => t.req(t.tokens[who]!, `/v1/chats/${session}`, { method: 'PUT', body, headers: { 'if-match': match } })
const count = (dir: string, sql: string) => {
  const db = openTeamDb(dir)
  try {
    return Number((db.prepare(sql).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

test('T17-H1: a pushed unit is fed to the other member with every passage, never to its owner', async () => {
  const t = await team()
  try {
    assert.equal((await push(t, 'alice', 's1', unit())).status, 200)
    const feed = (await (await t.req(t.tokens.bob!, '/v1/chats?since=0&full=1')).json()).chats
    assert.equal(feed.length, 1)
    assert.equal(feed[0].turns.length, 40)
    assert.deepEqual(feed[0].turns[3], { id: 't3', at: 1003, line: 'prompt 3', kind: 'turn', passages: ['turn 3 about shards and caches', 'turn 3 about shards and caches second piece'], paths: ['src/a.ts'], shas: ['abc1234'], prs: ['https://github.com/o/r/pull/1'], dead_end: true, dead_kind: 'tried', dead_text: '' })
    assert.equal((await (await t.req(t.tokens.alice!, '/v1/chats?since=0')).json()).chats.length, 0)
    assert.equal((await t.req(t.tokens.bob!, '/v1/chats/alice/s1')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('T17-H2: a re-push with a higher seq replaces the passages in one revision', async () => {
  const t = await team()
  try {
    const rev1 = (await (await push(t, 'alice', 's1', unit(5))).json()).rev
    const r2 = await push(t, 'alice', 's1', { ...unit(2, { mask: 2 }), seq: 2 }, String(rev1))
    const rev2 = (await r2.json()).rev
    assert.ok(rev2 > rev1)
    assert.equal((await push(t, 'alice', 's1', unit(2), String(rev1))).status, 409)
    const feed = (await (await t.req(t.tokens.bob!, `/v1/chats?since=${rev1}&full=1`)).json()).chats
    assert.deepEqual([feed.length, feed[0].rev, feed[0].mask, feed[0].turns.length], [1, rev2, 2, 2])
    assert.equal(count(t.dir, 'SELECT count(*) n FROM chat_passages'), 4)
  } finally {
    await t.app.close()
  }
})

test('T17-H3: search groups by chat, best passage first, with a snippet', async () => {
  const t = await team()
  try {
    await push(t, 'alice', 's1', unit(3))
    await push(t, 'alice', 's2', unit(1, { turns: [{ id: 'x', at: 1, passages: ['unrelated gardening words'] }] }))
    const hits = (await (await t.req(t.tokens.bob!, '/v1/chats/search?q=shards')).json()).chats
    assert.equal(hits.length, 1)
    assert.equal(hits[0].session, 's1')
    assert.match(hits[0].snippet, /\*\*shards\*\*/)
    assert.equal((await (await t.req(t.tokens.bob!, '/v1/chats/search?q=shards&project=none')).json()).chats.length, 0)
  } finally {
    await t.app.close()
  }
})

test('T17-H4: unsharing deletes rows, search entries and read counts, leaves tombs in order, audits without text', async () => {
  const t = await team()
  try {
    await push(t, 'alice', 's1', unit(3))
    await push(t, 'alice', 's2', unit(3))
    await push(t, 'alice', 's3', unit(3, { project: 'org/beta' }))
    assert.equal((await t.req(t.tokens.alice!, '/v1/chats/s1', { method: 'DELETE', headers: { 'if-match': '*' } })).status, 200)
    const gone = await (await t.req(t.tokens.alice!, '/v1/shared-projects/alice/org%2Falpha', { method: 'DELETE' })).json()
    assert.equal(gone.chats, 1)
    const tombs = (await (await t.req(t.tokens.bob!, '/v1/chat-tombs?since=0')).json()).tombs
    assert.deepEqual(tombs.map((x: any) => x.session), ['s1', 's2'])
    assert.ok(tombs[0].rev < tombs[1].rev)
    assert.equal(count(t.dir, "SELECT count(*) n FROM chat_passages WHERE session != 's3'"), 0)
    assert.equal(count(t.dir, "SELECT count(*) n FROM chat_fts WHERE chat_fts MATCH 'shards'"), 6, 'only the beta chat is left in the index')
    const db = openTeamDb(t.dir)
    const rows = db.prepare("SELECT action, details FROM audit WHERE action LIKE 'chat.%' OR action LIKE 'project.%'").all() as any[]
    db.close()
    assert.ok(rows.some((r) => r.action === 'chat.unshare') && rows.some((r) => r.action === 'chat.share'))
    assert.ok(rows.every((r) => !/shards/.test(r.details)))
  } finally {
    await t.app.close()
  }
})

test('T17-H5: retention deletes older chats with tombs at the next sweep, ', async () => {
  let clock = 1_800_000_000_000
  const t = await team(['alice', 'bob'], {}, () => clock)
  try {
    await push(t, 'alice', 'old', unit(2, { started_at: clock - 40 * 864e5, ended_at: clock - 40 * 864e5 }))
    await push(t, 'alice', 'new', unit(2, { started_at: clock, ended_at: clock }))
    assert.equal((await t.req(t.tokens.alice!, '/v1/chat-settings', { method: 'PATCH', body: { chat_retention_days: 30 } })).status, 200)
    assert.equal((await t.req(t.tokens.bob!, '/v1/chat-settings')).status, 403)
    clock += 864e5
    await t.req(t.tokens.bob!, '/v1/chats?since=0')
    const tombs = (await (await t.req(t.tokens.bob!, '/v1/chat-tombs?since=0')).json()).tombs
    assert.deepEqual(tombs.map((x: any) => x.session), ['old'])
    assert.equal(count(t.dir, 'SELECT count(*) n FROM chats'), 1)
  } finally {
    await t.app.close()
  }
})

test('T17-H6: migration 3 keeps every note and member of a schema 2 file, and backup and restore carry the chat tables', async () => {
  const dir = tmp('mig')
  const db = new DatabaseSync(join(dir, 'team.db'))
  migrateTeamDb(db) // all three
  db.close()
  // Rebuild a 0.1.16 file: drop what 3 added.
  const old = new DatabaseSync(join(dir, 'team.db'))
  old.exec('DROP TABLE chat_fts; DROP TABLE chat_passages; DROP TABLE chats; DROP TABLE chat_tombs; DROP TABLE shared_projects; DROP TABLE chat_reads; ALTER TABLE teams DROP COLUMN chat_retention_days; PRAGMA user_version = 2')
  old.close()
  const live = await createTeamServer({ dir }) // opens and migrates in place
  await live.close()
  const t = { dir, tokens: {} as Record<string, string> }
  const d = openTeamDb(dir)
  t.tokens.alice = invite(d, 'alice')
  d.close()
  assert.equal(count(dir, 'SELECT user_version n FROM pragma_user_version'), 4)
  const app = createTeamServer({ dir })
  const { port } = await app.listen()
  const r = await fetch(`http://127.0.0.1:${port}/v1/chats/s1`, { method: 'PUT', headers: { authorization: `Bearer ${t.tokens.alice}`, 'if-match': '*', 'content-type': 'application/json' }, body: JSON.stringify(unit(2)) })
  assert.equal(r.status, 200)
  await app.close()
  const file = join(tmp('bak'), 'backup.db')
  backupTeam(dir, file)
  const dir2 = tmp('restore')
  assert.equal(restoreTeam(dir2, file).schema, 4)
  assert.equal(count(dir2, 'SELECT count(*) n FROM chat_passages'), 4)
  assert.equal(count(dir2, "SELECT count(*) n FROM chat_fts WHERE chat_fts MATCH 'shards'"), 4)
  assert.ok(existsSync(file))
})

test('T17-B1: a unit with an absolute path, a cwd, 2001 passages or 3 MB is a 400 naming the field, and nothing is stored', async () => {
  const t = await team()
  try {
    const cases: [unknown, RegExp][] = [
      [unit(1, { turns: [{ id: 'a', at: 1, passages: ['x'], paths: ['/Users/me/a.ts'] }] }), /paths/],
      [unit(1, { turns: [{ id: 'a', at: 1, passages: ['x'], paths: ['../a.ts'] }] }), /paths/],
      [{ ...unit(1), cwd: '/Users/me' }, /cwd/],
      [unit(1, { turns: Array.from({ length: 2001 }, (_, i) => ({ id: `t${i}`, at: 1, passages: ['x'] })) }), /passages/],
      [unit(1, { turns: [{ id: 'big', at: 1, passages: ['z'.repeat(1201)] }] }), /1200/],
      [unit(1, { turns: Array.from({ length: 1800 }, (_, i) => ({ id: `t${i}`, at: 1, passages: ['z'.repeat(1200)] })) }), /bytes/],
    ]
    for (const [body, re] of cases) {
      const r = await push(t, 'alice', 'bad', body)
      assert.equal(r.status, 400)
      assert.match((await r.json()).error.message, re)
    }
    assert.equal(count(t.dir, 'SELECT count(*) n FROM chats'), 0)
  } finally {
    await t.app.close()
  }
})

test('T17-B2: a member over the 200 MB quota is refused with code quota, and the audit says so', async () => {
  const t = await team()
  try {
    const db = openTeamDb(t.dir)
    const m = db.prepare("SELECT id, team_id FROM members WHERE name = 'alice'").get() as any
    db.prepare("INSERT INTO chats (team_id, owner_id, owner, project, session, rev, started_at, ended_at, head, turns, bytes, updated_at) VALUES (?, ?, 'alice', 'p', 'fat', 1, 0, 0, '', 0, ?, 0)").run(m.team_id, m.id, 200 * 1024 * 1024 - 10)
    db.close()
    const r = await push(t, 'alice', 's1', unit(1))
    assert.equal(r.status, 413)
    assert.equal((await r.json()).error.code, 'quota')
    assert.equal(count(t.dir, "SELECT count(*) n FROM audit WHERE action = 'chat.quota'"), 1)
  } finally {
    await t.app.close()
  }
})

test('T17-B3: a viewer cannot push and a member cannot delete another member\'s chat; both are audited', async () => {
  const t = await team(['alice', 'bob', 'vic'], { vic: 'viewer' })
  try {
    await push(t, 'alice', 's1', unit(1))
    assert.equal((await push(t, 'vic', 's2', unit(1))).status, 403)
    assert.equal((await t.req(t.tokens.bob!, '/v1/chats/alice/s1', { method: 'DELETE', headers: { 'if-match': '*' } })).status, 403)
    assert.equal((await t.req(t.tokens.bob!, '/v1/shared-projects/alice/org%2Falpha', { method: 'DELETE' })).status, 403)
    assert.equal(count(t.dir, "SELECT count(*) n FROM audit WHERE action = 'denied'"), 3)
    assert.equal((await t.req(t.tokens.vic!, '/v1/chats?since=0')).status, 200, 'a viewer reads')
    assert.equal((await t.req(t.tokens.alice!, '/v1/chats/alice/s1', { method: 'DELETE', headers: { 'if-match': '*' } })).status, 200, 'the owner of the team is an admin')
    assert.equal(count(t.dir, "SELECT count(*) n FROM audit WHERE action = 'chat.admin_unshare'"), 0, 'own chat through the long path is an own unshare')
  } finally {
    await t.app.close()
  }
})

test('T17-B4: the 61st chat push in a minute is a 429 with Retry-After, and reads are unaffected', async () => {
  const t = await team()
  try {
    const small = unit(1, { turns: [{ id: 'a', at: 1, passages: ['x'] }] })
    let last = 200
    for (let i = 0; i <= LIMITS.writes; i++) last = (await push(t, 'alice', `s${i}`, small)).status
    assert.equal(last, 429)
    const again = await push(t, 'alice', 'more', small)
    assert.ok(again.headers.get('retry-after'))
    assert.equal((await t.req(t.tokens.alice!, '/v1/chats?since=0')).status, 200)
  } finally {
    await t.app.close()
  }
})

test('T17-B6: a secret in a pushed passage is stored masked by the server (SRE-09)', async () => {
  const t = await team()
  try {
    await push(t, 'alice', 's1', unit(1, { turns: [{ id: 'a', at: 1, passages: ['key sk-live-1234567890abcdef'] }] }))
    const c = await (await t.req(t.tokens.bob!, '/v1/chats/alice/s1')).json()
    assert.equal(c.turns[0].passages[0], 'key [secret masked]')
  } finally {
    await t.app.close()
  }
})

test('removing a member with delete drops their chats with tombs; keep leaves them readable', async () => {
  const t = await team(['alice', 'bob', 'cy'])
  try {
    await push(t, 'bob', 's1', unit(1))
    await push(t, 'cy', 's2', unit(1))
    await t.app.close()
    const db = openTeamDb(t.dir)
    removeMember(db, 'bob', false)
    removeMember(db, 'cy', true)
    db.close()
    assert.equal(count(t.dir, "SELECT count(*) n FROM chats WHERE owner = 'bob'"), 0)
    assert.equal(count(t.dir, "SELECT count(*) n FROM chat_tombs WHERE owner = 'bob'"), 1)
    assert.equal(count(t.dir, "SELECT count(*) n FROM chats WHERE owner = 'cy'"), 1)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

test('GET /v1/chats mine: exclude (default) hides the caller, include adds them, only keeps them, anything else is a 400', async () => {
  const t = await team()
  try {
    await push(t, 'alice', 'a1', unit(1))
    await push(t, 'bob', 'b1', unit(1))
    const ids = async (q: string) => (await (await t.req(t.tokens.alice!, `/v1/chats?since=0${q}`)).json()).chats.map((c: any) => c.session).sort()
    assert.deepEqual(await ids(''), ['b1'])
    assert.deepEqual(await ids('&mine=exclude'), ['b1'])
    assert.deepEqual(await ids('&mine=include'), ['a1', 'b1'])
    assert.deepEqual(await ids('&mine=only'), ['a1'])
    const r = await t.req(t.tokens.alice!, '/v1/chats?mine=all')
    assert.equal(r.status, 400)
    assert.match((await r.json()).error.message, /mine/)
  } finally {
    await t.app.close()
  }
})
