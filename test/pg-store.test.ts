// Postgres-specific behaviour the shared conformance suite does not cover: events, idempotency, edge upkeep, hubs, cycles.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { StoreError } from '../src/core/store.ts'
import type { NodeInput } from '../src/core/store.ts'
import { migrate } from '../src/store-postgres/migrate.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { SEED } from './conformance.ts'
import { MemIO } from './mem-io.ts'
import { pgSkip } from './pg-cluster.ts'
import { pgFixture, SCOPE_A, seedScope } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

const NOW = '2026-10-22T12:00:00Z'
let n = 0
const newId = (prefix: string) => `${prefix}_01JD${String(++n).padStart(22, '0')}`
const note = (title: string, extra: Partial<NodeInput> = {}): NodeInput => ({ type: 'decision', title, summary: 's', body: '', status: 'inbox', confidence: 'agent', origin: 'local', author: 'claude', ...extra })
const fm = (o: Record<string, string>, body = '') => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

describe('postgres store details', { skip: pgSkip }, () => {
  let fx: PgFixture
  before(async () => {
    fx = await pgFixture()
  })
  after(() => fx?.stop())

  const withDb = async (seed: Record<string, string>, fn: (s: PgStore, pool: import('pg').Pool) => Promise<void>, opts = {}) => {
    const db = await fx.fresh()
    try {
      await fn(await seedScope(db.pool, SCOPE_A, seed, opts), db.pool)
    } finally {
      await db.close()
    }
  }

  test('migrations are idempotent', async () => {
    const db = await fx.fresh()
    try {
      assert.deepEqual(await migrate(db.pool), [])
    } finally {
      await db.close()
    }
  })

  test('a repeated idempotency key writes once and returns the first result', () =>
    withDb(SEED, async (s, pool) => {
      const a = await s.put(note('Retry with backoff'), { now: NOW, newId, idempotencyKey: 'k1' })
      const b = await s.put(note('Retry with backoff'), { now: NOW, newId, idempotencyKey: 'k1' })
      assert.equal(b.id, a.id)
      assert.equal((await s.stats()).notes, 11)
      const c = await s.setStatus(a.id, 'active', { now: NOW, idempotencyKey: 'k2' })
      const d = await s.setStatus(a.id, 'archived', { now: NOW, idempotencyKey: 'k2' })
      assert.equal(d.status, 'active', 'the retry did not apply its own status')
      assert.equal(c.version, d.version)
      const ev = await pool.query("select count(*) as n from events where idempotency_key in ('k1', 'k2')")
      assert.equal(Number(ev.rows[0].n), 2)
    }))

  test('concurrent writes with one key write once; concurrent writes with different keys all land', () =>
    withDb(SEED, async s => {
      const same = await Promise.all([1, 2, 3, 4].map(() => s.put(note('Parallel idea'), { now: NOW, newId, idempotencyKey: 'same' })))
      assert.equal(new Set(same.map(x => x.id)).size, 1)
      await Promise.all([1, 2, 3, 4].map(i => s.put(note(`Distinct idea ${i}`), { now: NOW, newId, idempotencyKey: `k${i}` })))
      assert.equal((await s.stats()).notes, 15)
    }))

  test('events are append-only and changesSince pages by cursor', () =>
    withDb(SEED, async (s, pool) => {
      await assert.rejects(pool.query('update events set actor = $1', ['x']), /append-only/)
      await assert.rejects(pool.query('delete from events'), /append-only/)
      const first = await s.changesSince(null, 5)
      assert.equal(first.events.length, 5)
      const rest = await s.changesSince(first.cursor, 100)
      assert.equal(first.events.length + rest.events.length, 10, 'one import event per note')
      assert.deepEqual((await s.changesSince(rest.cursor, 10)).events, [])
      await s.put(note('Another idea'), { now: NOW, newId })
      const more = await s.changesSince(rest.cursor, 10)
      assert.deepEqual(more.events.map(e => e.op), ['node.put'])
      assert.equal(more.events[0]?.actor, 'claude')
    }))

  test('a new version replaces its old edges, and a new note resolves links that were missing', () =>
    withDb(
      { ...SEED, 'Wishlist.md': fm({ id: 'not_01JB8Z3K7Q2Y5W9X4M6N1P0R2W' }, 'Wants [[Offline queue]].') },
      async s => {
        assert.equal((await s.stats()).unresolved, 1)
        const q = await s.put(note('Offline queue', { type: 'finding', status: 'active' }), { now: NOW, newId })
        assert.equal((await s.stats()).unresolved, 0)
        assert.ok((await s.edgesOf([q.id], ['mentions'])).some(e => e.to === q.id))
        const v1 = await s.put(note('Cursors v2', { edges: { about: ['Sync Engine'] } }), { now: NOW, newId })
        assert.equal((await s.edgesOf([v1.id], ['about'])).length, 1)
        await s.put(note('Cursors v2', { edges: { about: ['Offline queue'] } }), { id: v1.id, expectedVersion: 1, now: NOW, newId })
        assert.deepEqual((await s.edgesOf([v1.id], ['about'])).map(e => e.to), [q.id])
      },
    ))

  test('a supersede loop maps both nodes to themselves, as in Files mode', async () => {
    const seed = {
      'a.md': fm({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R3A', type: 'decision', title: 'Alpha', summary: 'a', supersedes: '["[[Beta]]"]' }),
      'b.md': fm({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R3B', type: 'decision', title: 'Beta', summary: 'b', supersedes: '["[[Alpha]]"]' }),
    }
    const files = new FilesStore(new MemIO(Object.fromEntries(Object.entries(seed).map(([p, t]) => [`/v/${p}`, t]))), '/v', null)
    await files.open()
    await withDb(seed, async s => {
      for (const id of files.index.byId.keys()) assert.equal(await s.supersedeHead(id), await files.supersedeHead(id))
      assert.equal(await s.supersedeHead('dec_01JB8Z3K7Q2Y5W9X4M6N1P0R3A'), 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R3A')
    })
  })

  test('hubs: degree at or above 20 are not expanded through; the exclude list adds more', async () => {
    // 25 notes about one entity make it a hub; each note also links to its own helper, so depth 2 from a note would pass through the hub.
    const seed: Record<string, string> = { 'hub.md': fm({ id: 'ent_01JB8Z3K7Q2Y5W9X4M6N1P0H00', type: 'entity', title: 'Hub' }) }
    for (let i = 0; i < 25; i++) seed[`n${i}.md`] = fm({ id: `dec_01JB8Z3K7Q2Y5W9X4M6N1P0N${String(i).padStart(2, '0')}`, type: 'decision', title: `Note ${i}`, summary: 's', about: '["[[Hub]]"]' })
    seed['lonely.md'] = fm({ id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0L00', type: 'decision', title: 'Lonely', summary: 's', part_of: '["[[Note 0]]"]' })
    const files = new FilesStore(new MemIO(Object.fromEntries(Object.entries(seed).map(([p, t]) => [`/v/${p}`, t]))), '/v', null)
    await files.open()
    await withDb(seed, async s => {
      const hub = 'ent_01JB8Z3K7Q2Y5W9X4M6N1P0H00'
      assert.equal(await s.isHub(hub), true)
      assert.equal(await s.isHub('dec_01JB8Z3K7Q2Y5W9X4M6N1P0N01'), false)
      const two = await s.links({ ids: ['dec_01JB8Z3K7Q2Y5W9X4M6N1P0N01'], depth: 2, limit: 100 })
      assert.deepEqual(two.map(x => [x.id, x.hop]), [[hub, 1]], 'the hub is reached but not passed through')
      assert.deepEqual((await files.links({ ids: ['dec_01JB8Z3K7Q2Y5W9X4M6N1P0N01'], depth: 2, limit: 100 })).map(x => [x.id, x.hop]), [[hub, 1]])
      const fromHub = await s.links({ ids: [hub], depth: 1, limit: 100 })
      assert.equal(fromHub.length, 25, 'a hub seed is still expanded at hop 1')
      assert.deepEqual(await s.stats(), await files.stats())
    })
    await withDb(seed, async s => {
      assert.equal(await s.isHub('dec_01JB8Z3K7Q2Y5W9X4M6N1P0L00'), true, 'listed by path')
    }, { hubs: { exclude: ['lonely.md'], minDegree: 20, percentile: 95 } })
  })

  test('typos fall back to similar titles', () =>
    withDb(SEED, async s => {
      const hits = await s.search({ text: 'Servr decides budget conflicts', limit: 3, includeInbox: false })
      assert.ok(hits.length > 0)
    }))

  test('put refuses an unknown id', () =>
    withDb(SEED, async s => {
      await assert.rejects(s.put(note('x'), { id: 'dec_nope', now: NOW, newId }), (e: unknown) => e instanceof StoreError && e.code === 'not_found')
    }))
})
