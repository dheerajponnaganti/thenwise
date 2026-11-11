// Two tools on different Thenwise versions share one data folder (#137). Versions only move forward: a newer Thenwise
// upgrades once; an older one leaves what a newer one wrote as it is and says which tool to update. The current code
// plays the older Thenwise by finding versions one above its own in the stored data.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { takeNews } from '../src/core/notices.ts'
import { MASK_VERSION } from '../src/core/secrets.ts'
import { syncRun } from '../src/hooks/hook.ts'
import { STATE_VERSION, storeFormat } from '../src/ingest/ingest.ts'
import { fetchPrs } from '../src/ingest/prs.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { openChatCache } from '../src/teams/chatcache.ts'
import { fetchShared, readCache } from '../src/teams/client.ts'
import { importChats } from '../src/teams/export.ts'
import { tempDir } from './mcp-fixture.ts'
import { World } from './world.ts'

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`

/** Sets the STATE_VERSION a store says it was built with. */
function builtWith(db: string, v: number) {
  const d = new DatabaseSync(db)
  const sig = (d.prepare("SELECT value FROM ingest_state WHERE key = 'signature'").get() as { value: string }).value
  d.prepare("UPDATE ingest_state SET value = ? WHERE key = 'signature'").run(JSON.stringify({ ...JSON.parse(sig), v }))
  d.close()
}

function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    return f()
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

test('#137: an older Thenwise leaves a newer store alone, still reads it, and says which tool to update', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: 'zebra', reply: 'a zebra plan' }] })
    w.archive()
    w.ingest('graph.db')
    builtWith(w.path('graph.db'), STATE_VERSION + 1)
    w.chat('s2', { turns: [{ prompt: 'okapi', reply: 'an okapi plan' }] })
    w.archive()
    const bytes = readFileSync(w.path('graph.db'))
    withEnv({ COPILOT_PLUGIN_ROOT: '/plugin' }, () => assert.throws(() => w.ingest('graph.db'), /written by a newer Thenwise.*Update Thenwise/))
    assert.deepEqual(readFileSync(w.path('graph.db')), bytes, 'no rebuild and no update')
    assert.match(takeNews(w.memDir, 'all'), /another tool runs a newer Thenwise.*Update Thenwise in Copilot CLI/)
    assert.match(c.search(new Graph(w.path('graph.db')), 'zebra'), /zebra/)
  } finally {
    w.destroy()
  }
})

test('#137: a newer Thenwise relabels a 0.3.2 store with no rebuild, upgrades an older store once, then stays', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: 'zebra', reply: 'a zebra plan' }] })
    w.archive()
    w.ingest('graph.db')
    const d = new DatabaseSync(w.path('graph.db'))
    d.exec("UPDATE meta SET value = '2' WHERE key = 'format'") // what 0.3.2 wrote
    d.close()
    assert.notEqual(w.ingest('graph.db').mode, 'full')
    assert.equal(storeFormat(w.path('graph.db')), 3, '0.3.2 and older now refuse this store instead of rebuilding it')
    builtWith(w.path('graph.db'), STATE_VERSION - 1)
    assert.equal(w.ingest('graph.db').mode, 'full')
    assert.equal(w.ingest('graph.db').mode, 'unchanged')
    assert.equal(w.ingest('graph.db').mode, 'unchanged')
  } finally {
    w.destroy()
  }
})

test('#137: an older Thenwise leaves archive entries and the plan marker a newer one wrote', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: 'zebra', reply: 'a zebra plan' }] })
    w.archive()
    const mf = join(w.memDir, 'archive/manifest.json')
    const man = JSON.parse(readFileSync(mf, 'utf8'))
    const rel = Object.keys(man)[0]!
    man[rel].mask = MASK_VERSION + 1
    writeFileSync(mf, JSON.stringify(man))
    const gz = join(w.memDir, 'archive/sessions', `${rel}.gz`)
    const before = readFileSync(gz)
    w.grow('s1', [{ prompt: 'more zebra', reply: 'ok' }]) // a changed source would be archived again
    const plans = join(w.memDir, 'archive/plans/k/root/PLAN')
    mkdirSync(plans, { recursive: true })
    writeFileSync(join(plans, 'a.md'), `use ${KEY}`)
    writeFileSync(join(w.memDir, 'archive/plans/.mask'), String(MASK_VERSION + 1))
    const r = w.archive()
    assert.deepEqual([r.newer, r.archived, r.remasked], [2, 0, 0])
    assert.deepEqual(readFileSync(gz), before)
    assert.equal(JSON.parse(readFileSync(mf, 'utf8'))[rel].mask, MASK_VERSION + 1)
    assert.equal(readFileSync(join(plans, 'a.md'), 'utf8'), `use ${KEY}`, 'a newer mask was not undone')
    assert.equal(readFileSync(join(w.memDir, 'archive/plans/.mask'), 'utf8'), String(MASK_VERSION + 1))
    assert.match(takeNews(w.memDir, 'all'), /newer Thenwise/)
  } finally {
    w.destroy()
  }
})

test('#137: under its own marker, a newer Thenwise masks plan snapshots an older one wrote after it', () => {
  const w = new World()
  try {
    const plans = join(w.memDir, 'archive/plans/k/root/PLAN')
    mkdirSync(plans, { recursive: true })
    const mark = join(w.memDir, 'archive/plans/.mask')
    writeFileSync(mark, String(MASK_VERSION))
    const hourAgo = new Date(Date.now() - 3600e3)
    utimesSync(mark, hourAgo, hourAgo)
    writeFileSync(join(plans, 'b.md'), `use ${KEY}`) // written by an older Thenwise, after the marker
    w.archive()
    assert.ok(!readFileSync(join(plans, 'b.md'), 'utf8').includes(KEY))
  } finally {
    w.destroy()
  }
})

test('#137: an older Thenwise leaves the PR cache and the team caches a newer one wrote', async () => {
  const w = new World()
  try {
    const prs = join(w.memDir, 'prs-cache.json')
    writeFileSync(prs, JSON.stringify({ 'me/p': { fetchedAt: Date.now(), tried: Date.now(), error: '', prs: [{ number: 1, title: 'x', body: `key ${KEY}` }], mask: MASK_VERSION + 1 } }))
    const text = readFileSync(prs, 'utf8')
    fetchPrs({ ...w.cfg, prs: true, githubRepos: [] }, [])
    assert.equal(readFileSync(prs, 'utf8'), text)

    const dir = tempDir()
    const db = openChatCache(dir)
    db.prepare("INSERT INTO since VALUES ('mask', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(MASK_VERSION + 1)
    db.prepare('INSERT INTO chats (owner, session, project, rev, started_at, ended_at, head, mask, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ana', 's1', 'proj', 1, 1, 2, `deploy with ${KEY}`, 1, 9)
    db.close()
    const again = openChatCache(dir)
    const head = (again.prepare('SELECT head FROM chats').get() as { head: string }).head
    const v = (again.prepare("SELECT v FROM since WHERE k = 'mask'").get() as { v: number }).v
    again.close()
    assert.deepEqual([head, v], [`deploy with ${KEY}`, MASK_VERSION + 1])
    assert.throws(() => importChats(dir, []), /newer Thenwise/)

    writeFileSync(join(dir, 'team-cache.json'), JSON.stringify({ since: 3, mask: MASK_VERSION + 1, notes: { 'ana/n1': { owner: 'ana', id: 'n1', title: `rotate ${KEY}`, text: 'x' } } }))
    assert.equal(readCache(dir).mask, MASK_VERSION + 1)
    assert.ok(JSON.stringify(readCache(dir)).includes(KEY))
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 't', lastRev: 0, shared: {}, queue: [] }))
    assert.match(await fetchShared(dir), /not fetched: a newer Thenwise wrote them/)
  } finally {
    w.destroy()
  }
})

test('#137: a sync step that meets a newer store gives its own notice, not "a step failed"', () => {
  const dir = tempDir()
  const cli = join(dir, 'fake-cli.mjs')
  writeFileSync(cli, "if (process.argv[2] === 'ingest') { console.error('thenwise: graph.db was written by a newer Thenwise (store version 99, this one builds 9). Update Thenwise.'); process.exit(1) }\n")
  withEnv({ THENWISE_HOME: dir, THENWISE_NO_UPDATE_CHECK: '1' }, () => syncRun({ dir, cli }))
  assert.doesNotMatch(takeNews(dir, 'all'), /ingest step failed/)
})
