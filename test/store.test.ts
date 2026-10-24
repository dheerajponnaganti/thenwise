import assert from 'node:assert/strict'
import { test } from 'node:test'

import { seededRandom } from '../src/core/ids.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { MemIO } from './mem-io.ts'

const V = '/vault'
const CACHE = '/cache/index.json'

const note = (fm: Record<string, string>, body = '') => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

function vault(): MemIO {
  return new MemIO({
    [`${V}/entities/sync-engine.md`]: note({ id: 'ent_01JB8Z3K7Q2Y5W9X4M6N1P0R2S', type: 'entity', title: 'Sync Engine', summary: 'Moves changes between phone and server.', aliases: '[engine]', paths: '[src/sync/]' }),
    [`${V}/decisions/old.md`]: note({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2A', type: 'decision', title: 'Merge budgets with CRDTs', summary: 'CRDT merges for budget edits.', status: 'superseded', valid_to: '2026-03-10', about: '["[[Sync Engine]]"]' }),
    [`${V}/decisions/new.md`]: note({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2B', type: 'decision', title: 'Server decides budget conflicts', summary: 'The server is the authority for budget edits.', about: '["[[Sync Engine]]"]', supersedes: '["[[Merge budgets with CRDTs]]"]' }),
    [`${V}/inbox/idea.md`]: note({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2C', type: 'decision', title: 'Batch budget syncs hourly', summary: 'Proposal to batch budget syncs.', status: 'inbox', confidence: 'agent' }),
    [`${V}/decisions/dropped.md`]: note({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2D', type: 'decision', title: 'Budget sync over email', summary: 'Rejected budget idea.', status: 'rejected' }),
    [`${V}/meetings/kickoff.md`]: 'Kickoff notes about the budget screen. See [[Sync Engine]].\n',
    [`${V}/.obsidian/workspace.md`]: 'never indexed',
  })
}

test('open: indexes Markdown, skips dot folders, then reuses the cache', async () => {
  const io = vault()
  const s1 = new FilesStore(io, V, CACHE)
  const r1 = await s1.open()
  assert.equal(r1.files, 6)
  assert.equal(r1.parsed, 6)
  assert.equal(r1.reused, 0)
  // The cache is 16 shard files beside the given path, never one big file.
  assert.equal([...io.files.keys()].filter(p => /^\/cache\/index\.\d\d\.json$/.test(p)).length, 16)
  const s2 = new FilesStore(io, V, CACHE)
  const r2 = await s2.open()
  assert.equal(r2.parsed, 0)
  assert.equal(r2.reused, 6)
  assert.deepEqual(s2.index.search('budget conflicts', { limit: 3, includeInbox: false }), s1.index.search('budget conflicts', { limit: 3, includeInbox: false }))
})

test('search: superseded redirects to the newest, rejected never appears, inbox only on request', async () => {
  const s = new FilesStore(vault(), V, null)
  await s.open()
  const hits = s.index.search('CRDT merges budget', { limit: 5, includeInbox: false })
  const ids = hits.map(h => h.id)
  assert.ok(ids.includes('dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2B'), 'the replacement is returned')
  assert.ok(!ids.includes('dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2A'), 'the superseded note is not')
  assert.equal(hits.find(h => h.id === 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2B')?.replaces, 'Merge budgets with CRDTs')
  assert.ok(!ids.includes('dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2D'))
  assert.ok(!ids.includes('dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2C'))
  assert.ok(s.index.search('batch hourly', { limit: 5, includeInbox: true }).some(h => h.id === 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2C'))
})

test('a changed file is re-read alone; a deleted one is dropped', async () => {
  const io = vault()
  const s = new FilesStore(io, V, CACHE)
  await s.open()
  await io.writeText(`${V}/meetings/kickoff.md`, 'Kickoff notes: we chose Expo for the mobile app.\n')
  io.files.delete(`${V}/inbox/idea.md`)
  const s2 = new FilesStore(io, V, CACHE)
  const r = await s2.open()
  assert.equal(r.parsed, 1)
  assert.equal(r.removed, 0, 'a fresh store starts empty, so nothing to remove')
  assert.equal(r.files, 5)
  assert.ok(s2.index.search('Expo mobile', { limit: 1, includeInbox: true })[0])
  // In-session: refreshPath picks up an edit without a rescan.
  await io.writeText(`${V}/meetings/kickoff.md`, 'Kickoff notes: Android first.\n')
  await s2.refreshPath('meetings/kickoff.md')
  assert.equal(s2.index.search('Expo', { limit: 1, includeInbox: true }).length, 0)
  assert.equal(s2.index.search('Android', { limit: 1, includeInbox: true }).length, 1)
})

test('an unreadable file keeps its last good copy and is reported', async () => {
  const io = vault()
  await new FilesStore(io, V, CACHE).open()
  io.files.set(`${V}/meetings/kickoff.md`, { text: 'changed but evicted', mtimeMs: ++io.clock })
  io.unreadable.add(`${V}/meetings/kickoff.md`)
  const s = new FilesStore(io, V, CACHE)
  const r = await s.open()
  assert.deepEqual(r.unavailable, ['meetings/kickoff.md'])
  assert.ok(s.index.byPath.has('meetings/kickoff.md'))
  assert.ok(s.doctor().some(f => f.rule === 'unavailable'))
})

test('ensureIds writes one id line into notes that lack one and changes nothing else', async () => {
  const io = vault()
  const s = new FilesStore(io, V, null)
  await s.open()
  const before = io.files.get(`${V}/meetings/kickoff.md`)!.text
  const added = await s.ensureIds(seededRandom('t'))
  assert.equal(added.length, 1)
  assert.equal(added[0]!.path, 'meetings/kickoff.md')
  assert.match(added[0]!.id, /^not_/)
  assert.equal(io.files.get(`${V}/meetings/kickoff.md`)!.text, `---\nid: ${added[0]!.id}\n---\n${before}`)
  assert.deepEqual(io.writes, [`${V}/meetings/kickoff.md`], 'only that file was written')
  assert.deepEqual(await s.ensureIds(seededRandom('t')), [], 'a second run adds nothing')
})

test('links: neighbours both ways, never through a hub', async () => {
  const from = 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2B'
  const kickoff = (s: FilesStore) => s.index.byPath.get('meetings/kickoff.md')!
  // Without a hub, the kickoff note is two hops away: new decision, engine, kickoff.
  const plain = new FilesStore(vault(), V, null)
  await plain.open()
  const viaEngine = plain.index.links([from], { depth: 2, limit: 20 })
  assert.ok(viaEngine.some(x => x.id === plain.index.idOf(kickoff(plain)) && x.hop === 2))
  // With the engine as a hub, it is still reached itself, but nothing fans out through it.
  const hub = new FilesStore(vault(), V, null, { hubs: { exclude: ['Sync Engine'], minDegree: 20, percentile: 95 } })
  await hub.open()
  const blocked = hub.index.links([from], { depth: 2, limit: 20 })
  assert.ok(blocked.some(x => x.id === 'ent_01JB8Z3K7Q2Y5W9X4M6N1P0R2S' && x.hop === 1))
  assert.ok(!blocked.some(x => x.id === hub.index.idOf(kickoff(hub))), 'kickoff is not reached through the hub')
})

test('doctor: broken vault reports each problem once', async () => {
  const io = new MemIO({
    [`${V}/a.md`]: note({ type: 'decision', title: 'Same', summary: 'x', supersedes: '["[[Loop B]]"]' }),
    [`${V}/b.md`]: note({ type: 'decision', title: 'Same', summary: '' }),
    [`${V}/c.md`]: note({ type: 'finding', title: 'Undated finding', summary: 'x', sources: '["url:https://x.org"]' }),
    [`${V}/d.md`]: note({ type: 'decision', title: 'Loop A', summary: 'x', supersedes: '["[[Loop B]]"]' }),
    [`${V}/e.md`]: note({ type: 'decision', title: 'Loop B', summary: 'x', supersedes: '["[[Loop A]]"]', status: 'superseded' }),
    [`${V}/f.md`]: note({ id: 'dec_bad', type: 'decison', title: 'Typo' }, 'Links to [[Nowhere]].'),
  })
  const s = new FilesStore(io, V, null)
  await s.open()
  const rules = new Set(s.doctor().map(f => f.rule))
  for (const r of ['duplicate-title', 'missing-summary', 'finding-undated', 'supersede-cycle', 'bad-id', 'parse', 'unresolved-link', 'superseded-open', 'missing-id']) assert.ok(rules.has(r), `expected ${r}`)
})
