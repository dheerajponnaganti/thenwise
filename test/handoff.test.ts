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
