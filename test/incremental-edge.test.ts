import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

import { dumpHash } from '../src/ingest/ingest.ts'
import { statusLines } from '../src/ingest/status.ts'
import { Graph } from '../src/query/engine.ts'
import * as c from '../src/query/commands.ts'
import { World, diffStores, tick } from './world.ts'
import type { TurnSpec } from './world.ts'

const same = (w: World, why: string) => {
  const { r, a, b } = w.both()
  assert.equal(a, b, `${why}\n${diffStores(w.path('inc.db'), w.path('full.db'))}`)
  return r
}
const turn = (n: number, extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: `question number ${n} about the billing exporter and retries`, reply: `We decided on backoff number ${n} because the queue was slow.`, ...extra })
const statusText = (w: World) => statusLines(w.cfg, w.path('inc.db')).join('\n')
const count = (w: World, sql: string, db = 'inc.db') => {
  const d = new DatabaseSync(w.path(db), { readOnly: true })
  const n = (d.prepare(sql).get() as any).n as number
  d.close()
  return n
}
function seeded(n = 12) {
  const w = new World()
  for (let i = 0; i < n; i++) w.chat(`c${i}`, { turns: [turn(i, { reads: [join(w.proj, 'src/a.ts')] }), turn(i + 100)] })
  w.archive()
  assert.equal(w.ingest('inc.db').mode, 'full')
  return w
}

test('S3-H5: every result names its project; a project sees itself plus global notes; --all sees everything', () => {
  const w = seeded(2)
  w.chat('o1', { turns: [turn(1, { reads: [join(w.other, 'src/a.ts')] }), { prompt: 'the exporter in the other project needs a rewrite', reply: 'The exporter rewrite in other is planned.' }] }, '-home-other')
  w.note('Global.md', 'A global note about the exporter and its retries.\n')
  w.archive()
  w.ingest('inc.db')
  const g = new Graph(w.path('inc.db'))
  const everything = c.search(g, 'exporter', 12)
  assert.match(everything, /project: other/)
  assert.match(everything, /project: proj/)
  assert.match(everything, /project: global/)
  for (const cmd of [c.search, c.current, c.why, c.tried, c.trace]) assert.match(cmd(g, 'exporter'), /project: \w+/)
  g.scopeTo(w.proj)
  const mine = c.search(g, 'exporter', 12)
  assert.doesNotMatch(mine, /project: other/)
  assert.match(mine, /project: proj/)
  assert.match(mine, /project: global/)
  g.scopeTo(w.other)
  assert.doesNotMatch(c.search(g, 'exporter', 12), /project: proj/)
  assert.doesNotMatch(c.trace(g, 'exporter'), /project: proj/)
  g.scope = undefined
  assert.match(c.search(g, 'exporter', 12), /project: proj/)
  g.db.close()
})

test('S3-H5: the command line takes --project, --here and --all', async () => {
  const w = seeded(2)
  w.chat('o1', { turns: [{ prompt: 'the exporter in the other project needs a rewrite', reply: 'The exporter rewrite in other is planned.' }] }, '-home-other')
  w.archive()
  w.ingest('inc.db')
  const env = { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.thenwise') }
  const run = (args: string[], cwd = process.cwd()) => new Promise<string>((res) => {
    const p = spawn(process.execPath, [join(process.cwd(), 'src/main.ts'), 'search', 'exporter', '--db', w.path('inc.db'), ...args], { env, cwd })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => res(out))
  })
  assert.doesNotMatch(await run(['--project', w.proj]), /project: other/)
  assert.doesNotMatch(await run(['--here'], join(w.proj, 'src')), /project: other/)
  assert.match(await run(['--all', '--project', w.proj]), /project: other/)
  assert.match(await run([]), /project: other/)
})

test('S3-B1: a chat rewritten shorter is read again without duplicates', () => {
  const w = seeded(3)
  w.chat('c1', { turns: [turn(1)] })
  w.archive()
  const r = same(w, 'rewritten shorter')
  assert.equal(r.filesRead, 1)
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'turn' AND id LIKE 'turn:c1-%'"), 1)
})

