import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { cap, runHook, takeLock, trimTrace } from '../src/hooks/hook.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

const cli = resolve('src/cli.ts')
const withStore = () => {
  const dir = tempDir()
  writeGraph(dir)

  return { dir, cli }
}
// An empty projects folder keeps the background sync away from any real history.
const emptyConfig = (dir: string) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ exclude_projects: ['*'] }))
const logOf = (dir: string) => (existsSync(join(dir, 'hooks.log')) ? readFileSync(join(dir, 'hooks.log'), 'utf8') : '')
const wait = async (ok: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !ok(); t += 100) await new Promise((r) => setTimeout(r, 100))
}

test('S6-H1: claude plugin validate passes', { skip: spawnSync('claude', ['--version']).status !== 0 }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', '.'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('S6-H3 and S6-H7: session start returns fast, the sync runs on after it, a second sync is covered below', async () => {
  const env = withStore()
  emptyConfig(env.dir)
  const t = Date.now()
  const a = spawnSync(process.execPath, [cli, 'hook', 'session-start'], { input: JSON.stringify({ source: 'startup', cwd: '/x/p' }), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: env.dir, HOME: env.dir } })
  assert.equal(a.status, 0)
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`)
  spawnSync(process.execPath, [cli, 'hook', 'session-start'], { input: JSON.stringify({ source: 'startup', cwd: '/x/p' }), env: { ...process.env, THENWISE_HOME: env.dir, HOME: env.dir } })
  await wait(() => /backup (done|failed)/.test(logOf(env.dir)))
  const log = logOf(env.dir)
  assert.match(log, /archive done/)
  assert.match(log, /ingest done/)
  assert.ok(!existsSync(join(env.dir, 'sync.lock')))
})

test('S6-B4: a lock held by a dead pid is taken over, a live one is respected', () => {
  const dir = tempDir()
  const lock = join(dir, 'sync.lock')
  writeFileSync(lock, '2147483646')
  assert.equal(takeLock(lock), true)
  assert.equal(takeLock(lock, process.pid + 1), false)
})

test('S6-H7: two syncs started together run once', async () => {
  const env = withStore()
  emptyConfig(env.dir)
  const e = { ...process.env, THENWISE_HOME: env.dir, HOME: env.dir }
  const run = () => new Promise((r) => spawn(process.execPath, [cli, 'hook', 'sync-run'], { env: e }).on('exit', r))
  await Promise.all([run(), run()])
  const log = logOf(env.dir)
  assert.equal(log.match(/archive done/g)?.length, 1)
  assert.match(log, /sync skipped/)
})

test('S6-H4: the compact hook adds a resume brief of at most 1,500 tokens', () => {
  const env = withStore()
  const out = JSON.parse(runHook('session-start', { source: 'compact', cwd: '/x/p' }, env))
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
  const text: string = out.hookSpecificOutput.additionalContext
  assert.match(text, /memory-resume/)
  assert.match(text, /Last compaction summary/)
  assert.ok(text.length / 4 <= 1520)
})

test('S6-H5: Read adds the file history once per file per session', () => {
  const env = withStore()
  const input = { tool_name: 'Read', tool_input: { file_path: '/x/p/src/cache.ts' }, session_id: 's1', cwd: '/x/p' }
  const first = runHook('read', input, env)
  assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /memory-history file="src\/cache.ts"/)
  assert.equal(runHook('read', input, env), '')
  assert.notEqual(runHook('read', { ...input, session_id: 's2' }, env), '')
})

test('S6-B1: no store yet is silent and writes one log line', () => {
  const dir = tempDir()
  assert.equal(runHook('session-start', { source: 'compact', cwd: '/x/p' }, { dir, cli }), '')
  assert.equal(runHook('read', { tool_name: 'Read', tool_input: { file_path: '/a/b' }, session_id: 's', cwd: '/a' }, { dir, cli }), '')
  assert.equal(logOf(dir).trim().split('\n').length, 2)
})

test('S6-B5: a file with no history gets no hint', () => {
  const env = withStore()
  assert.equal(runHook('read', { tool_name: 'Read', tool_input: { file_path: '/elsewhere/photo.png' }, session_id: 's', cwd: '/x/p' }, env), '')
})

test('S6-B6: hook output is cut to its token cap', () => {
  const long = `${'- [decision] x\n   | because '.repeat(2000)}`
  const block = trimTrace(long, 'f')
  assert.ok(block.length / 4 < 700)
  assert.match(cap('a\n'.repeat(5000), 100), /\(cut\)$/)
})

test('S6-B7: only Read has a hook entry, so Grep and Glob get no hint', () => {
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks
  assert.equal(hooks.PostToolUse.length, 1)
  assert.equal(hooks.PostToolUse[0].matcher, 'Read')
  assert.equal(runHook('read', { tool_name: 'Grep', tool_input: {}, session_id: 's' }, withStore()), '')
})

test('A7: a hook fed garbage still exits 0 and prints nothing to the chat', () => {
  const dir = tempDir()
  for (const name of ['session-start', 'read', 'nope']) {
    const r = spawnSync(process.execPath, [cli, 'hook', name], { input: 'not json', encoding: 'utf8', env: { ...process.env, THENWISE_HOME: dir } })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('S6-B10: with memory off for the project, compact and Read add nothing', () => {
  const env = withStore()
  writeFileSync(join(env.dir, 'config.json'), JSON.stringify({ off_projects: ['/x/p'] }))
  const run = (name: string, input: object) => spawnSync(process.execPath, [cli, 'hook', name], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: env.dir } })
  assert.equal(run('session-start', { source: 'compact', cwd: '/x/p' }).stdout, '')
  assert.equal(run('read', { tool_name: 'Read', tool_input: { file_path: '/x/p/src/cache.ts' }, session_id: 's', cwd: '/x/p' }).stdout, '')
  assert.match(logOf(env.dir), /memory is off for \/x\/p/)
})

test('S6-B2: on a Node without FTS5 the hooks stay silent, and session start says it once', { skip: !existsSync('dist/cli.js') || spawnSync('npx', ['-y', 'node@22.15.0', '--version']).status !== 0 }, () => {
  const old = (name: string) => spawnSync('npx', ['-y', 'node@22.15.0', resolve('dist/cli.js'), 'hook', name], { input: '{}', encoding: 'utf8' })
  const start = old('session-start')
  assert.equal(start.status, 0)
  assert.match(start.stdout, /needs Node 22.16/)
  const read = old('read')
  assert.equal(read.status, 0)
  assert.equal(read.stdout + read.stderr, '')
})

test('THENWISE_SYNC=off: session start starts no sync', () => {
  const env = withStore()
  const r = spawnSync(process.execPath, [cli, 'hook', 'session-start'], { input: JSON.stringify({ source: 'startup', cwd: '/x/p' }), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: env.dir, HOME: env.dir, THENWISE_SYNC: 'off' } })
  assert.equal(r.status, 0)
  assert.match(logOf(env.dir), /sync off/)
  assert.doesNotMatch(logOf(env.dir), /sync started/)
})
