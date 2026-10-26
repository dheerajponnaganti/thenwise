import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { createServer, serveStdio } from '../src/server/stdio.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

const cli = resolve('src/cli.ts')
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }

function ready(dbPath: string, project = '/x/p') {
  const s = createServer(() => dbPath, project)
  s.handle(init)
  s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  let id = 1
  const call = (name: string, args: object) => s.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) as any

  return { s, call, textOf: (name: string, args: object) => call(name, args).result.content[0].text as string }
}

test('S5-H1: initialize names the server and echoes the protocol version', () => {
  const s = createServer(() => '/none')
  const r = s.handle(init) as any
  assert.equal(r.result.serverInfo.name, 'thenwise')
  assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+/)
  assert.equal(r.result.protocolVersion, '2025-06-18')
})

test('S5-H2: tools/list has seven tools, each naming its question shape; NEWER and the marker are said once, in the instructions', () => {
  const { s } = ready('/none')
  const tools = (s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) as any).result.tools
  assert.equal(tools.length, 7)
  for (const t of tools) assert.doesNotMatch(t.description, /Use FIRST|NEWER|\[memory:/)
  assert.match(tools.find((t: any) => t.name === 'memory_why').description, /^Why /)
  assert.match(tools.find((t: any) => t.name === 'memory_tried').description, /tried/)
  assert.match(tools.find((t: any) => t.name === 'memory_asof').description, /git show/)
  assert.deepEqual(tools.find((t: any) => t.name === 'memory_asof').inputSchema.required, ['date', 'query'])
  assert.deepEqual(tools.find((t: any) => t.name === 'memory_read').inputSchema.required, ['id'])
})

test('S5-H3: every tool answers against the fixture, and read prints a full passage', () => {
  const { textOf } = ready(writeGraph(tempDir()))
  assert.match(textOf('memory_search', { query: 'cache shards' }), /turn:t2/)
  assert.match(textOf('memory_current', { query: 'cache shards' }), /current:/)
  assert.match(textOf('memory_why', { query: 'eight shards' }), /because/)
  assert.match(textOf('memory_tried', { query: 'single cache file' }), /turn:t1/)
  assert.match(textOf('memory_asof', { date: '2026-10-06', query: 'cache' }), /asof 2026-10-06/)
  assert.match(textOf('memory_trace', { query: 'src/cache.ts' }), /trace/)
  assert.match(textOf('memory_read', { id: 'turn:t1#p0' }), /reverted it/)
})

test('S5-H4: 100 calls keep one connection and flat memory', () => {
  const { textOf } = ready(writeGraph(tempDir()))
  textOf('memory_search', { query: 'cache' })
  const before = process.memoryUsage().rss
  for (let i = 0; i < 100; i++) textOf('memory_search', { query: 'cache shards' })
  assert.ok(process.memoryUsage().rss - before < 60e6)
})

test('S5-H6: a replaced store file is seen by the next call', () => {
  const dir = tempDir()
  const db = writeGraph(dir)
  const { textOf } = ready(db)
  assert.match(textOf('memory_search', { query: 'zebras' }), /not recorded/)
  const next = writeGraph(tempDir(), 'Zebra topic')
  renameSync(next, db)
  assert.match(textOf('memory_search', { query: 'zebras' }), /turn:t9/)
})

test('S5-H7 and S5-B8: stdout carries only JSON lines, and the server exits when stdin closes', async () => {
  const dir = tempDir()
  writeGraph(dir)
  const p = spawn(process.execPath, [cli, 'mcp'], { env: { ...process.env, THENWISE_HOME: dir } })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stdin.write(`${JSON.stringify(init)}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'cache' } } })}\n`)
  await new Promise((r) => setTimeout(r, 1500))
  const t = Date.now()
  p.stdin.end()
  await new Promise((r) => p.on('exit', r))
  assert.ok(Date.now() - t < 1000)
  const lines = out.trim().split('\n')
  assert.equal(lines.length, 2)
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0')
})

test('S5-B1: an unknown tool is a JSON-RPC error and the server stays up', () => {
  const { s, call, textOf } = ready(writeGraph(tempDir()))
  assert.equal(call('memory_nope', {}).error.code, -32602)
  assert.match(textOf('memory_search', { query: 'cache' }), /turn:/)
  assert.ok(s)
})

test('S5-B2: bad arguments give a short answer, never a crash', () => {
  const { call, textOf } = ready(writeGraph(tempDir()))
  assert.equal(call('memory_search', {}).result.isError, true)
  assert.equal(call('memory_search', { query: '  ' }).result.isError, true)
  assert.equal(call('memory_asof', { query: 'cache' }).result.isError, true)
  assert.ok(textOf('memory_search', { query: 'cache '.repeat(2000) }).length < 5000)
  assert.match(textOf('memory_search', { query: 'the of and' }), /not recorded|searched/)
  assert.match(textOf('memory_asof', { date: 'yesterday', query: 'cache' }), /ISO date/)
  assert.match(textOf('memory_asof', { date: '2099-01-01', query: 'cache' }), /asof 2099/)
})

