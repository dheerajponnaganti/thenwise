// The handoff: one agent stops (a usage limit, a kill, a crash) and the next agent, in any tool, starts from where it stopped.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { copilotConverter } from '../src/ingest/copilot.ts'
import { sessionPart } from '../src/ingest/parts.ts'
import { parseSession } from '../src/ingest/transcript.ts'

const row = (o: Record<string, unknown>) => JSON.stringify({ cwd: '/w/shop', sessionId: 's1', entrypoint: 'cli', ...o })
const user = (uuid: string, at: string, content: unknown) => row({ type: 'user', uuid, timestamp: at, message: { role: 'user', content } })
const assistant = (uuid: string, at: string, content: unknown, more = {}) => row({ type: 'assistant', uuid, timestamp: at, message: { role: 'assistant', content }, ...more })
const LIMIT = "You've hit your session limit · resets 10pm (Asia/Calcutta)"

test('a usage limit row stops the turn: it is not a reply, and the stored turn ends with the stop line', () => {
  const s = parseSession([
    user('u1', '2026-11-03T10:00:00Z', 'Split the price cache into eight shards'),
    assistant('a1', '2026-11-03T10:00:05Z', [{ type: 'text', text: 'Reading src/cache.ts first.' }]),
    assistant('a2', '2026-11-03T10:00:09Z', [{ type: 'text', text: LIMIT }], { isApiErrorMessage: true, apiErrorStatus: 429 }),
  ], 's1', '/home/u')
  const t = s.turns[0]!
  assert.deepEqual(t.reply, ['Reading src/cache.ts first.'])
  assert.equal(t.cutOff?.text, LIMIT)
  const turn = sessionPart(s, 'shop').nodes.find((n) => n.kind === 'turn')!
  assert.match(turn.text, /\(stopped by the tool: You've hit your session limit/)
})

test('an error the turn recovered from is no stop', () => {
  const s = parseSession([
    user('u1', '2026-11-03T10:00:00Z', 'Run the tests'),
    assistant('a1', '2026-11-03T10:00:05Z', [{ type: 'text', text: 'Overloaded' }], { isApiErrorMessage: true }),
    assistant('a2', '2026-11-03T10:00:20Z', [{ type: 'text', text: 'All 12 tests pass.' }]),
  ], 's1', '/home/u')
  assert.equal(s.turns[0]!.cutOff, undefined)
  assert.deepEqual(s.turns[0]!.reply, ['All 12 tests pass.'])
})

test('a tool call with no result at the end is the step the chat stopped in; a call with its result is not', () => {
  const s = parseSession([
    user('u1', '2026-11-03T10:00:00Z', 'Fix the failing test'),
    assistant('a1', '2026-11-03T10:00:05Z', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/src/cache.ts' } }]),
    user('r1', '2026-11-03T10:00:06Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    assistant('a2', '2026-11-03T10:00:10Z', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test   -- cache' } }]),
  ], 's1', '/home/u')
  assert.deepEqual(s.openCall, { name: 'Bash', detail: 'npm test -- cache', at: '2026-11-03T10:00:10Z' })
  const done = parseSession([
    user('u1', '2026-11-03T10:00:00Z', 'Read it'),
    assistant('a1', '2026-11-03T10:00:05Z', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/a.ts' } }]),
    user('r1', '2026-11-03T10:00:06Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  ], 's1', '/home/u')
  assert.equal(done.openCall, undefined)
})

test('a test run keeps its command and its result', () => {
  const s = parseSession([
    user('u1', '2026-11-03T10:00:00Z', 'Run the tests'),
    assistant('a1', '2026-11-03T10:00:05Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --test test/cache.test.ts' } }]),
    user('r1', '2026-11-03T10:00:09Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'fail 1', is_error: true }]),
  ], 's1', '/home/u')
  assert.deepEqual(s.turns[0]!.tests, [{ at: '2026-11-03T10:00:05Z', failed: true, cmd: 'node --test test/cache.test.ts' }])
})

test('Copilot: an abort and a shutdown on an error stop the turn the same way', () => {
  const conv = copilotConverter('c1', '/w/shop')
  const ev = (type: string, data: unknown, at: string) => JSON.stringify({ type, id: `${type}-${at}`, timestamp: at, data })
  const lines = [
    ev('user.message', { content: 'Split the cache' }, '2026-11-03T10:00:00Z'),
    ev('assistant.message', { content: 'On it.' }, '2026-11-03T10:00:02Z'),
    ev('abort', { reason: 'autopilot_credit_limit' }, '2026-11-03T10:00:04Z'),
  ].flatMap(conv)
  const s = parseSession(lines, 'c1', '/home/u')
  assert.equal(s.turns[0]!.cutOff?.text, 'stopped: autopilot_credit_limit')
  assert.deepEqual(s.turns[0]!.reply, ['On it.'])
  const down = parseSession([
    ev('user.message', { content: 'Go on' }, '2026-11-03T11:00:00Z'),
    ev('session.shutdown', { shutdownType: 'error', errorReason: 'quota exceeded' }, '2026-11-03T11:00:03Z'),
  ].flatMap(copilotConverter('c2', '/w/shop')), 'c2', '/home/u')
  assert.equal(down.turns[0]!.cutOff?.text, 'stopped on an error: quota exceeded')
  const routine = copilotConverter('c3', '/w/shop')(ev('session.shutdown', { shutdownType: 'routine' }, '2026-11-03T12:00:00Z'))
  assert.deepEqual(routine, [])
})

// ---- the handoff block, read from live chat files in a temp home ----

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfigSafe } from '../src/ingest/config.ts'
import { capHandoff, handoffBlock, liveChats } from '../src/hooks/handoff.ts'
import { runHook } from '../src/hooks/hook.ts'

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
const key = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, '-')

