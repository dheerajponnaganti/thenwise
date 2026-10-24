// The Store conformance suite (spec 09 §3): every backend must pass the same tests.
// A backend provides a factory that builds a store holding exactly the notes of a seed vault (path → Markdown).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Store } from '../src/core/store.ts'
import { StoreError } from '../src/core/store.ts'

export type MakeStore = (seed: Record<string, string>) => Promise<{ store: Store; close?: () => Promise<void> }>

const fm = (o: Record<string, string>, body = '') => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

export const ID = {
  engine: 'ent_01JB8Z3K7Q2Y5W9X4M6N1P0R2S',
  home: 'not_01JB8Z3K7Q2Y5W9X4M6N1P0R2H',
  oldDec: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2A',
  newDec: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2B',
  inbox: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2C',
  rejected: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2D',
  rule: 'rul_01JB8Z3K7Q2Y5W9X4M6N1P0R2E',
  task: 'tsk_01JB8Z3K7Q2Y5W9X4M6N1P0R2F',
  finding: 'fnd_01JB8Z3K7Q2Y5W9X4M6N1P0R2G',
  agent: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R2J',
}

export const SEED: Record<string, string> = {
  'entities/sync-engine.md': fm({ id: ID.engine, type: 'entity', title: 'Sync Engine', summary: 'Moves changes between phone and server.', aliases: '[engine]', paths: '[src/sync]' }),
  'Home.md': fm({ id: ID.home }, 'Start: [[Sync Engine]], [[Server decides budget conflicts]].'),
  'decisions/old.md': fm({ id: ID.oldDec, type: 'decision', title: 'Merge budgets with CRDTs', summary: 'CRDT merges for budget edits.', status: 'superseded', valid_to: '2026-03-10', about: '["[[Sync Engine]]"]' }),
  'decisions/new.md': fm({ id: ID.newDec, type: 'decision', title: 'Server decides budget conflicts', summary: 'The server is the authority for budget edits.', about: '["[[Sync Engine]]"]', supersedes: '["[[Merge budgets with CRDTs]]"]', sources: '["file:src/sync/conflict.ts@abc1234 2026-03-09"]' }),
  'decisions/idea.md': fm({ id: ID.inbox, type: 'decision', title: 'Batch budget syncs hourly', summary: 'Proposal to batch budget syncs.', status: 'inbox', confidence: 'agent' }),
  'decisions/dropped.md': fm({ id: ID.rejected, type: 'decision', title: 'Budget sync over email', summary: 'Rejected budget idea.', status: 'rejected' }),
  'rules/tests.md': fm({ id: ID.rule, type: 'rule', title: 'Every sync change needs a conflict test', summary: 'Add a two-device test.', about: '["[[Sync Engine]]"]' }),
  'tasks/ship.md': fm({ id: ID.task, type: 'task', title: 'Ship sync 2.1', summary: 'Release the new protocol.', due: '2026-11-01', done: 'false', about: '["[[Sync Engine]]"]' }),
  'findings/cost.md': fm({ id: ID.finding, type: 'finding', title: 'CRDT merge cost on low-end phones', summary: 'Merges took 400 ms.', sources: '["url:https://example.org/crdt-bench?utm_source=x 2025-12-01"]', derived_from: '["[[Merge budgets with CRDTs]]"]' }),
  'decisions/agent.md': fm({ id: ID.agent, type: 'decision', title: 'Cache sync cursors per device', summary: 'Agent proposal.', status: 'active', confidence: 'agent', version: '1' }),
}

const NOW = '2026-10-22T12:00:00Z'
let counter = 0
const newId = (prefix: string) => `${prefix}_01JC${String(++counter).padStart(22, '0')}`

