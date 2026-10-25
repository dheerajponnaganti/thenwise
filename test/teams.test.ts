// Teams preview: one server on a temp port, two users on two temp data folders.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { checkUrl, flush, locked, joinTeam, payloadOf, search, share, sharedIds, unshare } from '../src/teams/client.ts'
import { createTeamServer, invite, openTeamDb, removeMember } from '../src/teams/server.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw-${p}-`))
const CHAT = 'zebra-chat-line: my private chat about the layoff plan'
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
const PRIVATE = 'private-gryphon-note'

let serverDir: string, app: ReturnType<typeof createTeamServer>, base: string, port: number
let a: string, b: string, tokenA: string, tokenB: string
const sent: string[] = []
const realFetch = globalThis.fetch

const get = (token: string | null, path: string, method = 'GET') => realFetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })
const note = (home: string, name: string, body: string) => {
  const p = join(home, `${name}.md`)
  writeFileSync(p, `---\ntitle: ${name}\nproject: alpha\n---\n${body}\n`)

  return p
}

before(async () => {
  serverDir = tmp('srv')
  app = createTeamServer({ dir: serverDir })
  const r = await app.listen()
  port = r.port
  base = `http://127.0.0.1:${port}`
  const db = openTeamDb(serverDir)
  tokenA = invite(db, 'alice')
  tokenB = invite(db, 'bob')
  db.close()
  a = tmp('a')
  b = tmp('b')
  // Alice's machine holds a raw chat. Her side's requests are recorded.
  mkdirSync(join(a, 'claude/projects/p'), { recursive: true })
  writeFileSync(join(a, 'claude/projects/p/s.jsonl'), JSON.stringify({ text: CHAT }))
  globalThis.fetch = (async (url: any, init: any) => {
    if (init?.headers?.authorization === `Bearer ${tokenA}`) sent.push(`${init.method} ${url} ${init.body ?? ''}`)

    return realFetch(url, init)
  }) as typeof fetch
  await joinTeam(a, base, tokenA)
  await joinTeam(b, base, tokenB)
})
after(async () => {
  globalThis.fetch = realFetch
  await app.close()
})

