// Sync progress: the person knows when the first sync or a rebuild runs, how far it got, and when it is done.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { incompleteNote, percent, progressLine, readProgress, writeProgress, writeTold } from '../src/core/progress.ts'
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
    writeProgress(d, { finished: at(0), chats: 3 })
    writeTold(d, new Date(Date.now() + 1000).toISOString())
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
  const keep = process.env.THENWISE_NO_UPDATE_CHECK
  process.env.THENWISE_NO_UPDATE_CHECK = '1' // the real worker runs the daily version check: no network in tests
  try {
    syncRun({ dir: d, cli: 'src/cli.ts' })
  } finally {
    keep === undefined ? delete process.env.THENWISE_NO_UPDATE_CHECK : (process.env.THENWISE_NO_UPDATE_CHECK = keep)
  }
  const p = readProgress(d)!
  assert.equal(p.kind, 'first')
  assert.equal(p.phase, 'done')
  assert.ok(p.finished && p.ms !== undefined)
})

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { stopIdle, stopStamp } from '../src/hooks/entry.ts'

test('stop hooks: a team member syncs a shared project after a reply at most every 10 minutes, after a cut at most once a minute; alone or in a private project, nothing runs', () => {
  const keep = process.env.THENWISE_HOME
  const d = dir()
  const repo = join(d, '..', 'shop')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  try {
    process.env.THENWISE_HOME = d
    assert.equal(stopIdle('stop'), true) // no team: the next session reads the chat file itself
    assert.equal(nothingToDo('stop', {}), true)
    writeFileSync(join(d, 'team.json'), '{}')
    assert.equal(stopIdle('stop'), false)
    // A private project: nothing to send.
    assert.equal(runHook('stop', { session_id: 's', cwd: join(d, '..') }, { dir: d, cli: 'none' }), '')
    assert.equal(existsSync(stopStamp(d)), false)
    writeFileSync(join(d, 'config.json'), JSON.stringify({ team: { share_chats: [repo] } }))
    assert.equal(runHook('stop', { session_id: 's', cwd: repo }, { dir: d, cli: 'none' }), '')
    assert.ok(existsSync(stopStamp(d)))
    assert.equal(stopIdle('stop'), true) // synced a moment ago
    assert.equal(stopIdle('stop', Date.now() + 11 * 60_000), false)
    assert.equal(stopIdle('stop-failure'), true) // a burst of errors: one sync a minute
    assert.equal(stopIdle('stop-failure', Date.now() + 61_000), false)
  } finally {
    keep === undefined ? delete process.env.THENWISE_HOME : (process.env.THENWISE_HOME = keep)
  }
})

test('#107: the stop hook syncs a project shared with team share-chats, and not one whose sharing is paused', () => {
  const keep = process.env.THENWISE_HOME
  const d = dir()
  const repo = join(d, '..', 'shop')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const shares = (status: string) => writeFileSync(join(d, 'team-shares.json'), JSON.stringify({ projects: { shop: { repo, status } }, chats: {}, removed: {}, deletes: [] }))
  try {
    process.env.THENWISE_HOME = d
    writeFileSync(join(d, 'team.json'), '{}')
    // Paused from the command line: a config entry for the same repo stays off.
    writeFileSync(join(d, 'config.json'), JSON.stringify({ team: { share_chats: [repo] } }))
    shares('paused')
    runHook('stop', { session_id: 's', cwd: repo }, { dir: d, cli: 'none' })
    assert.equal(existsSync(stopStamp(d)), false)
    // Shared from the command line only: the config names nothing.
    writeFileSync(join(d, 'config.json'), '{}')
    shares('active')
    runHook('stop', { session_id: 's', cwd: repo }, { dir: d, cli: 'none' })
    assert.ok(existsSync(stopStamp(d)))
  } finally {
    keep === undefined ? delete process.env.THENWISE_HOME : (process.env.THENWISE_HOME = keep)
  }
})

test('review F8: a killed sync that never finished keeps no prompt off the fast path', () => {
  const keep = { THENWISE_HOME: process.env.THENWISE_HOME, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT }
  const d = dir()
  first(d, { pid: 999_999_99 })
  try {
    process.env.THENWISE_HOME = d
    delete process.env.COPILOT_PLUGIN_ROOT
    assert.equal(nothingToDo('prompt', { prompt: 'add a button' }), true)
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('review F15: memory_resume says the memory is incomplete while the first sync runs', () => {
  const d = dir()
  first(d)
  const s = createServer(() => join(d, 'graph.db'), '/x/none')
  s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const t = (s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_resume', arguments: {} } }) as any).result.content[0].text
  assert.match(t, /first sync is 25% done/)
})

test('review F7: outside a repo a team member gets no late teammate check, so no other project is named as this one', () => {
  const keep = process.env.THENWISE_HOME
  const d = dir()
  writeFileSync(join(d, 'team.json'), '{}')
  try {
    process.env.THENWISE_HOME = d
    runHook('session-start', { session_id: 'out1', source: 'startup', cwd: join(d, '..') }, { dir: d, cli: 'none' })
    assert.equal(existsSync(join(d, 'hook-state', 'out1.late')), false)
  } finally {
    keep === undefined ? delete process.env.THENWISE_HOME : (process.env.THENWISE_HOME = keep)
  }
})

test('#103: a failed first-sync ingest is reported as failed, not done', () => {
  const d = dir()
  // A stand-in cli: every step answers, the ingest fails.
  const cli = join(d, '..', 'cli.mjs')
  writeFileSync(cli, "process.exit(process.argv[2] === 'ingest' ? 1 : 0)\n")
  syncRun({ dir: d, cli })
  const p = readProgress(d)!
  assert.ok(p.finished && p.failed)
  const line = syncNotice(d)
  assert.match(line, /^Thenwise: first sync failed; \/thenwise:logs shows why\.$/)
  assert.doesNotMatch(line, /done/)
})

test('#103: only the sync writes sync-progress.json, so a notice cannot erase finished', () => {
  const d = dir()
  first(d)
  const before = readFileSync(join(d, 'sync-progress.json'), 'utf8')
  assert.match(syncNotice(d), /first sync 25%/)
  assert.equal(readFileSync(join(d, 'sync-progress.json'), 'utf8'), before)
  assert.equal(syncNotice(d), '') // the told mark lives in its own file
})