test('S3-B2: contents changed with the same size and modified time are caught', () => {
  const w = new World()
  w.chat('c0', { turns: [turn(0)] })
  const file = w.chatPath('c0')
  const T = new Date(Date.parse('2026-10-01T10:00:00Z'))
  utimesSync(file, T, T)
  w.archive()
  w.ingest('inc.db')
  const before = readFileSync(file, 'utf8')
  const edited = before.replace('question number 0', 'question number 9')
  assert.equal(edited.length, before.length)
  writeFileSync(file, edited)
  utimesSync(file, T, T)
  assert.equal(statSync(file).mtimeMs, T.getTime())
  assert.equal(w.archive().archived, 1)
  const r = same(w, 'same size and time')
  assert.equal(r.filesRead, 1)
  const db = new DatabaseSync(w.path('inc.db'), { readOnly: true })
  assert.match(db.prepare("SELECT text FROM nodes WHERE id = 'turn:c0-0'").get()!.text as string, /number 9/)
  // Touched with the same bytes: nothing is read into the store again.
  const gz = join(w.memDir, 'archive/sessions', w.key, 'c0.jsonl.gz')
  const later = new Date(Date.now() + 5000)
  utimesSync(gz, later, later)
  assert.equal(w.ingest('inc.db').mode, 'unchanged')
})

test('S3-B3: a modified time in the future does not skip later updates', () => {
  const w = seeded(2)
  const file = w.chatPath('c1')
  const future = new Date('2099-01-01T00:00:00Z')
  utimesSync(file, future, future)
  w.archive()
  same(w, 'future time seen')
  w.grow('c1', [turn(70)])
  w.archive()
  const r = same(w, 'grown after a future time')
  assert.equal(r.filesRead, 1)
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE id = 'turn:c1-g2'"), 1)
  writeFileSync(file, readFileSync(file, 'utf8').replace('number 70', 'number 71'))
  utimesSync(file, future, future)
  w.archive()
  same(w, 'rewritten under the same future time')
  assert.match(new DatabaseSync(w.path('inc.db'), { readOnly: true }).prepare("SELECT text FROM nodes WHERE id = 'turn:c1-g2'").get()!.text as string, /number 71/)
})

test("S3-B4: a chat deleted from Claude Code's folder stays in the archive and in the store", () => {
  const w = seeded(3)
  rmSync(w.chatPath('c2'))
  w.archive()
  const r = same(w, 'source deleted')
  assert.equal(r.mode, 'unchanged')
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE id = 'ses:c2'"), 1)
  assert.ok(gunzipSync(readFileSync(join(w.memDir, 'archive/sessions', w.key, 'c2.jsonl.gz'))).length > 0)
})

test('S3-B4: a chat file removed from the archive itself leaves the store, as a full rebuild would', () => {
  const w = seeded(3)
  rmSync(join(w.memDir, 'archive/sessions', w.key, 'c2.jsonl.gz'))
  const r = same(w, 'archive file gone')
  assert.equal(r.mode, 'update')
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE id = 'ses:c2'"), 0)
})

test('S3-B6: a half last line is skipped now and read on the next run', () => {
  const w = seeded(2)
  const file = w.chatPath('c0')
  const line = JSON.stringify({ type: 'user', uuid: 'late', timestamp: tick(), cwd: w.proj, entrypoint: 'cli', message: { role: 'user', content: 'a late question about the exporter backoff' } })
  appendFileSync(file, line.slice(0, 60))
  assert.equal(w.archive().unparsed.length, 0)
  same(w, 'half line skipped')
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE id = 'turn:late'"), 0)
  assert.match(statusText(w), /1 chats end in a half-written line/)
  appendFileSync(file, `${line.slice(60)}\n`)
  w.archive()
  const r = same(w, 'line completed')
  assert.equal(r.filesRead, 1)
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE id = 'turn:late'"), 1)
  assert.doesNotMatch(statusText(w), /half-written/)
})

test('S3-B8: a broken JSON line is skipped and counted in status, the rest is kept', () => {
  const w = seeded(2)
  const file = w.chatPath('c1')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.splice(1, 0, '{"type":"user", "uuid": "broken", this is not json')
  writeFileSync(file, lines.join('\n'))
  assert.equal(w.archive().unparsed.length, 1)
  same(w, 'broken line')
  assert.match(statusText(w), /1 lines did not parse/)
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'turn' AND id LIKE 'turn:c1-%'"), 2)
})

test('S3-B9: a project folder that was moved is reported, and its old chats stay', () => {
  const w = new World()
  const old = join(w.home, 'old-name')
  const moved = join(w.home, 'new-name')
  mkdirSync(old)
  w.cfg.roots.push(old, moved)
  w.chat('m0', { turns: [turn(0)], cwd: old }, '-home-old-name')
  w.archive()
  w.ingest('inc.db')
  renameSync(old, moved)
  w.chat('m1', { turns: [turn(1)], cwd: moved }, '-home-new-name')
  w.archive()
  w.ingest('inc.db')
  assert.match(statusText(w), /project folder gone: .*old-name \(1 chats\)/)
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'session'"), 2)
})

