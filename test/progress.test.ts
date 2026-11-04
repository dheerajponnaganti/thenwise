// Sync progress: the person knows when the first sync or a rebuild runs, how far it got, and when it is done.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { incompleteNote, percent, progressLine, readProgress, writeProgress } from '../src/core/progress.ts'
import { nothingToDo } from '../src/hooks/entry.ts'
import { runHook, syncNotice, syncRun } from '../src/hooks/hook.ts'
import { createServer } from '../src/server/stdio.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

const dir = () => {
  const d = join(mkdtempSync(join(tmpdir(), 'tw-prog-')), '.thenwise')
  mkdirSync(d, { recursive: true })

  return d
}
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const first = (d: string, more = {}) => writeProgress(d, { kind: 'first', phase: 'copying chats', done: 500, total: 1000, started: at(40_000), pid: process.pid, ...more }, true)

test('the percentage covers both halves of a sync: copying chats, then building the store', () => {
  const p = { kind: 'first' as const, phase: 'copying chats', done: 500, total: 1000, started: at(1000), updated: at(0), pid: process.pid }
  assert.equal(percent(p), 25)
  assert.equal(percent({ ...p, phase: 'building the store' }), 75)
  assert.equal(percent({ ...p, finished: at(0) }), 100)
  assert.match(progressLine(p), /^first sync 25% \(copying chats, 500 of 1,000 chats\), started 1 s ago$/)
  assert.equal(progressLine({ ...p, finished: at(0), chats: 2512, ms: 84_000 }), 'first sync done: 2,512 chats remembered in 84 s')
  assert.equal(progressLine({ ...p, pid: 999_999_99 }), '') // a dead sync says nothing
})

test('the person hears about the first sync at most once a minute, then once that it is done; an automatic sync stays quiet', () => {
  const d = dir()
  first(d)
  assert.match(syncNotice(d), /^Thenwise: first sync 25% .*\/thenwise:status shows more\.$/)
  assert.equal(syncNotice(d), '') // told a moment ago
  assert.match(syncNotice(d, Date.now() + 61_000), /first sync/)
  writeProgress(d, { phase: 'done', finished: new Date(Date.now() + 61_500).toISOString(), chats: 40, ms: 9000 })
  assert.equal(syncNotice(d, Date.now() + 62_000), 'Thenwise: first sync done: 40 chats remembered in 9 s.')
  assert.equal(syncNotice(d, Date.now() + 120_000), '')
  const auto = dir()
  first(auto, { kind: 'auto' })
  assert.equal(syncNotice(auto), '')
})

test('the prompt hook shows the progress line in Claude Code and lets the prompt through the fast path only while there is news', () => {
  const keep = { THENWISE_HOME: process.env.THENWISE_HOME, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT }
  const d = dir()
  first(d)
  try {
    process.env.THENWISE_HOME = d
    delete process.env.COPILOT_PLUGIN_ROOT
    assert.equal(nothingToDo('prompt', { prompt: 'add a button' }), false)
    const out = JSON.parse(runHook('prompt', { prompt: 'add a button', cwd: '/x' }, { dir: d, cli: 'none' }))
    assert.match(out.systemMessage, /^Thenwise: first sync 25%/)
    assert.equal(nothingToDo('prompt', { prompt: 'add a button' }), false) // still running: the next minute may bring news
    writeProgress(d, { finished: at(0), chats: 3, told: new Date(Date.now() + 1000).toISOString() })
    assert.equal(nothingToDo('prompt', { prompt: 'add a button' }), true)
    // Copilot shows no hook text to the person: nothing is spent there.
    first(d)
    process.env.COPILOT_PLUGIN_ROOT = '/plugin'
    assert.equal(nothingToDo('prompt', { prompt: 'add a button' }), true)
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('while the first sync runs, memory answers say the memory is incomplete', () => {
  const d = dir()
  const db = writeGraph(tempDir())
  first(d, { kind: 'rebuild', phase: 'building the store' })
  assert.match(incompleteNote(d), /rebuild after an update is 75% done/)
  // The server reads the note from the store's own folder.
  const s = createServer(() => join(d, 'graph.db'), '/x/p')
  s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const none = (s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_why', arguments: { query: 'cache shards' } } }) as any).result.content[0].text
  assert.match(none, /^No memory yet: the first sync is 75% done/)
  const withDb = createServer(() => db, '/x/p')
  withDb.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  writeProgress(join(db, '..'), { kind: 'first', phase: 'copying chats', done: 1, total: 4, started: at(1000), pid: process.pid }, true)
  const ans = (withDb.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_why', arguments: { query: 'cache shards' } } }) as any).result.content[0].text
  assert.match(ans, /^Note: Thenwise's first sync is 12% done/)
})

test('session start in Claude Code says the first sync started; the agent hears it too', () => {
  const keep = { THENWISE_SYNC: process.env.THENWISE_SYNC, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT, THENWISE_HOME: process.env.THENWISE_HOME }
  const d = dir()
  try {
    process.env.THENWISE_SYNC = 'on'
    process.env.THENWISE_HOME = d
    delete process.env.COPILOT_PLUGIN_ROOT
    // cli is a missing file: the detached sync starts and exits at once, which is all this test needs.
    const out = JSON.parse(runHook('session-start', { source: 'startup', cwd: '/x/p', session_id: 's' }, { dir: d, cli: join(d, 'missing.js') }))
    assert.match(out.systemMessage, /first sync started/)
    assert.match(out.hookSpecificOutput.additionalContext, /first sync started/)
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('a sync writes its progress: first, then done with the time it took', () => {
  const d = dir()
  syncRun({ dir: d, cli: 'src/cli.ts' })
  const p = readProgress(d)!
  assert.equal(p.kind, 'first')
  assert.equal(p.phase, 'done')
  assert.ok(p.finished && p.ms !== undefined)
})

import { existsSync, writeFileSync } from 'node:fs'

import { stopIdle, stopStamp } from '../src/hooks/entry.ts'

test('stop hooks: a team member syncs after a reply at most every 10 minutes, at once after a cut; alone, nothing runs', () => {
  const keep = process.env.THENWISE_HOME
  const d = dir()
  try {
    process.env.THENWISE_HOME = d
    assert.equal(stopIdle('stop'), true) // no team: the next session reads the chat file itself
    assert.equal(nothingToDo('stop', {}), true)
    writeFileSync(join(d, 'team.json'), '{}')
    assert.equal(stopIdle('stop'), false)
    assert.equal(runHook('stop', { session_id: 's', cwd: '/x/p' }, { dir: d, cli: 'none' }), '')
    assert.ok(existsSync(stopStamp(d)))
    assert.equal(stopIdle('stop'), true) // synced a moment ago
    assert.equal(stopIdle('stop', Date.now() + 11 * 60_000), false)
    assert.equal(stopIdle('stop-failure'), false) // a usage limit: send it now
  } finally {
    keep === undefined ? delete process.env.THENWISE_HOME : (process.env.THENWISE_HOME = keep)
  }
})
