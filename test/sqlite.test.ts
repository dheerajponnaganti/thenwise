import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { NodeInput } from '../src/core/store.ts'
import { StoreError } from '../src/core/store.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { exportVault } from '../src/store-sqlite/export.ts'
import { importVault, readVaultFiles } from '../src/store-sqlite/import.ts'
import { ftsQuery, SqliteStore } from '../src/store-sqlite/sqlite-store.ts'
import { ID, SEED } from './conformance.ts'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'vault-sample')
const NOW = '2026-10-22T12:00:00Z'
const input: NodeInput = { type: 'decision', title: 'Retry pushes with backoff', summary: 'Exponential backoff.', body: 'Push fails often.', status: 'active', confidence: 'agent', origin: 'local', author: 'claude', edges: { about: ['Sync Engine'] } }

test('import of the public fixture matches the Files backend', async () => {
  const files = new FilesStore(nodeIO, FIXTURE, null)
  await files.open()
  const sql = new SqliteStore(':memory:')
  const res = importVault(sql, readVaultFiles(FIXTURE))
  const fs = await files.stats()
  assert.deepEqual(await sql.stats(), fs)
  assert.equal(res.nodes, fs.notes)
  assert.equal(res.edges, fs.edges)
  assert.deepEqual(await sql.manifestData({ maxTopics: 20 }), await files.manifestData({ maxTopics: 20 }))

  // BM25 differs between the two (FTS5 normalises length over the whole row), so rankings may differ:
  // the test pins what must hold and prints how close they are.
  const questions = readFileSync(join(FIXTURE, '..', 'questions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string; question: string; action: { path: string } | null; gold: string[] })
  let sameOrder = 0
  let sameSet = 0
  let sameTop1 = 0
  let goldFiles = 0
  let goldSql = 0
  for (const q of questions) {
    const text = q.action ? q.action.path : q.question
    const a = (await files.search({ text, limit: 5, includeInbox: true })).map(h => h.id)
    const b = (await sql.search({ text, limit: 5, includeInbox: true })).map(h => h.id)
    if (a.join() === b.join()) sameOrder++
    if ([...a].sort().join() === [...b].sort().join()) sameSet++
    if (a[0] === b[0]) sameTop1++
    const hasGold = (ids: string[]) => ids.some(id => q.gold.includes(files.index.byId.get(id)?.path ?? ''))
    if (hasGold(a)) goldFiles++
    if (hasGold(b)) goldSql++
  }
  console.log(`top-5 over ${questions.length} questions: same order ${sameOrder}, same set ${sameSet}, same top-1 ${sameTop1}; gold in top 5: files ${goldFiles}, sqlite ${goldSql}`)
  assert.ok(questions.length >= 20)
  assert.ok(sameTop1 >= questions.length / 2, 'most questions share their first result')
  assert.ok(goldSql >= goldFiles - 5, 'SQLite finds the gold note about as often as Files')
  sql.close()
})

test('the exported vault reads back in Files mode with the same notes and edges', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, readVaultFiles(FIXTURE))
  const dir = mkdtempSync(join(tmpdir(), 'memv2-export-'))
  try {
    await exportVault(sql, dir, nodeIO, NOW)
    const back = new FilesStore(nodeIO, dir, null)
    await back.open()
    assert.deepEqual(await back.stats(), await sql.stats())
    const any = (await back.get(sql.dump()[0]!.record.id))!
    assert.match(readFileSync(join(dir, any.path), 'utf8'), /^---\nid: .*\n(.*\n)*managed_by: memory-v2\n/m)
  } finally {
    rmSync(dir, { recursive: true })
    sql.close()
  }
})

