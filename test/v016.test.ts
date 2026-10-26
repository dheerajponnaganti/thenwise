import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { compare, score, summarize, type GoldLine } from '../bench/gold/run.ts'
import { logger } from '../src/core/log.ts'
import { runHook, seen } from '../src/hooks/hook.ts'
import { parseSession } from '../src/ingest/transcript.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'
import { chatText, World } from './world.ts'

const graph = () => new Graph(writeGraph(tempDir()))

test('R6-H1: rank gives the records in the order the text commands show them', () => {
  const g = graph()
  for (const cmd of ['search', 'why', 'tried', 'current'] as const) {
    const ids = c.rank(g, cmd, 'cache').items.map((x) => x.h.node.id)
    const text = cmd === 'search' ? c.search(g, 'cache') : cmd === 'why' ? c.why(g, 'cache') : cmd === 'tried' ? c.tried(g, 'cache') : c.current(g, 'cache')
    // Full results read "1. [kind] id", one-liners "4. id date ...".
    const shown = [...text.matchAll(/^\d+\. (?:\[\w+\] )?(\S+)/gm)].map((m) => m[1]!)
    assert.ok(shown.length > 0, cmd)
    assert.deepEqual(shown, ids.slice(0, shown.length), cmd)
  }
  const asof = c.rank(g, 'asof', 'cache', { date: '2026-10-06' }).items.map((x) => x.h.node.id)
  assert.ok(asof.length && !asof.includes('commit:proj:abcdef1234567')) // dated after the cutoff
})

test('R6-H2 R6-H3: the benchmark scores gold ranks, sums them up, and lists what moved', () => {
  const g = graph()
  const lines: GoldLine[] = [
    { id: 'q1', kind: 'tried', cmd: 'tried', query: 'single cache file', gold: ['turn:t1'] },
    { id: 'q2', kind: 'when', cmd: 'search', query: 'cache module', gold: ['pr:proj#7'], must_not: ['turn:t1'] },
    { id: 'q3', kind: 'why', cmd: 'why', query: 'cache', gold: ['note:missing'] },
  ]
  const rows = lines.map((l) => score(g, l, true))
  assert.equal(rows[0]!.rank, 1)
  assert.ok(rows[1]!.rank! >= 1)
  assert.equal(rows[2]!.rank, null)
  assert.ok(rows.every((r) => r.chars > 0))
  const s = summarize(rows)
  assert.equal(s.n, 3)
  assert.ok(s.r10 >= 2 / 3 - 1e-9 && s.r10 < 1)
  const moved = compare(rows, [{ ...rows[0]!, rank: 4 }, rows[1]!, { ...rows[2]!, rank: 2 }])
  assert.deepEqual(moved, ['q1 (tried): 1 -> 4', 'q3 (why): - -> 2'])
})

test('R6-B1: a bare #n reaches the exact lane only next to PR, pull or the repo name', () => {
  const g = graph()
  const pr = (q: string) => g.exact(q).some((e) => e.id === 'pr:proj#7')
  assert.equal(pr('the #7 cause of slow ingest'), false)
  assert.equal(pr('step #7'), false)
  assert.equal(pr('PR #7'), true)
  assert.equal(pr('pull request 7'), true)
  assert.equal(pr('#7 in proj'), true)
})

test('R6-B2: twenty hint marks written at once are all kept', async () => {
  const dir = tempDir()
  const files = Array.from({ length: 20 }, (_, i) => `/x/p/f${i}.ts`)
  const code = (f: string) => `import('${resolve('src/hooks/hook.ts')}').then((h) => h.markSeen({ dir: ${JSON.stringify(dir)}, cli: '' }, 's', undefined, ${JSON.stringify(f)}))`
  await Promise.all(files.map((f) => new Promise((r) => spawn(process.execPath, ['--input-type=module', '-e', code(f)]).on('exit', r))))
  for (const f of files) assert.ok(seen({ dir, cli: '' }, 's', undefined, f), f)
  const state = readdirSync(join(dir, 'hook-state'))
  assert.equal(state.length, 1)
  assert.equal(readFileSync(join(dir, 'hook-state', state[0]!), 'utf8').trim().split('\n').length, 20)
})

test('R6-B3: a heredoc commit message gives its first line as the subject', () => {
  const text = chatText('h1', { turns: [{ prompt: 'commit it', commit: { subject: "$(cat <<'EOF'\nFix the cache warmup\n\nLonger body.\nEOF\n)", sha: 'abc1234def' } }] }, '/x/p')
  const s = parseSession(text, 'h1', '/h')
  assert.deepEqual(s.turns.flatMap((t) => t.commitMsgs.map((m) => m.subject)), ['Fix the cache warmup'])
})

test('R6-B4: status shows the structured log, with no hooks.log', () => {
  const dir = tempDir()
  delete process.env.THENWISE_LOG
  logger('sync', dir).info('sync_ingest', { msg: 'ingest done in 12 ms' })
  process.env.THENWISE_LOG = 'off'
  const out = runHook('status', {}, { dir, cli: '' })
  assert.match(out, /sync sync_ingest msg="ingest done in 12 ms"/)
  assert.ok(!readdirSync(dir).includes('hooks.log'))
})

test('R6-B5: a store frozen with --until keeps its cutoff when a later run updates it', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: 'zebra early', reply: 'early zebra plan', at: '2026-10-01T10:00:00Z' }] })
    w.chat('s2', { turns: [{ prompt: 'zebra late', reply: 'late zebra plan', at: '2026-10-03T10:00:00Z' }] })
    w.archive()
    const until = '2026-10-02T00:00:00Z'
    w.ingest('g.db', { until })
    w.ingest('g.db') // what forget and a sync do
    const db = new DatabaseSync(w.path('g.db'), { readOnly: true })
    const ids = db.prepare('SELECT id FROM nodes').all().map((r) => r.id)
    assert.ok(ids.includes('turn:s1-0') && !ids.includes('turn:s2-0'))
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'until'").get() as { value: string }).value, until)
    db.close()
  } finally {
    w.destroy()
  }
})

test('R6-B6: a store from before 0.1.6 rebuilds once, then updates', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: 'zebra', reply: 'a zebra plan' }] })
    w.archive()
    w.ingest('g.db')
    const db = new DatabaseSync(w.path('g.db'))
    const sig = (db.prepare("SELECT value FROM ingest_state WHERE key = 'signature'").get() as { value: string }).value
    db.prepare("UPDATE ingest_state SET value = ? WHERE key = 'signature'").run(sig.replace('"v":2', '"v":1'))
    db.close()
    assert.equal(w.ingest('g.db').mode, 'full')
    assert.equal(w.ingest('g.db').mode, 'unchanged')
  } finally {
    w.destroy()
  }
})
