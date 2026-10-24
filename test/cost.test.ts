import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { costOf, report, weighted } from '../bench/cost/report.ts'

// A synthetic transcript with known usage. Message m1 is written as two lines (two content blocks), as Claude Code does.
const line = (o: object) => JSON.stringify(o)
const u = (input: number, cr: number, cw: number, output: number) => ({ input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: output })
const text = [
  line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'first question' } }),
  line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:01Z', message: { id: 'm1', role: 'assistant', usage: u(10, 1000, 200, 5), content: [{ type: 'text', text: 'Looking. [memory: graph]' }] } }),
  line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-01T10:00:02Z', message: { id: 'm1', role: 'assistant', usage: u(10, 1000, 200, 5), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'memory search cache' } }] } }),
  line({ type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', uuid: 'a3', timestamp: '2026-10-01T10:00:04Z', message: { id: 'm2', role: 'assistant', usage: u(20, 2000, 0, 40), content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls; ~/.memory/bin/memory why x' } }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git status' } }] } }),
  line({ type: 'user', uuid: 'u3', timestamp: '2026-10-01T10:00:05Z', message: { role: 'user', content: 'second question' } }),
  line({ type: 'assistant', uuid: 'a4', timestamp: '2026-10-01T10:00:06Z', message: { id: 'm3', role: 'assistant', usage: u(1, 0, 0, 1), content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n')

test('known usage gives known totals, a repeated message id counts once', () => {
  const c = costOf(text, 's1')
  assert.deepEqual([c.turns, c.calls], [2, 3])
  assert.deepEqual([c.input, c.cacheRead, c.cacheWrite, c.output], [31, 3000, 200, 46])
  assert.equal(c.weighted, 31 + 300 + 250 + 230)
  assert.equal(weighted({ input: 1, cacheRead: 10, cacheWrite: 4, output: 2 }), 1 + 1 + 5 + 10)
  assert.equal(c.memoryCalls, 2) // `memory search` and `.memory/bin/memory`; git status is not counted
  assert.equal(c.credits, 1)
})

test('report lists interactive sessions only and honours --since', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memv2-cost-'))
  mkdirSync(join(dir, '-p'))
  mkdirSync(join(dir, '-x-eval-ws-y'))
  writeFileSync(join(dir, '-p/s1.jsonl.gz'), gzipSync(text))
  writeFileSync(join(dir, '-p/s2.jsonl.gz'), gzipSync(text.replaceAll('"cli"', '"sdk-cli"')))
  writeFileSync(join(dir, '-x-eval-ws-y/s3.jsonl.gz'), gzipSync(text))
  const r = report(dir)
  assert.deepEqual(r.sessions.map((s) => s.session), ['s1'])
  assert.equal(r.total.output, 46)
  assert.equal(report(dir, '2026-10-02').sessions.length, 0)
})