describe('teams preview', () => {
  test('T-H1: one team, one token per person', async () => {
    assert.notEqual(tokenA, tokenB)
    assert.equal(((await (await get(tokenA, '/me')).json()) as any).name, 'alice')
    assert.equal(((await (await get(tokenB, '/me')).json()) as any).name, 'bob')
    const db = openTeamDb(serverDir)
    assert.throws(() => invite(db, 'alice'), /already a member/)
    assert.throws(() => invite(db, 'x; drop'), /lower-case/)
    db.close()
  })

  test('T-H2, T-B6: a shared note is previewed, masked again at send time, and B can find it', async () => {
    // The secret sits in a note that the first mask never saw.
    const p = note(a, 'shared-one', `Use the heron gateway. key ${SECRET} was rotated.`)
    const { payload, masked } = payloadOf({ title: 'shared-one', text: readFileSync(p, 'utf8'), project: 'alpha' })
    assert.ok(masked >= 1)
    assert.ok(!JSON.stringify(payload).includes(SECRET))
    await share(a, 'sh1', { title: 'Heron gateway', text: readFileSync(p, 'utf8'), project: 'alpha' })
    const found = await search(b, 'heron gateway')
    assert.equal(found.length, 1)
    assert.match(found[0]!, /alice\/sh1/)
    const full = (await (await get(tokenB, '/notes/alice/sh1')).json()) as any
    assert.ok(full.text.includes('heron') && !full.text.includes(SECRET))
  })

  test('T-H3, T-H4: unshare and forget delete on the server', async () => {
    await share(a, 'sh2', { title: 'Temp', text: 'cormorant text', project: '' })
    assert.equal((await get(tokenB, '/notes/alice/sh2')).status, 200)
    await unshare(a, 'sh2')
    assert.equal((await get(tokenB, '/notes/alice/sh2')).status, 404)
    assert.equal((await search(b, 'cormorant')).length, 0)
    // Forget removes a note's shares through the same call.
    await share(a, 'sh3', { title: 'Temp', text: 'cormorant again', project: '' })
    await unshare(a, 'sh3')
    assert.equal((await search(b, 'cormorant')).length, 0)
    assert.ok(!sharedIds(a).includes('sh3'))
  })

  test('T-B1: B never fetches A private notes by any route', async () => {
    // A has private notes that were never shared; only sh1 is on the server.
    const bodies: string[] = []
    const seen = async (token: string, path: string) => {
      const r = await get(token, path)
      bodies.push(await r.text())

      return r.status
    }
    assert.equal(await seen(tokenB, `/notes/alice/${PRIVATE}`), 404)
    assert.equal(await seen(tokenB, `/notes/${PRIVATE}`), 404)
    assert.equal(await seen(tokenB, `/notes/alice/..%2F${PRIVATE}`), 404)
    for (const id of ['1', 'note-1', 'sh9', 'f-0000000000', 'x']) assert.equal(await seen(tokenB, `/notes/alice/${id}`), 404)
    await seen(tokenB, `/search?q=${PRIVATE}`)
    await seen(tokenB, '/search?q=gryphon')
    // Paging sees only shared rows.
    for (const off of [0, 1, 2, 50, 1000]) await seen(tokenB, `/notes?limit=50&offset=${off}`)
    await seen(tokenB, '/notes?limit=-5&offset=-1')
    assert.ok(!bodies.join('').includes(PRIVATE))
    assert.ok(!bodies.join('').includes('gryphon'))
    // B cannot write or delete in A's namespace: the owner is always the caller.
    await realFetch(`${base}/notes/sh1?rev=${Date.now() + 1e9}`, { method: 'DELETE', headers: { authorization: `Bearer ${tokenB}` } })
    assert.equal((await get(tokenB, '/notes/alice/sh1')).status, 200)
  })

  test('T-B2, T-B6: nothing sent from A contains chat text or an unmasked secret', async () => {
    const p = note(a, 'with-secret', `plain text and ${SECRET}`)
    const { payload } = payloadOf({ title: 'with-secret', text: readFileSync(p, 'utf8'), project: 'alpha' })
    await share(a, 'sh4', payload)
    assert.ok(sent.length >= 4)
    for (const s of sent) {
      assert.ok(!s.includes('zebra-chat-line'), s)
      assert.ok(!s.includes('layoff'), s)
      assert.ok(!s.includes(SECRET), s)
    }
    // The CLI refuses a chat file outright.
    const r = spawnSync(process.execPath, ['src/main.ts', 'share', join(a, 'claude/projects/p/s.jsonl'), '--yes'], { env: { ...process.env, THENWISE_HOME: a }, encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /only Markdown|chat/)
  })

  test('T-B3: no, wrong, expired or revoked tokens get 401 and no data', async () => {
    const db = openTeamDb(serverDir)
    const expired = invite(db, 'carol', Date.now() - 1000)
    db.close()
    for (const t of [null, 'tw_wrong', '', expired]) {
      const r = await get(t, '/notes')
      assert.equal(r.status, 401)
      assert.deepEqual(await r.json(), { error: 'unauthorized' })
    }
    assert.equal((await realFetch(`${base}/notes`, { headers: { authorization: 'Basic abc' } })).status, 401)
  })

  test('T-B4: a removed member stops at once', async () => {
    const db = openTeamDb(serverDir)
    const t = invite(db, 'dave')
    assert.equal((await get(t, '/me')).status, 200)
    assert.ok(removeMember(db, 'dave').removed)
    db.close()
    assert.equal((await get(t, '/me')).status, 401)
  })

  test('T-B4: remove can keep or delete the notes; the CLI needs a flag without a terminal', async () => {
    const db = openTeamDb(serverDir)
    const tk = invite(db, 'kim')
    const td = invite(db, 'lee')
    for (const [t, id] of [[tk, 'kn1'], [td, 'ln1']] as const) await realFetch(`${base}/notes/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: id, text: 'osprey body', project: '', rev: 1 }) })
    assert.deepEqual(removeMember(db, 'kim', true), { removed: true, notes: 1 })
    assert.deepEqual(removeMember(db, 'lee'), { removed: true, notes: 1 })
    db.close()
    assert.equal((await get(tk, '/me')).status, 401)
    assert.equal((await get(tokenB, '/notes/kim/kn1')).status, 200)
    assert.equal((await get(tokenB, '/notes/lee/ln1')).status, 404)
    const run = (...args: string[]) => spawnSync(process.execPath, ['src/main.ts', 'team', 'remove', ...args, '--dir', serverDir], { env: { ...process.env, THENWISE_HOME: a }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(run('zed').status, 2)
    assert.equal(run('zed', '--keep-notes', '--delete-notes').status, 2)
    assert.match(run('--keep-notes', 'zed').stdout, /zed is not a member/)
  })

  test('T-B5: SQL in queries and ids is text', async () => {
    for (const q of ["'; DROP TABLE notes; --", "\" OR 1=1 --", "x' UNION SELECT token_hash FROM members --"]) {
      const r = await get(tokenB, `/search?q=${encodeURIComponent(q)}`)
      assert.equal(r.status, 200)
      assert.ok(!(await r.text()).includes('"owner"'))
    }
    for (const id of ["x' OR '1'='1", '1; DROP TABLE notes', '%27%20OR%201=1']) {
      assert.ok([400, 404].includes((await get(tokenB, `/notes/alice/${encodeURIComponent(id)}`)).status))
      assert.equal((await get(tokenA, `/notes/${encodeURIComponent(id)}`, 'DELETE')).status, 400)
    }
    assert.equal((await get(tokenB, '/notes/alice/sh1')).status, 200)
  })

  test('T-B7: server down, local work continues, shares wait and retry', async () => {
    const dir = tmp('srv2')
    const s2 = createTeamServer({ dir })
    const { port: p2 } = await s2.listen()
    const db = openTeamDb(dir)
    const tok = invite(db, 'erin')
    db.close()
    const home = tmp('e')
    await joinTeam(home, `http://127.0.0.1:${p2}`, tok)
    await s2.close()
    const t0 = Date.now()
    const msg = await share(home, 'w1', { title: 'Waiting', text: 'kestrel text', project: '' })
    assert.match(msg, /waiting/)
    assert.ok(Date.now() - t0 < 4000)
    assert.equal(JSON.parse(readFileSync(join(home, 'team.json'), 'utf8')).queue.length, 1)
    const s3 = createTeamServer({ dir, port: p2 })
    await s3.listen()
    // Async spawn: the test server lives in this process and must keep answering.
    const code = await new Promise((res) => spawn(process.execPath, ['src/main.ts', 'hook', 'sync-run'], { env: { ...process.env, HOME: home, THENWISE_HOME: home }, stdio: 'ignore' }).on('exit', res))
    assert.equal(code, 0)
    assert.equal(JSON.parse(readFileSync(join(home, 'team.json'), 'utf8')).queue.length, 0)
    assert.equal((await realFetch(`http://127.0.0.1:${p2}/notes/erin/w1`, { headers: { authorization: `Bearer ${tok}` } })).status, 200)
    await s3.close()
  })

  test('T-B10: the queue lock waits, and a dead holder is taken over', () => {
    const d = tmp('lk')
    writeFileSync(join(d, 'team.lock'), '999999999')
    assert.equal(locked(d, () => 7), 7)
    assert.ok(!existsSync(join(d, 'team.lock')))
    writeFileSync(join(d, 'team.lock'), String(process.pid))
    const t0 = Date.now()
    assert.throws(() => locked(d, () => 0), /busy/)
    assert.ok(Date.now() - t0 >= 1900)
  })

  test('T-B8: plain http to a host that is not localhost is refused', async () => {
    for (const u of ['http://example.com', 'http://192.168.1.5:8788', 'http://localhost.evil.com', 'ftp://localhost']) assert.throws(() => checkUrl(u), /refused/, u)
    for (const u of ['http://localhost:1', 'http://127.0.0.1:9', 'http://[::1]:9', 'https://team.example.com']) assert.doesNotThrow(() => checkUrl(u), u)
    await assert.rejects(joinTeam(tmp('h'), 'http://example.com', 'tw_x'), /refused/)
  })

  test('T-B9: share and unshare at the same moment end unshared', async () => {
    for (let i = 0; i < 10; i++) {
      const id = `race${i}`
      await Promise.all([share(a, id, { title: 'Race', text: 'ibis text', project: '' }), unshare(a, id)])
      assert.equal((await get(tokenB, `/notes/alice/${id}`)).status, 404, id)
    }
    // The server sees the delete first, then the older share.
    const rev = Date.now() + 5e6
    const h = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }
    await realFetch(`${base}/notes/late?rev=${rev}`, { method: 'DELETE', headers: h })
    const r = await realFetch(`${base}/notes/late`, { method: 'PUT', headers: h, body: JSON.stringify({ title: 't', text: 'x', project: '', rev: rev - 1 }) })
    assert.equal(r.status, 409)
    assert.equal((await get(tokenB, '/notes/alice/late')).status, 404)
  })

  test('T-8: a refused share is dropped and not marked shared; the team db is private', async () => {
    const r = await share(a, 'toolong', { title: 'T', text: 'x', project: 'p'.repeat(300) })
    assert.match(r, /refused: toolong \(400/)
    assert.ok(!sharedIds(a).includes('toolong'))
    assert.match(await flush(a), /nothing waiting/)
    assert.equal(statSync(join(serverDir, 'team.db')).mode & 0o077, 0)
  })

  test('the client file is private and the CLI says teams preview', () => {
    assert.equal(statSync(join(a, 'team.json')).mode & 0o077, 0)
    const r = spawnSync(process.execPath, ['src/main.ts', 'team', 'join', 'http://example.com', 'tw_x'], { env: { ...process.env, THENWISE_HOME: tmp('c') }, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /refused/)
    const u = spawnSync(process.execPath, ['src/main.ts', 'team'], { env: { ...process.env, THENWISE_HOME: tmp('c') }, encoding: 'utf8' })
    assert.match(u.stderr, /teams preview/)
  })
})
