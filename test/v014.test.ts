import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { saveNote } from '../src/capture/notes.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { autoShare, fetchShared, joinTeam, readCache, share, unshare } from '../src/teams/client.ts'
import { openTeamDb } from '../src/teams/schema.ts'
import { createTeamServer, invite } from '../src/teams/server.ts'
import { World } from './world.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw14-${p}-`))

/** A team server with alice (the owner) and bob; Alice's machine is a World with a store, Bob's a bare data folder. */
async function team() {
  const dir = tmp('srv')
  const app = createTeamServer({ dir })
  const base = `http://127.0.0.1:${(await app.listen()).port}`
  const db = openTeamDb(dir)
  const tokens = { alice: invite(db, 'alice'), bob: invite(db, 'bob') }
  db.close()
  const w = new World()
  const bob = tmp('bob')
  await joinTeam(w.memDir, base, tokens.alice)
  await joinTeam(bob, base, tokens.bob)

  return { dir, app, base, tokens, w, bob }
}
const NOTE = { title: 'Exporter shards', text: 'Decision: the quokka exporter writes eight shards.', project: 'proj', kind: 'decision' }
const sync = async (w: World) => (await fetchShared(w.memDir), w.archive(), w.ingest('g.db'), new Graph(w.path('g.db')))

test('T14-H1 T14-H2: a note Bob shares reaches Alice\'s memory, named as his; his unshare takes it out again', async () => {
  const t = await team()
  try {
    await share(t.bob, 'n1', NOTE)
    let g = await sync(t.w)
    assert.ok(g.nodes.has('team:bob/n1'))
    const out = c.search(g, 'quokka exporter shards')
    assert.match(out, /\[team\] team:bob\/n1/)
    assert.match(out, /source: shared by bob \(team\)/)
    await unshare(t.bob, 'n1')
    g = await sync(t.w)
    assert.ok(!g.nodes.has('team:bob/n1'))
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})

test('Alice\'s own shares are not fetched back: they are in her memory already', async () => {
  const t = await team()
  try {
    await share(t.w.memDir, 'mine', NOTE)
    await fetchShared(t.w.memDir)
    assert.deepEqual(Object.keys(readCache(t.w.memDir).notes), [])
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})

test('T14-B5: with the review queue on, a pending share never arrives; after approval it does', async () => {
  const t = await team()
  try {
    const db = openTeamDb(t.dir)
    db.prepare('UPDATE teams SET review_queue = 1').run()
    db.close()
    await share(t.bob, 'p1', NOTE)
    await fetchShared(t.w.memDir)
    assert.equal(readCache(t.w.memDir).notes['bob/p1'], undefined)
    const r = await fetch(`${t.base}/v1/notes/bob/p1/approve`, { method: 'POST', headers: { authorization: `Bearer ${t.tokens.alice}` } })
    assert.equal(r.status, 200)
    await fetchShared(t.w.memDir)
    assert.equal(readCache(t.w.memDir).notes['bob/p1']?.status, 'active')
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})

test('T14-B2: a secret in a teammate\'s note is masked again at ingest', async () => {
  const t = await team()
  try {
    // As if a server had passed it on unmasked: the cache is written by hand.
    writeFileSync(join(t.w.memDir, 'team-cache.json'), JSON.stringify({ since: 9, notes: { 'bob/s1': { owner: 'bob', id: 's1', rev: 9, title: 'Keys', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the bot', project: '', kind: 'note', status: 'active', shared_by: 'bob', updated_at: Date.now(), superseded_by: null } } }))
    t.w.archive()
    t.w.ingest('g.db')
    assert.doesNotMatch(new Graph(t.w.path('g.db')).fullText('team:bob/s1'), /ghp_/)
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})

test('T14-B3: with the server down, the fetch fails alone and the cache stays as it was', async () => {
  const t = await team()
  await share(t.bob, 'n1', NOTE)
  await fetchShared(t.w.memDir)
  await t.app.close()
  try {
    await assert.rejects(fetchShared(t.w.memDir))
    assert.ok(readCache(t.w.memDir).notes['bob/n1'])
  } finally {
    t.w.destroy()
  }
})

test('T14-H4: auto-share sends a just-accepted decision of a listed project, and nothing when it is not configured', async () => {
  const t = await team()
  try {
    const n = saveNote(t.w.memDir, { id: 'n-auto1', type: 'decision', title: 'Use shards', summary: 'Use eight shards.', status: 'active', valid_from: '', valid_to: '', supersedes: '', sources: ['ses:x'], created: new Date().toISOString(), project: 'proj', path: '' })
    assert.deepEqual(await autoShare(t.w.cfg, [n]), [], 'off by default')
    const cfg = { ...t.w.cfg, autoShare: ['decision'], autoShareProjects: ['proj'] }
    assert.match((await autoShare(cfg, [n]))[0]!, /^n-auto1 shared: 1 sent/)
    await fetchShared(t.bob)
    assert.equal(readCache(t.bob).notes['alice/n-auto1']?.kind, 'decision')
    assert.deepEqual(await autoShare({ ...cfg, autoShareProjects: ['other'] }, [n]), [])
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})

test('the team cache is private', async () => {
  const t = await team()
  try {
    await share(t.bob, 'n1', NOTE)
    await fetchShared(t.w.memDir)
    assert.ok(readFileSync(join(t.w.memDir, 'team-cache.json'), 'utf8').includes('quokka'))
    const { statSync } = await import('node:fs')
    if (process.platform !== 'win32') assert.equal(statSync(join(t.w.memDir, 'team-cache.json')).mode & 0o777, 0o600)
  } finally {
    t.w.destroy()
    await t.app.close()
  }
})