export function runConformance(name: string, make: MakeStore): void {
  const withStore = async (fn: (s: Store) => Promise<void>, seed = SEED) => {
    const { store, close } = await make(seed)
    try {
      await fn(store)
    } finally {
      await close?.()
    }
  }

  test(`[${name}] search applies the status rules`, () =>
    withStore(async s => {
      const ids = (await s.search({ text: 'CRDT merges budget', limit: 10, includeInbox: false })).map(h => h.id)
      assert.ok(ids.includes(ID.newDec), 'the replacement is returned')
      assert.ok(!ids.includes(ID.oldDec), 'the superseded note is not')
      assert.ok(!ids.includes(ID.rejected))
      assert.ok(!ids.includes(ID.inbox))
      const replaced = (await s.search({ text: 'CRDT merges budget', limit: 10, includeInbox: false })).find(h => h.id === ID.newDec)
      assert.equal(replaced?.replaces, 'Merge budgets with CRDTs')
      assert.ok((await s.search({ text: 'batch hourly', limit: 5, includeInbox: true })).some(h => h.id === ID.inbox))
      assert.deepEqual((await s.search({ text: 'conflict', limit: 5, includeInbox: false, types: ['rule'] })).map(h => h.id), [ID.rule])
    }))

  test(`[${name}] exact match by file source, url and entity path`, () =>
    withStore(async s => {
      assert.deepEqual((await s.matchExact({ path: 'src/sync/conflict.ts' })).bySource, [ID.newDec])
      assert.deepEqual((await s.matchExact({ path: './src/sync/conflict.ts' })).byEntity, [ID.engine])
      assert.deepEqual((await s.matchExact({ path: 'src/syncer/x.ts' })).byEntity, [], 'a prefix must end at a folder boundary')
      assert.deepEqual((await s.matchExact({ url: 'https://EXAMPLE.org/crdt-bench#results' })).bySource, [ID.finding])
    }))

  test(`[${name}] links, edges, hubs and supersede heads`, () =>
    withStore(async s => {
      const one = await s.links({ ids: [ID.task], depth: 1, limit: 20 })
      assert.deepEqual(one.map(n => [n.id, n.via, n.hop]), [[ID.engine, 'about', 1]])
      const typed = await s.links({ ids: [ID.engine], depth: 1, types: ['about'], limit: 20 })
      assert.deepEqual(typed.map(n => n.id).sort(), [ID.newDec, ID.oldDec, ID.rule, ID.task].sort())
      const edges = await s.edgesOf([ID.newDec], ['supersedes'])
      assert.deepEqual(edges, [{ type: 'supersedes', from: ID.newDec, to: ID.oldDec }])
      assert.equal(await s.supersedeHead(ID.oldDec), ID.newDec)
      assert.equal(await s.supersedeHead(ID.newDec), ID.newDec)
      assert.equal(await s.isHub(ID.task), false)
    }))

  test(`[${name}] get, getMany, stats and manifest data`, () =>
    withStore(async s => {
      const n = await s.get(ID.newDec)
      assert.equal(n?.title, 'Server decides budget conflicts')
      assert.equal(n?.sources[0]?.hash, 'abc1234')
      assert.equal(await s.get('dec_missing'), null)
      const many = await s.getMany([ID.rule, ID.task, 'nope'])
      assert.deepEqual([...many.keys()].sort(), [ID.rule, ID.task].sort())
      const st = await s.stats()
      assert.equal(st.notes, 10)
      assert.equal(st.byType.decision, 5)
      const m = await s.manifestData({ maxTopics: 5 })
      assert.deepEqual(m.rules.map(r => r.id), [ID.rule])
      assert.deepEqual(m.tasks.map(t => t.id), [ID.task])
      // Live non-entity nodes about the engine: the new decision, the rule and the task (the old one is superseded).
      assert.deepEqual(m.topics.map(t => [t.node.id, t.count]), [[ID.engine, 3]])
    }))

  test(`[${name}] put creates; versions agent notes; refuses human notes and stale versions`, () =>
    withStore(async s => {
      const made = await s.put(
        { type: 'decision', title: 'Retry pushes with backoff', summary: 'Exponential backoff up to 5 minutes.', body: '## Reason\nPush fails often.', status: 'inbox', confidence: 'agent', origin: 'local', author: 'claude', edges: { about: ['Sync Engine'] }, sources: [{ kind: 'file', ref: 'src/sync/push.ts', hash: 'def5678', at: '2026-10-22' }] },
        { now: NOW, newId },
      )
      assert.match(made.id, /^dec_/)
      assert.equal(made.status, 'inbox')
      assert.equal(made.version, 1)
      assert.ok((await s.search({ text: 'backoff pushes', limit: 3, includeInbox: true })).some(h => h.id === made.id))
      assert.deepEqual((await s.matchExact({ path: 'src/sync/push.ts' })).bySource, [made.id])
      assert.ok((await s.links({ ids: [made.id], depth: 1, limit: 5 })).some(x => x.id === ID.engine && x.via === 'about'))
      const v2 = await s.put({ type: 'decision', title: 'Cache sync cursors per device', summary: 'Now with a TTL.', body: 'b', status: 'active', confidence: 'agent', origin: 'local', author: 'claude' }, { id: ID.agent, expectedVersion: 1, now: NOW, newId })
      assert.equal(v2.version, 2)
      assert.equal(v2.summary, 'Now with a TTL.')
      await assert.rejects(s.put({ type: 'decision', title: 'Cache sync cursors per device', summary: 'x', body: '', status: 'active', confidence: 'agent', origin: 'local', author: 'claude' }, { id: ID.agent, expectedVersion: 1, now: NOW, newId }), (e: unknown) => e instanceof StoreError && e.code === 'conflict')
      await assert.rejects(s.put({ type: 'decision', title: 'x', summary: 'x', body: '', status: 'active', confidence: 'agent', origin: 'local', author: 'claude' }, { id: ID.newDec, now: NOW, newId }), (e: unknown) => e instanceof StoreError && e.code === 'invalid')
    }))

  test(`[${name}] setStatus accepts and retires`, () =>
    withStore(async s => {
      const accepted = await s.setStatus(ID.inbox, 'active', { now: NOW })
      assert.equal(accepted.status, 'active')
      assert.ok((await s.search({ text: 'batch hourly', limit: 5, includeInbox: false })).some(h => h.id === ID.inbox))
      const retired = await s.setStatus(ID.rule, 'archived', { now: NOW, validTo: '2026-10-22' })
      assert.equal(retired.validTo, '2026-10-22')
      assert.deepEqual((await s.manifestData({ maxTopics: 5 })).rules, [])
      await assert.rejects(s.setStatus('dec_missing', 'active', { now: NOW }), (e: unknown) => e instanceof StoreError && e.code === 'not_found')
    }))
}
