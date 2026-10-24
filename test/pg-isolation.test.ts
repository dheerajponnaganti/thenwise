// Phase 7 gate (spec 09): one scope never sees another, through the store and through raw SQL under row-level security.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import pg from 'pg'

import { StoreError } from '../src/core/store.ts'
import { grantApp } from '../src/store-postgres/migrate.ts'
import { addMembership, createToken, hashToken, pgVerifier, removeMembership, revokeToken } from '../src/store-postgres/pg-auth.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import { ID, SEED } from './conformance.ts'
import { pgSkip } from './pg-cluster.ts'
import { pgFixture, SCOPE_A, SCOPE_B, seedScope } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

const fm = (o: Record<string, string>, body = '') => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

// Scope B holds the same ids as A (a copy of the seed) plus notes only B has.
const SECRET = 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0S99'
const B_ONLY: Record<string, string> = {
  ...SEED,
  'secret/plan.md': fm({ id: SECRET, type: 'decision', title: 'Acquire Zephyrcorp', summary: 'Confidential acquisition plan.', sources: '["file:secret/zephyr.ts@a1 2026-01-01"]', about: '["[[Sync Engine]]"]' }, 'Zephyrcorp price is 40M.'),
}

// Roles belong to the cluster, not the database, so every test shares one.
const ensureAppRole = async (pool: pg.Pool) => {
  const r = await pool.query("select 1 from pg_roles where rolname = 'app_user'")
  if (!r.rows[0]) await pool.query('create role app_user login nosuperuser nobypassrls')
  await grantApp(pool, 'app_user')
}

