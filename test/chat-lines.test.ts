// #9: chats are read a gzip member at a time, so a long chat does not cost several times its size in memory.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { chatLines, parseSession } from '../src/ingest/transcript.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'tw-lines-'))
const members = (path: string, ...parts: (string | Buffer)[]) => {
  writeFileSync(path, '')
  for (const p of parts) appendFileSync(path, gzipSync(p))

  return path
}

test('#9: chat lines match a whole read, for one member, many members and no last newline', () => {
  const d = dir()
  assert.deepEqual([...chatLines(members(join(d, 'one.gz'), 'a\nb\n'))], ['a', 'b'])
  assert.deepEqual([...chatLines(members(join(d, 'many.gz'), 'a\n', 'b\nc\n'))], ['a', 'b', 'c'])
  assert.deepEqual([...chatLines(members(join(d, 'open.gz'), 'a\nb'))], ['a', 'b'])
  assert.deepEqual([...chatLines(members(join(d, 'gap.gz'), 'a\n\nb\n'))], ['a', '', 'b'])
  assert.deepEqual([...chatLines(members(join(d, 'none.gz'), ''))], [])
  writeFileSync(join(d, 'empty.gz'), '')
  assert.deepEqual([...chatLines(join(d, 'empty.gz'))], [])
})

test('#9: a line or a character that crosses members stays whole', () => {
  const d = dir()
  assert.deepEqual([...chatLines(members(join(d, 'line.gz'), 'x\nsta', 'rt-', 'end\ny\n'))], ['x', 'start-end', 'y'])
  const bytes = Buffer.from('café \u{1F600}\n')
  assert.deepEqual([...chatLines(members(join(d, 'char.gz'), bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)))], ['café \u{1F600}'])
})

test('#9: a member larger than the read window is read whole', () => {
  const d = dir()
  // Random hex barely compresses, so this member is well past the 8 MB window, followed by a small last member.
  const big = `${'0123456789abcdef'.repeat(1)}${Array.from({ length: 1 << 18 }, (_, i) => (Math.imul(i, 2654435761) >>> 0).toString(16)).join('').repeat(8)}`
  const lines = [...chatLines(members(join(d, 'big.gz'), `${big}\n`, 'last\n'))]
  assert.equal(lines.length, 2)
  assert.equal(lines[0], big)
  assert.equal(lines[1], 'last')
})

test('#9: a broken chat fails as it did with a whole read', () => {
  const d = dir()
  const whole = gzipSync(`${'hello world\n'.repeat(1000)}`)
  writeFileSync(join(d, 'cut.gz'), whole.subarray(0, whole.length - 20))
  assert.throws(() => [...chatLines(join(d, 'cut.gz'))])
  const flipped = Buffer.from(whole)
  flipped[flipped.length - 6] = flipped[flipped.length - 6]! ^ 0xff // the checksum in the trailer
  writeFileSync(join(d, 'sum.gz'), flipped)
  assert.throws(() => [...chatLines(join(d, 'sum.gz'))], /incorrect data check/)
})

test('#9: a gzip file with a different header still reads', () => {
  const d = dir()
  const plain = gzipSync('a\nb\n')
  // The same stream with the FNAME flag and a name, as command line gzip writes it.
  const named = Buffer.concat([plain.subarray(0, 3), Buffer.from([8]), plain.subarray(4, 10), Buffer.from('x.jsonl\0'), plain.subarray(10)])
  writeFileSync(join(d, 'named.gz'), named)
  assert.deepEqual([...chatLines(join(d, 'named.gz'))], ['a', 'b'])
})

test('#9: parsing lines gives the same session as parsing the whole text', () => {
  const d = dir()
  const row = (type: string, uuid: string, at: string, content: unknown) => JSON.stringify({ type, uuid, timestamp: at, cwd: '/p', sessionId: 's', entrypoint: 'cli', message: { role: type, content } })
  const text = `${row('user', 'u1', '2026-10-01T10:00:00Z', 'first question')}\nnot json\n${row('assistant', 'a1', '2026-10-01T10:00:05Z', [{ type: 'text', text: 'first answer' }])}\n`
  const norm = (s: ReturnType<typeof parseSession>) => JSON.stringify(s, (_, v) => (v instanceof Set ? [...v] : v))
  assert.equal(norm(parseSession(chatLines(members(join(d, 's.gz'), text.slice(0, 20), text.slice(20))), 's', '/h')), norm(parseSession(text, 's', '/h')))
})

test('#9: reading a long chat in members stays far below its size', () => {
  const d = dir()
  const file = join(d, 'long.gz')
  writeFileSync(file, '')
  const line = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`
  for (let i = 0; i < 100; i++) appendFileSync(file, gzipSync(line.repeat(4000))) // 400 MB of text
  const code = `import { chatLines } from ${JSON.stringify(new URL('../src/ingest/transcript.ts', import.meta.url).href)}
const before = process.resourceUsage().maxRSS
let n = 0
for (const l of chatLines(${JSON.stringify(file)})) n += l.length ? 1 : 0
console.log(JSON.stringify({ n, grew: (process.resourceUsage().maxRSS - before) * 1024 / 1e6 }))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const { n, grew } = JSON.parse(r.stdout)
  assert.equal(n, 400000)
  assert.ok(grew < 150, `peak memory grew ${grew.toFixed(0)} MB for a 400 MB chat`)
})
