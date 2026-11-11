import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { gunzipSync, gzipSync } from 'node:zlib'

import { readLog } from '../src/core/log.ts'
import { archive, maskTranscript } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'
import { lastMemberSize } from '../src/ingest/transcript.ts'

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
  // A live holder other than this process: a lock naming this process itself is stale (#101).
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  writeFileSync(join(w.home, '.memory/archive/archive.lock'), String(holder.pid))
  process.env.THENWISE_ARCHIVE_WAIT_MS = '200'
  try {
    assert.throws(() => archive(w.cfg), /archive already running/)
    const r = spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '../src/cli.ts'), 'archive'], { env: { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.memory') }, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /archive already running/)
  } finally {
    delete process.env.THENWISE_ARCHIVE_WAIT_MS
    holder.kill()
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

test('#9: a chat an older version zipped whole is rewritten as members once, with the same text', () => {
  const w = world()
  bigChat(join(w.dir, 's.jsonl'), 20)
  archive(w.cfg)
  const text = gunzipSync(readFileSync(dest(w.home)))
  writeFileSync(dest(w.home), gzipSync(text))
  const whole = readFileSync(dest(w.home)).length
  assert.ok(lastMemberSize(dest(w.home)) > 16e6)
  const again = archive(w.cfg)
  assert.equal(again.archived, 0, 'the chat itself did not change')
  assert.ok(lastMemberSize(dest(w.home)) < 8e6, 'now in members')
  assert.ok(gunzipSync(readFileSync(dest(w.home))).equals(text), 'same text')
  assert.ok(readFileSync(dest(w.home)).length >= whole)
  if (process.platform !== 'win32') assert.equal(statSync(dest(w.home)).mode & 0o777, 0o600)
  const bytes = readFileSync(dest(w.home))
  archive(w.cfg)
  assert.ok(readFileSync(dest(w.home)).equals(bytes), 'a later archive leaves it alone')
})

const manifestOf = (home: string): Record<string, unknown> => JSON.parse(readFileSync(join(home, '.memory/archive/manifest.json'), 'utf8'))

test('#97: an archive killed partway keeps the chats it finished, and the next run archives only the rest', () => {
  const w = world()
  for (let i = 0; i < 300; i++) writeFileSync(join(w.dir, `s${String(i).padStart(3, '0')}.jsonl`), `${row(1, `chat ${i}`)}\n`)
  // A real kill with no finally, as the sync's timeout gives: the child stops itself on chat 250, after the checkpoint at 200.
  const src = (f: string) => pathToFileURL(join(import.meta.dirname, '../src/ingest', f)).href
  const code = `import { archive } from '${src('archive.ts')}'; import { loadConfig } from '${src('config.ts')}'; archive(loadConfig(process.env.HOME), { onProgress: (done) => done === 250 && process.kill(process.pid, 'SIGKILL') })`
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.memory') }, encoding: 'utf8' })
  assert.notEqual(r.status, 0, r.stderr)
  assert.equal(readdirSync(join(w.home, '.memory/archive/sessions/-x')).filter((f) => f.endsWith('.gz')).length, 249, r.stderr)
  const kept = Object.keys(manifestOf(w.home))
  assert.equal(kept.length, 200)
  for (const rel of kept) assert.ok(existsSync(join(w.home, '.memory/archive/sessions', `${rel}.gz`)), `${rel} is named but its .gz is missing`)
  const again = archive(w.cfg)
  assert.deepEqual([again.archived, again.skipped, again.seen], [100, 200, 300])
  // Update equals rebuild: the resumed manifest is the one a clean run writes.
  const resumed = manifestOf(w.home)
  rmSync(join(w.home, '.memory/archive'), { recursive: true })
  assert.equal(archive(w.cfg).archived, 300)
  assert.deepEqual(manifestOf(w.home), resumed)
})

test('#97: tmp files a dead archive left are removed at the next start, a live run\'s are kept', () => {
  const w = world()
  writeFileSync(join(w.dir, 's.jsonl'), `${row(1, 'hi')}\n`)
  archive(w.cfg)
  const dead = spawnSync(process.execPath, ['-e', '']).pid! // exited, so no live process has this pid
  const at = (f: string) => join(w.home, '.memory/archive', f)
  const stale = [at(`sessions/-x/s.jsonl.gz.${dead}.tmp`), at(`manifest.json.${dead}.tmp`), at(`sessions/-x/old.jsonl.gz.${process.ppid}.tmp`)]
  const live = at(`sessions/-x/t.jsonl.gz.${process.ppid}.tmp`)
  for (const f of [...stale, live]) writeFileSync(f, 'half')
  utimesSync(stale[2]!, new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3)) // a reused pid: no writer leaves a tmp untouched this long
  archive(w.cfg)
  for (const f of stale) assert.ok(!existsSync(f), `${f} is still there`)
  assert.ok(existsSync(live), 'a live run\'s tmp file is kept')
})