test('unknown front-matter fields survive import and export', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, { 'a.md': `---\nid: ${ID.home}\ntitle: A\nmood: calm\n---\nBody` })
  assert.deepEqual(sql.dump()[0]!.extra, { mood: 'calm' })
  const dir = mkdtempSync(join(tmpdir(), 'memv2-extra-'))
  try {
    await exportVault(sql, dir, nodeIO, NOW)
    assert.match(readFileSync(join(dir, 'a.md'), 'utf8'), /^mood: calm$/m)
  } finally {
    rmSync(dir, { recursive: true })
    sql.close()
  }
})

test('a file-backed database survives close and reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memv2-sqlite-'))
  const file = join(dir, 'memory.db')
  try {
    const a = new SqliteStore(file)
    importVault(a, SEED)
    const made = await a.put(input, { now: NOW, newId: p => `${p}_X${Math.random().toString(36).slice(2)}` })
    a.close()
    const b = new SqliteStore(file)
    assert.equal((await b.stats()).notes, Object.keys(SEED).length + 1)
    assert.equal((await b.get(made.id))?.title, input.title)
    assert.ok((await b.search({ text: 'backoff', limit: 3, includeInbox: true })).some(h => h.id === made.id))
    assert.equal(await b.supersedeHead(ID.oldDec), ID.newDec)
    assert.throws(() => importVault(b, SEED), (e: unknown) => e instanceof StoreError && e.code === 'invalid')
    b.close()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('a put that fails leaves nothing behind', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, SEED)
  // The same event id twice: the second put fails on the events table, after the node, its search text and edges were written.
  let n = 0
  const newId = (p: string) => (p === 'evt' ? 'evt_same' : `${p}_Y${++n}`)
  await sql.put(input, { now: NOW, newId })
  const before = await sql.stats()
  const events = () => (sql as unknown as { all: (s: string) => unknown[] }).all('SELECT * FROM events').length
  await assert.rejects(sql.put({ ...input, title: 'Second try at zebra caching' }, { now: NOW, newId }), /UNIQUE|constraint/i)
  assert.deepEqual(await sql.stats(), before)
  assert.equal(events(), 1)
  assert.deepEqual(await sql.search({ text: 'zebra', limit: 5, includeInbox: true }), [])
  assert.equal((await sql.get('dec_Y2')), null)
  sql.close()
})

test('every write appends an event', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, SEED)
  const made = await sql.put(input, { now: NOW, newId: p => `${p}_Z${Math.random().toString(36).slice(2)}` })
  await sql.setStatus(made.id, 'archived', { now: NOW })
  const rows = (sql as unknown as { all: (s: string) => { op: string; target: string }[] }).all('SELECT op, target FROM events ORDER BY seq')
  assert.deepEqual(rows.map(r => r.op), ['node.put', 'node.patch'])
  assert.ok(rows.every(r => r.target === made.id))
  sql.close()
})

test('a new note completes a dangling link', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, { 'a.md': `---\nid: ${ID.home}\ntitle: A\n---\nSee [[Later Note]].` })
  assert.equal((await sql.stats()).unresolved, 1)
  const made = await sql.put({ ...input, title: 'Later Note', edges: {} }, { now: NOW, newId: p => `${p}_W1` })
  assert.equal((await sql.stats()).unresolved, 0)
  assert.deepEqual((await sql.links({ ids: [ID.home], depth: 1, limit: 5 })).map(x => x.id), [made.id])
  sql.close()
})

test('search text is safe: quotes, operators and punctuation never reach FTS5 as syntax', async () => {
  const sql = new SqliteStore(':memory:')
  importVault(sql, SEED)
  for (const text of ['"', 'conflict AND OR NOT NEAR(', 'sync* -budget "unclosed', '(((', 'src/sync/ -/-', "O'Brien; DROP TABLE nodes"]) await sql.search({ text, limit: 5, includeInbox: true })
  assert.equal(ftsQuery('say "hi" now'), '"say" OR "hi"')
  assert.ok((await sql.search({ text: 'sync AND budget', limit: 5, includeInbox: false })).length > 0)
  assert.equal((await sql.stats()).notes, 10)
  sql.close()
})