/** A home with a repo `shop`, its data folder and an optional config. */
function world(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tw-handoff-'))
  const proj = join(home, 'shop')
  mkdirSync(join(proj, 'src'), { recursive: true })
  git(proj, 'init', '-q')
  writeFileSync(join(proj, 'src/cache.ts'), 'export const a = 1\n')
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'Add a price cache')
  mkdirSync(join(home, '.thenwise'), { recursive: true })
  writeFileSync(join(home, '.thenwise/config.json'), JSON.stringify(config))
  const cfg = () => loadConfigSafe(home).config!

  return { home, proj, cfg }
}

/** A Claude Code chat in the home: a task, an edit, a failed test, then a usage limit. */
function claudeChat(home: string, proj: string, id: string, at = new Date(Date.now() - 5 * 60_000), prompt = 'Split the price cache into eight shards keyed by store id') {
  const t = (s: number) => new Date(at.getTime() + s * 1000).toISOString()
  const r = (o: Record<string, unknown>) => JSON.stringify({ cwd: proj, sessionId: id, entrypoint: 'cli', ...o })
  const lines = [
    r({ type: 'user', uuid: `${id}-u1`, timestamp: t(0), message: { role: 'user', content: prompt } }),
    r({ type: 'assistant', uuid: `${id}-a1`, timestamp: t(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: `${id}-e1`, name: 'Edit', input: { file_path: join(proj, 'src/cache.ts'), old_string: 'a = 1', new_string: 'a = 2' } }] } }),
    r({ type: 'user', uuid: `${id}-r1`, timestamp: t(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-e1`, content: 'ok' }] } }),
    r({ type: 'assistant', uuid: `${id}-a2`, timestamp: t(8), message: { role: 'assistant', content: [{ type: 'tool_use', id: `${id}-b1`, name: 'Bash', input: { command: 'npm test' } }] } }),
    r({ type: 'user', uuid: `${id}-r2`, timestamp: t(20), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-b1`, content: '1 failing', is_error: true }] } }),
    r({ type: 'assistant', uuid: `${id}-a3`, timestamp: t(22), message: { role: 'assistant', content: [{ type: 'text', text: 'The shard test fails on store ids with a dash; fixing the hash next.' }] } }),
    r({ type: 'assistant', uuid: `${id}-a4`, timestamp: t(24), isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: LIMIT }] } }),
  ]
  const dir = join(home, '.claude/projects', key(proj))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`)
  utimesSync(join(dir, `${id}.jsonl`), new Date(t(24)), new Date(t(24))) // a chat file was last written at its last row
}

/** A Copilot CLI chat in the home, stopped mid-step. */
function copilotChat(home: string, proj: string, id: string, at = new Date(Date.now() - 2 * 60_000)) {
  const t = (s: number) => new Date(at.getTime() + s * 1000).toISOString()
  const dir = join(home, '.copilot/session-state', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.yaml'), `cwd: ${proj}\n`)
  const ev = (type: string, data: unknown, s: number) => JSON.stringify({ type, id: `${id}-${s}`, timestamp: t(s), data })
  writeFileSync(join(dir, 'events.jsonl'), `${[
    ev('session.start', { context: { cwd: proj } }, 0),
    ev('user.message', { content: 'Add a jitter to the price fetch retries' }, 1),
    ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c1', name: 'view', arguments: { path: join(proj, 'src/cache.ts') } }] }, 2),
    ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'export const a = 1' } }, 3),
    ev('assistant.message', { content: 'Running the retry test.', toolRequests: [{ toolCallId: 'c2', name: 'bash', arguments: { command: 'npm test -- retry' } }] }, 4),
  ].join('\n')}\n`)
  utimesSync(join(dir, 'events.jsonl'), new Date(t(4)), new Date(t(4)))
}

test('Claude Code stops on a usage limit; the next session sees the task, the stop, the edits, the failed test and what is uncommitted', () => {
  const w = world()
  claudeChat(w.home, w.proj, 'cc-1')
  writeFileSync(join(w.proj, 'src/cache.ts'), 'export const a = 2\n') // the edit the chat made, not committed
  const b = handoffBlock(w.cfg(), w.proj, ['own'])
  assert.match(b, /^<memory-handoff tool="Claude Code" chat="ses:cc-1"/)
  assert.match(b, /state: stopped by the tool at .*You've hit your session limit/)
  assert.match(b, /task: "Split the price cache into eight shards keyed by store id"/)
  assert.match(b, /last reply: "The shard test fails on store ids with a dash/)
  assert.match(b, /edited in that chat \(newest first\): src\/cache\.ts \(1 edit\)/)
  assert.match(b, /last test: `npm test` at .*: failed, after editing src\/cache\.ts/)
  assert.match(b, /uncommitted now \(git status --short, 1 file\): M src\/cache\.ts/)
  assert.ok(b.length <= 600 * 4 + 20)
})

test('Copilot stopped mid-step; the block names the step that never got a result', () => {
  const w = world()
  copilotChat(w.home, w.proj, 'cp-1')
  const b = handoffBlock(w.cfg(), w.proj)
  assert.match(b, /tool="Copilot"/)
  assert.match(b, /state: stopped mid-step at .*Bash npm test -- retry, no result recorded/)
  assert.match(b, /task: "Add a jitter to the price fetch retries"/)
})

test('the newest chat of the project wins across tools, and the session asking is never its own handoff', () => {
  const w = world()
  claudeChat(w.home, w.proj, 'cc-old', new Date(Date.now() - 60 * 60_000))
  copilotChat(w.home, w.proj, 'cp-new', new Date(Date.now() - 60_000))
  assert.deepEqual(liveChats(w.cfg(), w.proj).map((c) => c.id), ['cp-new', 'cc-old'])
  assert.match(handoffBlock(w.cfg(), w.proj), /tool="Copilot"/)
  assert.match(handoffBlock(w.cfg(), w.proj, ['cp-new']), /tool="Claude Code"/)
})

test('a chat older than 7 days is no handoff', () => {
  const w = world()
  claudeChat(w.home, w.proj, 'cc-1')
  const later = Date.now() + 8 * 864e5
  assert.equal(handoffBlock(w.cfg(), w.proj, [], later), '')
})

test('no handoff from a [no-memory] chat, a paused folder, a forgotten chat or an excluded project', () => {
  const marked = world()
  claudeChat(marked.home, marked.proj, 'cc-1', undefined, 'Try something [no-memory]')
  assert.equal(handoffBlock(marked.cfg(), marked.proj), '')
  const off = world()
  claudeChat(off.home, off.proj, 'cc-1')
  writeFileSync(join(off.home, '.thenwise/config.json'), JSON.stringify({ off_projects: [off.proj] }))
  assert.equal(handoffBlock(off.cfg(), off.proj), '')
  const gone = world()
  claudeChat(gone.home, gone.proj, 'cc-1')
  writeFileSync(join(gone.home, '.thenwise/forgotten.json'), JSON.stringify({ sessions: ['cc-1'], projects: [], folders: [] }))
  assert.equal(handoffBlock(gone.cfg(), gone.proj), '')
  const excluded = world()
  claudeChat(excluded.home, excluded.proj, 'cc-1')
  writeFileSync(join(excluded.home, '.thenwise/config.json'), JSON.stringify({ exclude_projects: [`${key(excluded.proj)}`] }))
  assert.equal(handoffBlock(excluded.cfg(), excluded.proj), '')
})

test('a cut handoff keeps the state, the task and the last turn, and closes its tag', () => {
  const long = `<memory-handoff tool="Claude Code" chat="ses:x">\nstate: stopped\ntask: "t"\n${'x'.repeat(3000)}\nmore: y\n</memory-handoff>`
  const c = capHandoff(long, 300)
  assert.match(c, /^<memory-handoff[^\n]*\nstate: stopped\ntask: "t"/)
  assert.match(c, /\(cut\)\n<\/memory-handoff>$/)
  assert.ok(c.length <= 1200 + 20)
})

test('session start in both tools carries the handoff before the brief', () => {
  const keep = { HOME: process.env.HOME, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT }
  const w = world()
  claudeChat(w.home, w.proj, 'cc-1')
  copilotChat(w.home, w.proj, 'cp-1', new Date(Date.now() - 10 * 60_000))
  try {
    process.env.HOME = w.home
    const env = { dir: join(w.home, '.thenwise'), cli: 'none' }
    // Copilot opens: the newest other chat is Claude Code's, given in Copilot's top-level field.
    process.env.COPILOT_PLUGIN_ROOT = '/plugin'
    const cp = JSON.parse(runHook('session-start', { session_id: 'cp-2', source: 'startup', cwd: w.proj }, env))
    assert.match(cp.additionalContext, /<memory-handoff tool="Claude Code"/)
    // Claude Code opens after Copilot wrote last: the Copilot chat comes back under hookSpecificOutput.
    delete process.env.COPILOT_PLUGIN_ROOT
    copilotChat(w.home, w.proj, 'cp-3', new Date(Date.now() - 1000))
    const cc = JSON.parse(runHook('session-start', { session_id: 'cc-2', source: 'startup', cwd: w.proj }, env))
    assert.match(cc.hookSpecificOutput.additionalContext, /<memory-handoff tool="Copilot"/)
    // After a compaction the same session gets its resume block, never a handoff.
    const compact = runHook('session-start', { session_id: 'cc-2', source: 'compact', cwd: w.proj }, env)
    assert.doesNotMatch(compact, /memory-handoff/)
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('a long last turn still reaches the resume block after a compaction (a fixed 400 KB tail held no prompt)', () => {
  const w = world()
  const file = join(w.home, 'live.jsonl')
  const r = (o: Record<string, unknown>) => JSON.stringify({ cwd: w.proj, sessionId: 'big', entrypoint: 'cli', ...o })
  const big = 'x'.repeat(10_000)
  const lines = [r({ type: 'user', uuid: 'u1', timestamp: '2026-11-03T10:00:00Z', message: { role: 'user', content: 'Refactor the cache module' } })]
  for (let i = 0; i < 80; i++) lines.push(r({ type: 'assistant', uuid: `a${i}`, timestamp: '2026-11-03T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: big }] } }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  const out = runHook('session-start', { session_id: 'big', source: 'compact', cwd: w.proj, transcript_path: file }, { dir: join(w.home, '.thenwise'), cli: 'none' })
  assert.match(out, /prompt: Refactor the cache module/)
})

test('a 6 MB chat gives its handoff in time', () => {
  const w = world()
  claudeChat(w.home, w.proj, 'cc-big')
  const file = join(w.home, '.claude/projects', key(w.proj), 'cc-big.jsonl')
  const filler = JSON.stringify({ type: 'assistant', uuid: 'f', timestamp: new Date(Date.now() - 6 * 60_000).toISOString(), cwd: w.proj, entrypoint: 'cli', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(2000) }] } })
  writeFileSync(file, `${Array(3000).fill(filler).join('\n')}\n${execFileSync('cat', [file], { encoding: 'utf8' })}`)
  const t = Date.now()
  assert.match(handoffBlock(w.cfg(), w.proj), /state: stopped by the tool/)
  const ms = Date.now() - t
  console.log(`6 MB handoff: ${ms} ms`)
  assert.ok(ms < 3000, `${ms} ms`) // about 200 ms on a laptop; CI runners are slower
})

import { spawnSync } from 'node:child_process'

import { createServer } from '../src/server/stdio.ts'

test('memory_resume and `thenwise resume --here` start with the live handoff, with no store yet', () => {
  const keep = process.env.HOME
  const w = world()
  claudeChat(w.home, w.proj, 'cc-1')
  try {
    process.env.HOME = w.home
    const s = createServer(() => join(w.home, '.thenwise/graph.db'), w.proj)
    s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const r = s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_resume', arguments: {} } }) as any
    assert.match(r.result.content[0].text, /^## Live handoff[^\n]*\n<memory-handoff tool="Claude Code"/)
  } finally {
    process.env.HOME = keep
  }
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'resume', '--project', w.proj], { encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, CLAUDECODE: '' } })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /<memory-handoff tool="Claude Code"[\s\S]*state: stopped by the tool/)
})

test('inside an agent, the asking session is its own newest chat and is skipped', () => {
  const w = world()
  claudeChat(w.home, w.proj, 'cc-other')
  claudeChat(w.home, w.proj, 'cc-me', new Date(Date.now() - 20_000)) // written seconds ago: the asker
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'resume', '--project', w.proj], { encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, CLAUDECODE: '1' } })
  assert.match(cli.stdout, /chat="ses:cc-other"/)
  // A person's own COPILOT_HOME setting is no sign of running inside Copilot: nothing is skipped.
  const plain = spawnSync(process.execPath, ['src/cli.ts', 'resume', '--project', w.proj], { encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, CLAUDECODE: '', COPILOT_CLI: '', COPILOT_HOME: join(w.home, '.copilot') } })
  assert.match(plain.stdout, /chat="ses:cc-me"/)
})