test('S3-B5: a second ingest waits for the first and then finds nothing to do', async () => {
  const w = seeded(3)
  const lock = `${w.path('inc.db')}.lock`
  writeFileSync(lock, String(process.pid)) // a live holder: this test process
  w.chat('late', { turns: [turn(77)] })
  w.archive()
  const env = { ...process.env, HOME: w.home, THENWISE_HOME: join(w.home, '.thenwise') }
  const run = () => new Promise<{ code: number | null; out: string }>((res) => {
    const p = spawn(process.execPath, [join(process.cwd(), 'src/main.ts'), 'ingest', '--db', w.path('inc.db'), '--prs', w.prs], { env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => res({ code, out }))
  })
  const t0 = Date.now()
  const a = run()
  const b = run()
  await new Promise((r) => setTimeout(r, 800))
  assert.ok(statSync(w.path('inc.db')).mtimeMs < t0, 'nothing is written while the lock is held')
  rmSync(lock)
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.code, 0, ra.out)
  assert.equal(rb.code, 0, rb.out)
  const both = `${ra.out}${rb.out}`
  assert.equal(both.match(/updated: 1 chat files/g)?.length, 1, both)
  assert.equal(both.match(/nothing new/g)?.length, 1, both)
  w.full('full.db')
  assert.equal(dumpHash(w.path('inc.db')), dumpHash(w.path('full.db')))
})

test('S3-B7: with hundreds of chats an update after one new chat takes well under 2 s (bench/incremental.ts runs 5,000)', () => {
  const w = new World()
  for (let i = 0; i < 400; i++) w.chat(`b${i}`, { turns: Array.from({ length: 6 }, (_, k) => turn(i * 10 + k, { reads: [join(w.proj, `src/f${k}.ts`)] })) })
  w.archive()
  const full = w.ingest('inc.db')
  assert.equal(full.mode, 'full')
  w.chat('one-more', { turns: [turn(9999)] })
  w.archive()
  const t0 = Date.now()
  const r = w.ingest('inc.db')
  assert.equal(r.mode, 'update')
  assert.equal(r.filesRead, 1)
  assert.ok(Date.now() - t0 < (process.platform === 'win32' ? 8000 : 2000), `${Date.now() - t0} ms`)
  w.full('full.db')
  assert.equal(dumpHash(w.path('inc.db')), dumpHash(w.path('full.db')))
})

test('S3: a changed config, --full and a store from an older version all rebuild; nothing else does', () => {
  const w = seeded(2)
  assert.equal(w.ingest('inc.db').mode, 'unchanged')
  w.cfg.roots.push(join(w.home, 'elsewhere'))
  assert.equal(w.ingest('inc.db').mode, 'full')
  assert.equal(w.ingest('inc.db').mode, 'unchanged')
  assert.equal(w.full('inc.db').mode, 'full')
  const db = new DatabaseSync(w.path('inc.db'))
  db.exec('DROP TABLE ingest_state')
  db.close()
  const r = w.ingest('inc.db')
  assert.equal(r.mode, 'full')
  assert.deepEqual(r.warnings, [])
  assert.equal(w.ingest('inc.db').mode, 'unchanged')
})

test('S3-H4: a chat that states a commit subject links to the commit made within 15 minutes after it, whichever arrives first', () => {
  const w = seeded(2)
  w.chat('claim', { turns: [turn(1, { commit: { subject: 'Tune the queue', sha: 'a'.repeat(40) } })] })
  w.archive()
  same(w, 'claim first')
  const made = w.commit(w.proj, 'src/q.ts', 'Tune the queue', '', tick(3))
  const r = same(w, 'commit within 15 minutes after the claim')
  assert.equal(r.mode, 'update')
  assert.equal(count(w, `SELECT count(*) n FROM edges WHERE src = 'turn:claim-0' AND dst = 'commit:proj:${made}' AND kind = 'made' AND extra LIKE '%subject match%'`), 1)
  w.commit(w.proj, 'src/q2.ts', 'Tune the queue', '', tick(60))
  same(w, 'a second commit with the same subject, an hour later')
  assert.equal(count(w, "SELECT count(*) n FROM edges WHERE src = 'turn:claim-0' AND kind = 'made'"), 1)
})
