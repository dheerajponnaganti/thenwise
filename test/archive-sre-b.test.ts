import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

import { readLog } from '../src/core/log.ts'
import { archive, maskTranscript } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'

const row = (n: number, text: string) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: '2026-10-02T10:00:00Z', cwd: '/x', sessionId: 's', entrypoint: 'cli', message: { role: 'user', content: text } })
// Most of a real chat is tool output and replies; one line in twenty is a prompt.
const big = (n: number, text: string) => (n % 20 === 1 ? row(n, text.slice(0, 80)) : JSON.stringify({ type: 'assistant', uuid: `a${n}`, timestamp: '2026-10-02T10:00:00Z', cwd: '/x', message: { role: 'assistant', content: [{ type: 'text', text }] } }))

function world() {
  const home = mkdtempSync(join(tmpdir(), 'tw-arcb-'))
  mkdirSync(join(home, '.memory'), { recursive: true })
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: ['/x'] } }))
  const dir = join(home, '.claude/projects/-x')
  mkdirSync(dir, { recursive: true })

  return { home, dir, cfg: loadConfig(home) }
}
const dest = (home: string) => join(home, '.memory/archive/sessions/-x/s.jsonl.gz')

/** Writes `mb` megabytes of chat in 1 MB pieces, so the test itself stays small in memory. */
function bigChat(file: string, mb: number) {
  const piece = `${Array.from({ length: 200 }, (_, i) => big(i, `line ${i} ${'word '.repeat(190)}`)).join('\n')}\n`
  writeFileSync(file, '')
  for (let i = 0; i < mb; i++) appendFileSync(file, piece.repeat(Math.ceil(1e6 / piece.length)))
}

test('archive reads a chat in chunks: same output as the whole-text masker, memory far below the file size', () => {
  const w = world()
  const file = join(w.dir, 's.jsonl')
  bigChat(file, 40)
  appendFileSync(file, 'not json\n')
  const before = process.resourceUsage().maxRSS
  const r = archive(w.cfg)
  const grew = (process.resourceUsage().maxRSS - before) * 1024 / 1e6 // maxRSS is in KB
  assert.equal(r.archived, 1)

  // Reading the whole file grew about 290 MB; the bound leaves room for when the collector runs (CI saw 129 MB).
  assert.ok(grew < 200, `peak memory grew ${grew.toFixed(0)} MB for a 40 MB chat`)
  const want = maskTranscript(readFileSync(file, 'utf8'))
  assert.equal(gunzipSync(readFileSync(dest(w.home))).toString('utf8'), want.text)
  assert.equal(r.unparsed.length, 1)
})

test('a second archive while one runs exits with "archive already running"', () => {
  const w = world()
  writeFileSync(join(w.dir, 's.jsonl'), `${row(1, 'hi')}\n`)
  mkdirSync(join(w.home, '.memory/archive'), { recursive: true })
  writeFileSync(join(w.home, '.memory/archive/archive.lock'), String(process.pid))
  process.env.THENWISE_ARCHIVE_WAIT_MS = '200'
  try {
    assert.throws(() => archive(w.cfg), /archive already running/)
    const r = spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '../src/cli.ts'), 'archive'], { env: { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.memory') }, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /archive already running/)
  } finally {
    delete process.env.THENWISE_ARCHIVE_WAIT_MS
  }
  rmSync(join(w.home, '.memory/archive/archive.lock'))
  assert.equal(archive(w.cfg).archived, 1)
})

test('the archive command prints one line per damaged file', () => {
  const w = world()
  writeFileSync(join(w.dir, 's.jsonl'), `${row(1, 'a')}\nbad\n${row(2, 'b')}\nbad two\nbad three\n${row(3, 'c')}\n`)
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '../src/cli.ts'), 'archive'], { env: { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.memory') }, encoding: 'utf8' })
  assert.match(r.stdout, /-x\/s\.jsonl: 3 lines did not parse \(first: line 2\)/)
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('unparsed:') || l.includes('lines did not parse (first')).length, 1)
})

test('an unreadable chat is reported with its reason and size, in the result and in the log', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  process.env.THENWISE_LOG = 'info' // the test runner turns logging off
  const w = world()
  const file = join(w.dir, 's.jsonl')
  writeFileSync(file, `${row(1, 'hello')}\n`)
  chmodSync(file, 0)
  const r = archive(w.cfg)
  chmodSync(file, 0o600)
  process.env.THENWISE_LOG = 'off'
  assert.deepEqual(r.failed, ['-x/s.jsonl'])
  assert.equal(r.failures[0]!.reason, 'EACCES')
  assert.ok(r.failures[0]!.size > 0)
  const ev = readLog(join(w.home, '.memory')).find((e) => e.ev === 'file_failed')!
  assert.equal(ev.reason, 'EACCES')
  assert.equal(ev.bytes, r.failures[0]!.size)
})

test('a 600 MB chat archives', { skip: process.env.THENWISE_SLOW !== '1' }, () => {
  const w = world()
  const file = join(w.dir, 's.jsonl')
  bigChat(file, 600)
  const r = archive(w.cfg)
  assert.equal(r.archived, 1)
  assert.equal(r.failed.length, 0)
})

test('a [no-memory] marker added after a sync drops the archived copy', () => {
  const w = world()
  const file = join(w.dir, 's.jsonl')
  writeFileSync(file, `${row(1, 'first turn')}\n`)
  assert.equal(archive(w.cfg).archived, 1)
  appendFileSync(file, `${row(2, '[no-memory]')}\n`)
  const r = archive(w.cfg)
  assert.equal(r.excludedChats, 1)
  assert.deepEqual(r.pruned, ['-x/s.jsonl'])
  assert.throws(() => readFileSync(dest(w.home)))
  assert.ok(!('-x/s.jsonl' in JSON.parse(readFileSync(join(w.home, '.memory/archive/manifest.json'), 'utf8'))))
})

test('#30: an empty chat file does not stop ingest', () => {
  const w = world()
  writeFileSync(join(w.dir, 's.jsonl'), `${row(1, 'the walrus question')}
`)
  writeFileSync(join(w.dir, 'empty.jsonl'), '')
  archive(w.cfg)
  const r = ingest(w.cfg, { prs: join(w.home, 'none.json'), db: join(w.home, 'g.db') })
  assert.equal(r.sessionsIn, 1)
  archive(w.cfg) // an empty archived copy also reads when the archive checks it again
})