test('S5-B3: FTS syntax is treated as words', () => {
  const { call } = ready(writeGraph(tempDir()))
  for (const q of ['"', 'cache*', 'NEAR(cache shards', 'cache OR', '-cache', 'title:cache', 'a" OR "b']) {
    const r = call('memory_search', { query: q })
    assert.ok(r.result && !r.result.isError, q)
  }
})

test('S5-B4: broken lines, split chunks and glued messages', async () => {
  const input = new PassThrough()
  const lines: string[] = []
  const done = serveStdio(input, { write: (s) => lines.push(s) }, () => '/none')
  const a = JSON.stringify(init)
  const b = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })
  input.write('not json\n')
  input.write(a.slice(0, 20))
  input.write(`${a.slice(20)}\n${b}\n`)
  input.end()
  await done
  const got = lines.map((l) => JSON.parse(l))
  assert.equal(got[0].error.code, -32700)
  assert.equal(got[1].id, 0)
  assert.equal(got[2].id, 5)
})

test('S5-B5: a call before initialize is an error, a notification gets no reply', () => {
  const s = createServer(() => '/none')
  assert.equal((s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any).error.code, -32002)
  assert.equal(s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null)
  s.handle(init)
  assert.equal((s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }) as any).error.code, -32601)
})

test('S5-B6: no store yet is plain text, not an error', () => {
  const { call } = ready(join(tempDir(), 'graph.db'))
  const r = call('memory_search', { query: 'cache' }).result
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /No memory yet/)
})

test('S5-B9: ten calls in flight each get their own id', async () => {
  const input = new PassThrough()
  const lines: string[] = []
  const done = serveStdio(input, { write: (s) => lines.push(s) }, () => writeGraphOnce)
  input.write(`${JSON.stringify(init)}\n`)
  for (let i = 100; i < 110; i++) input.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'memory_search', arguments: { query: `cache ${i}` } } })}\n`)
  input.end()
  await done
  assert.deepEqual(lines.map((l) => JSON.parse(l).id).slice(1), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
})
const writeGraphOnce = writeGraph(tempDir())

test('S5-B10: reading an id that does not exist says not found and names near ids', () => {
  const { textOf } = ready(writeGraph(tempDir()))
  assert.match(textOf('memory_read', { id: 'turn:zzz' }), /not recorded/)
  assert.match(textOf('memory_read', { id: 't1' }), /Ids containing it: turn:t1/)
})

test('S5-B11: Telugu, Chinese and emoji queries do not crash', () => {
  const { call, textOf } = ready(writeGraph(tempDir()))
  for (const q of ['నమస్తే', '缓存分片', '🚀', 'cache నమస్తే 🚀 缓存']) assert.ok(!call('memory_search', { query: q }).result.isError, q)
  assert.match(textOf('memory_search', { query: 'నమస్తే' }), /turn:t2/)
})

test('S6-B10 and S3-H5: tools answer for the session repo, fall back to all projects, and stay global-only when off', () => {
  const repo = (name: string) => {
    const d = join(tempDir(), name)
    mkdirSync(d)
    execFileSync('git', ['init', '-q', d])
    return realpathSync(d)
  }
  const [a, b] = [repo('a'), repo('b')]
  const dir = tempDir()
  const db = writeGraph(dir, '', a)
  const home = process.env.THENWISE_HOME
  process.env.THENWISE_HOME = dir
  try {
    assert.match(ready(db, a).textOf('memory_why', { query: 'cache shards' }), /^why: [\s\S]*turn:t2/)
    const other = ready(db, b).textOf('memory_why', { query: 'cache shards' })
    assert.match(other, /^Nothing in this project; from all projects:[\s\S]*turn:t2/)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ off_projects: [a] }))
    assert.doesNotMatch(ready(db, a).textOf('memory_why', { query: 'cache shards' }), /turn:t2/)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ scope: 'all' }))
    assert.match(ready(db, b).textOf('memory_why', { query: 'cache shards' }), /^why: [\s\S]*turn:t2/, 'scope all: no fallback needed')
    // A chat run outside any repository (a home folder) is global: every project sees it.
    const home2 = tempDir()
    assert.match(ready(writeGraph(home2, '', '/x/p'), b).textOf('memory_why', { query: 'cache shards' }), /^why: [\s\S]*turn:t2/)
  } finally {
    if (home === undefined) delete process.env.THENWISE_HOME
    else process.env.THENWISE_HOME = home
  }
})