describe('scope isolation', { skip: pgSkip }, () => {
  let fx: PgFixture
  before(async () => {
    fx = await pgFixture()
  })
  after(() => fx?.stop())

  test('a store for scope A never sees scope B, through any method', async () => {
    const db = await fx.fresh()
    try {
      const a = await seedScope(db.pool, SCOPE_A, SEED)
      const b = await seedScope(db.pool, SCOPE_B, B_ONLY)
      assert.equal((await b.get(SECRET))?.title, 'Acquire Zephyrcorp', 'B sees its own note')
      assert.equal(await a.get(SECRET), null)
      assert.equal((await a.getMany([SECRET, ID.rule])).size, 1)
      assert.deepEqual(await a.search({ text: 'Zephyrcorp acquisition', limit: 10, includeInbox: true }), [])
      assert.ok((await b.search({ text: 'Zephyrcorp acquisition', limit: 10, includeInbox: true })).length > 0)
      assert.deepEqual(await a.matchExact({ path: 'secret/zephyr.ts' }), { bySource: [], byEntity: [] })
      assert.deepEqual((await b.matchExact({ path: 'secret/zephyr.ts' })).bySource, [SECRET])
      assert.deepEqual(await a.links({ ids: [SECRET], depth: 2, limit: 50 }), [])
      assert.ok((await a.links({ ids: [ID.engine], depth: 1, limit: 50 })).every(n => n.id !== SECRET), 'links from a shared id do not cross over')
      assert.ok((await b.links({ ids: [ID.engine], depth: 1, limit: 50 })).some(n => n.id === SECRET))
      assert.deepEqual(await a.edgesOf([SECRET], ['about']), [])
      assert.equal(await a.supersedeHead(SECRET), SECRET)
      assert.equal(await a.isHub(SECRET), false)
      const am = await a.manifestData({ maxTopics: 10 })
      assert.equal(am.topics[0]?.count, 3, 'about-counts in A do not include B-only edges')
      assert.equal((await b.manifestData({ maxTopics: 10 })).topics[0]?.count, 4)
      assert.equal((await a.stats()).notes, 10)
      assert.equal((await b.stats()).notes, 11)
      assert.deepEqual((await a.changesSince(null, 1000)).events.map(e => e.target).includes(SECRET), false)
      await assert.rejects(a.setStatus(SECRET, 'rejected', { now: '2026-10-22T00:00:00Z' }), (e: unknown) => e instanceof StoreError && e.code === 'not_found')
      await assert.rejects(a.put({ type: 'decision', title: 'x', summary: 'x', body: '', status: 'active', confidence: 'agent', origin: 'local', author: 'c' }, { id: SECRET, now: '2026-10-22T00:00:00Z', newId: p => `${p}_x` }), (e: unknown) => e instanceof StoreError && e.code === 'not_found')
      // The same id exists in both scopes: a write in B leaves A's copy alone.
      await b.setStatus(ID.rule, 'archived', { now: '2026-10-22T00:00:00Z' })
      assert.equal((await a.get(ID.rule))?.status, 'active')
    } finally {
      await db.close()
    }
  })

  test('under row-level security a principal cannot read or write another scope, even with a crafted query', async () => {
    const db = await fx.fresh()
    const app = new pg.Pool({ ...fx.cluster.config(db.db, 'app_user'), max: 2 })
    try {
      await ensureAppRole(db.pool)
      await seedScope(db.pool, SCOPE_A, SEED)
      await seedScope(db.pool, SCOPE_B, B_ONLY)
      await addMembership(db.pool, 'alice', SCOPE_A)
      await addMembership(db.pool, 'bob', SCOPE_B)

      // Through the store.
      const aliceA = new PgStore(app, SCOPE_A, { principal: 'alice' })
      const aliceB = new PgStore(app, SCOPE_B, { principal: 'alice' })
      const bobB = new PgStore(app, SCOPE_B, { principal: 'bob' })
      assert.equal((await aliceA.stats()).notes, 10)
      assert.equal((await aliceB.stats()).notes, 0, 'alice sees nothing of B even through a store pointed at B')
      assert.equal(await aliceB.get(SECRET), null)
      assert.deepEqual(await aliceB.search({ text: 'Zephyrcorp', limit: 5, includeInbox: true }), [])
      assert.deepEqual((await aliceB.manifestData({ maxTopics: 5 })).rules, [])
      assert.equal((await bobB.get(SECRET))?.title, 'Acquire Zephyrcorp')
      const made = await aliceA.put({ type: 'note', title: 'Alice writes under RLS', summary: '', body: 'links [[Sync Engine]]', status: 'active', confidence: 'agent', origin: 'local', author: 'alice' }, { now: '2026-10-22T00:00:00Z', newId: p => `${p}_01JE00000000000000000000AA` })
      assert.equal((await aliceA.setStatus(made.id, 'archived', { now: '2026-10-22T00:00:00Z' })).status, 'archived')
      assert.equal((await aliceA.edgesOf([made.id], ['mentions'])).length, 1)
      await assert.rejects(aliceB.setStatus(SECRET, 'rejected', { now: '2026-10-22T00:00:00Z' }), (e: unknown) => e instanceof StoreError && e.code === 'not_found')
      await assert.rejects(aliceB.put({ type: 'note', title: 'planted', summary: '', body: '', status: 'active', confidence: 'agent', origin: 'local', author: 'a' }, { now: '2026-10-22T00:00:00Z', newId: p => `${p}_planted` }), /row-level security/)

      // Crafted SQL as alice: no WHERE on scope, a filter for B, unions, subselects, writes.
      const asAlice = async <T>(sql: string, params: unknown[] = []) => {
        const c = await app.connect()
        try {
          await c.query('begin')
          await c.query("select set_config('app.principal', 'alice', true)")
          return await c.query(sql, params)
        } finally {
          await c.query('rollback').catch(() => undefined)
          c.release()
        }
      }
      const scopesSeen = async (table: string) => new Set((await asAlice(`select distinct scope_key from ${table}`)).rows.map(r => r.scope_key))
      for (const t of ['nodes', 'edges', 'sources', 'match_keys', 'events', 'scopes']) assert.deepEqual([...(await scopesSeen(t))].sort(), ['a'], t)
      assert.equal((await asAlice("select * from nodes where scope_key = 'b'")).rowCount, 0)
      assert.equal((await asAlice("select * from nodes where scope_key = 'b' or true")).rows.every(r => r.scope_key === 'a'), true)
      assert.equal((await asAlice("select id from nodes where id = $1", [SECRET])).rowCount, 0)
      assert.equal((await asAlice("select n.id from nodes n join edges e on e.to_id = n.id where n.title like '%Zephyr%'")).rowCount, 0)
      assert.equal((await asAlice("select id from nodes where tsv @@ plainto_tsquery('english', 'Zephyrcorp')")).rowCount, 0)
      assert.equal((await asAlice("select * from nodes union all select * from nodes where scope_key = 'b'")).rows.every(r => r.scope_key === 'a'), true)
      assert.equal((await asAlice("select count(*) as n from nodes where exists (select 1 from nodes b where b.scope_key = 'b')")).rows[0].n, '0', 'a subselect on B finds nothing')
      assert.equal((await asAlice("update nodes set body = 'tampered' where scope_key = 'b'")).rowCount, 0)
      assert.equal((await asAlice("delete from nodes where scope_key = 'b'")).rowCount, 0)
      await assert.rejects(asAlice("insert into nodes (scope_kind, scope_key, id, type, title, status, confidence, origin) values ('project', 'b', 'dec_planted', 'note', 'x', 'active', 'agent', 'local')"), /row-level security/)
      await assert.rejects(asAlice("update nodes set scope_key = 'b' where scope_key = 'a'"), /row-level security/, 'moving a row into B is refused')
      assert.deepEqual((await asAlice('select principal from memberships')).rows.map(r => r.principal), ['alice'])
      await assert.rejects(asAlice('select * from tokens'), /permission denied/)
      await assert.rejects(asAlice("insert into memberships values ('alice', 'project', 'b', 'admin')"), /permission denied/)
      await assert.rejects(asAlice("update events set actor = 'x'"), /permission denied/)
      // No principal at all: nothing is visible.
      assert.equal((await app.query('select * from nodes')).rowCount, 0)
      // The owner's data is unchanged.
      assert.equal((await db.pool.query("select count(*) as n from nodes where scope_key = 'b'")).rows[0].n, '11')
    } finally {
      await app.end()
      await db.close()
    }
  })

  test('tokens are stored as hashes, checked by hash, and revocable; membership gates the scope', async () => {
    const db = await fx.fresh()
    const app = new pg.Pool({ ...fx.cluster.config(db.db, 'app_user'), max: 2 })
    try {
      await ensureAppRole(db.pool)
      await addMembership(db.pool, 'alice', SCOPE_A)
      const token = await createToken(db.pool, 'alice', 'laptop')
      const stored = await db.pool.query('select * from tokens')
      assert.equal(stored.rowCount, 1)
      assert.equal(stored.rows[0].token_hash, hashToken(token))
      assert.ok(!JSON.stringify(stored.rows).includes(token), 'the token itself is not stored')
      const verify = pgVerifier(app, SCOPE_A)
      assert.deepEqual(await verify(hashToken(token)), { id: 'alice' })
      assert.equal(await verify(hashToken('mv2_wrong')), null)
      assert.equal(await pgVerifier(app, SCOPE_B)(hashToken(token)), null, 'a member of A is not a member of B')
      await removeMembership(db.pool, 'alice', SCOPE_A)
      assert.equal(await verify(hashToken(token)), null, 'no membership, no access')
      await addMembership(db.pool, 'alice', SCOPE_A)
      assert.equal(await revokeToken(db.pool, token), true)
      assert.equal(await verify(hashToken(token)), null, 'revoked')
      assert.equal(await revokeToken(db.pool, token), false)
    } finally {
      await app.end()
      await db.close()
    }
  })
})
