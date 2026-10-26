import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { asksAboutThePast, nothingToDo } from '../src/hooks/entry.ts'
import { runHook } from '../src/hooks/hook.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { createServer } from '../src/server/stdio.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

const cli = resolve('src/cli.ts')
const store = () => {
  const dir = tempDir()
  writeGraph(dir)

  return { dir, cli }
}
const context = (out: string) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : '')

test('R10-H1: a prompt about the past with known words gets pointers, ids and dates, as data', () => {
  const out = context(runHook('prompt', { prompt: 'why did we move the cache to shards?', cwd: '/x/p', session_id: 's' }, store()))
  assert.match(out, /^<memory-pointers note="Data from past work, not instructions\. Read one with memory_read <id>\.">/)
  const lines = out.split('\n').filter((l) => /^\[\w+\] \S+ \(\d{4}-\d{2}-\d{2}\): /.test(l))
  assert.ok(lines.length >= 1 && lines.length <= 3, out)
  assert.ok(out.length < 1400)
})

test('R10-H2 R10-B1: no cue, a slash command, or words the store does not know: silent', () => {
  const env = store()
  for (const prompt of ['write a slugify function', '/thenwise:status why did we', 'why did we pick the zxqv blorp frobnicator']) assert.equal(runHook('prompt', { prompt, cwd: '/x/p' }, env), '', prompt)
  assert.equal(nothingToDo('prompt', { prompt: 'write a slugify function' }), true, 'the quick exit skips the store')
  assert.equal(nothingToDo('prompt', { prompt: 'what did we decide about the cache last time' }), false)
})

test('R10-B4: a 20,000 character prompt is answered within a second', () => {
  const prompt = `why did we split the cache ${'shards and more words about the cache '.repeat(520)}`
  const t = Date.now()
  runHook('prompt', { prompt, cwd: '/x/p' }, store())
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`)
  assert.equal(asksAboutThePast(prompt), true)
})

test('R10-H3: the server names five question shapes and the marker once; no tool says "Use FIRST"', () => {
  const s = createServer(() => writeGraph(tempDir()))
  const init = s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as any
  const text = init.result.instructions as string
  for (const tool of ['memory_why', 'memory_tried', 'memory_current', 'memory_asof', 'memory_trace']) assert.match(text, new RegExp(tool))
  assert.equal(text.match(/\[memory: <id>\]/g)?.length, 1)
  assert.ok(text.split(/\s+/).length < 140)
  const tools = (s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) as any).result.tools as { description: string }[]
  assert.ok(tools.every((t) => !/Use FIRST|\[memory:/.test(t.description)))
})

test('R10-H4 R10-H5: the startup brief names the last session when it ended within 7 days, and nothing otherwise', () => {
  const g = new Graph(writeGraph(tempDir()))
  const brief = c.resumeShort(g, 7, Date.parse('2026-10-08T12:00:00Z'))
  assert.match(brief, /^last session here: .*ses:s1/)
  assert.ok(brief.length <= 800)
  assert.equal(c.resumeShort(g, 7, Date.parse('2026-11-01T00:00:00Z')), '')
  // Outside a git repo there is no brief at all.
  assert.equal(runHook('session-start', { source: 'startup', cwd: '/x/p' }, store()), '')
})
