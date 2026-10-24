// The Postgres store against the Files store on the same vault: same graph answers, same manifest data.
// Search scores differ by design (ts_rank_cd is not BM25), so search is compared by overlap, not equality.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

import { buildManifest, DEFAULT_MANIFEST } from '../src/core/manifest.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { importVault } from '../src/store-postgres/import.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { pgSkip } from './pg-cluster.ts'
import { pgFixture, SCOPE_A } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

const VAULT = new URL('../fixtures/vault-sample', import.meta.url).pathname

describe('postgres parity with the Files store', { skip: pgSkip }, () => {
  let fx: PgFixture
  let files: FilesStore
  let pgs: PgStore
  let close: () => Promise<void>
  before(async () => {
    fx = await pgFixture()
    files = new FilesStore(nodeIO, VAULT, null)
    await files.open()
    const db = await fx.fresh()
    close = db.close
    await importVault(db.pool, SCOPE_A, VAULT)
    pgs = new PgStore(db.pool, SCOPE_A)
  })
  after(async () => {
    await close?.()
    await fx?.stop()
  })

  const ids = () => [...files.index.byId.keys()]

  test('manifest data equals the Files result, and renders the same manifest', async () => {
    const a = await files.manifestData({ maxTopics: 20 })
    const b = await pgs.manifestData({ maxTopics: 20 })
    assert.deepEqual(b, a)
    const opts = { ...DEFAULT_MANIFEST, vaultPath: VAULT }
    assert.equal(buildManifest(b, opts).text, buildManifest(a, opts).text)
    assert.ok(a.rules.length > 0 && a.topics.length > 0)
  })

  test('stats, hubs, supersede heads and edges equal the Files result', async () => {
    assert.deepEqual(await pgs.stats(), await files.stats())
    for (const id of ids()) {
      assert.equal(await pgs.supersedeHead(id), await files.supersedeHead(id), `head of ${id}`)
      assert.equal(await pgs.isHub(id), await files.isHub(id), `hub ${id}`)
    }
    const all = ['about', 'supersedes', 'depends_on', 'contradicts', 'part_of', 'derived_from', 'mentions'] as const
    const sig = (e: { type: string; from: string; to: string }) => `${e.type} ${e.from} ${e.to}`
    assert.deepEqual((await pgs.edgesOf(ids(), [...all])).map(sig).sort(), (await files.edgesOf(ids(), [...all])).map(sig).sort())
  })

  test('records equal the Files records', async () => {
    const many = await pgs.getMany(ids())
    for (const id of ids()) assert.deepEqual(many.get(id), { ...files.index.byId.get(id)!, id }, id)
  })

  test('links reach the same nodes at the same hops, never through hubs', async () => {
    let compared = 0
    for (const id of ids()) {
      for (const depth of [1, 2] as const) {
        const q = { ids: [id], depth, limit: 1000 }
        const a = (await files.links(q)).map(n => `${n.id}@${n.hop}`).sort()
        const b = (await pgs.links(q)).map(n => `${n.id}@${n.hop}`).sort()
        assert.deepEqual(b, a, `${id} depth ${depth}`)
        compared += a.length
      }
    }
    assert.ok(compared > 50, 'the vault has links to compare')
  })

  test('exact match equals the Files result for every cited path and url', async () => {
    const keys = new Set<string>()
    for (const n of files.index.byId.values()) for (const s of n.sources) if (s.kind === 'file' || s.kind === 'url') keys.add(s.ref)
    for (const e of files.index.entityPaths) keys.add(`${e.prefix}/x.ts`)
    assert.ok(keys.size > 5)
    for (const k of keys) {
      const key = k.startsWith('http') ? { url: k } : { path: k }
      const a = await files.matchExact(key)
      const b = await pgs.matchExact(key)
      assert.deepEqual([...b.bySource].sort(), [...a.bySource].sort(), k)
      assert.deepEqual(b.byEntity, [...new Set(a.byEntity)], k)
    }
  })

  test('search finds the gold notes of the benchmark questions about as often as Files mode', async () => {
    const qs = readFileSync(new URL('../fixtures/questions.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { question: string; gold: string[]; as_of: unknown })
    const pathToId = (p: string) => files.index.idOf(files.index.byPath.get(p)!)
    let fileHits = 0
    let pgHits = 0
    let judged = 0
    for (const q of qs) {
      const gold = q.gold.filter(p => files.index.byPath.has(p)).map(pathToId)
      if (gold.length === 0) continue
      judged++
      const query = { text: q.question, limit: 10, includeInbox: false }
      if ((await files.search(query)).some(h => gold.includes(h.id))) fileHits++
      if ((await pgs.search(query)).some(h => gold.includes(h.id))) pgHits++
    }
    console.log(`  recall@10 over ${judged} questions: files ${fileHits}, postgres ${pgHits}`)
    assert.ok(judged > 10)
    assert.ok(pgHits >= fileHits * 0.8, `postgres recall ${pgHits} vs files ${fileHits}`)
  })
})
