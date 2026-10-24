import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

import { dumpHash } from '../src/ingest/ingest.ts'
import { Graph } from '../src/query/engine.ts'
import * as c from '../src/query/commands.ts'
import { World, diffStores, git, tick } from './world.ts'
import type { ChatSpec, TurnSpec } from './world.ts'

const same = (w: World, why: string) => {
  const { r, a, b } = w.both()
  assert.equal(a, b, `${why}\n${diffStores(w.path('inc.db'), w.path('full.db'))}`)
  return r
}
const turn = (n: number, extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: `question number ${n} about the billing exporter and retries`, reply: `We decided on backoff number ${n} because the queue was slow.`, ...extra })
const QUESTIONS = ['billing exporter retries', 'queue backoff decision', 'src/a.ts', 'Details plan', 'why backoff', 'tried queue']
/** Every command's output on a fixed question set, from one store. */
function answers(db: string): string[] {
  const g = new Graph(db)
  const out: string[] = []
  for (const q of QUESTIONS) out.push(c.search(g, q), c.current(g, q), c.why(g, q), c.tried(g, q), c.trace(g, q), c.asof(g, '2026-12-01', q), c.resume(g, q))
  out.push(c.resume(g, ''), c.path(g, 'billing', 'Details'))
  g.db.close()
  return out
}

function seeded(n = 12) {
  const w = new World()
  for (let i = 0; i < n; i++) w.chat(`c${i}`, { turns: [turn(i, { reads: [join(w.proj, 'src/a.ts')] }), turn(i + 100)] })
  w.archive()
  assert.equal(w.ingest('inc.db').mode, 'full')
  return w
}

test('S3-H1: one new chat is read alone and the store equals a full rebuild, on every command', () => {
  const w = seeded()
  w.chat('new1', { turns: [turn(500, { edits: [join(w.proj, 'src/new.ts')] }), turn(501)] })
  w.archive()
  const r = same(w, 'one new chat')
  assert.equal(r.mode, 'update')
  assert.equal(r.filesRead, 1)
  assert.deepEqual(answers(w.path('inc.db')), answers(w.path('full.db')))
  assert.equal(w.ingest('inc.db').mode, 'unchanged')
})

test('S3-H2: a chat that grew adds only its new turns', () => {
  const w = seeded()
  const before = (db: string) => new DatabaseSync(db, { readOnly: true }).prepare("SELECT count(*) n FROM nodes WHERE kind = 'turn'").get()!.n as number
  const n0 = before(w.path('inc.db'))
  w.grow('c3', [turn(900), turn(901)])
  w.archive()
  const r = same(w, 'grown chat')
  assert.equal(r.filesRead, 1)
  assert.equal(before(w.path('inc.db')), n0 + 2)
  w.chat('c4', { turns: [turn(4), turn(104)], summary: { text: 'Summary of work so far on retries', from: 'c3' } })
  w.archive()
  same(w, 'a new compaction')
  const db = new DatabaseSync(w.path('inc.db'), { readOnly: true })
  assert.equal(db.prepare("SELECT count(*) n FROM edges WHERE kind = 'continued_from'").get()!.n, 1)
})

test('S3-H3: a note changed and a note deleted', () => {
  const w = seeded(3)
  w.note('Plan.md', '---\ndate: 2026-10-01\n---\n# The plan\nNow about [[Newer]] and src/a.ts only.\n')
  w.note('Newer.md', 'A newer note on the exporter\n')
  same(w, 'note changed and added')
  rmSync(join(w.vault, 'Details.md'))
  const r = same(w, 'note deleted')
  assert.equal(r.filesRead, 0)
  const db = new DatabaseSync(w.path('inc.db'), { readOnly: true })
  assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE id = 'note:Details.md'").get()!.n, 0)
  assert.ok(db.prepare("SELECT 1 FROM edges WHERE src = 'note:Plan.md' AND dst = 'note:Newer.md' AND kind = 'links_to'").get())
})

test('S3-H4: new commits are added, and chats that stated them link to them', () => {
  const w = seeded(3)
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b to the exporter (#7)', 'Decision: use b\nWhy: it is faster')
  w.chat('mk', { turns: [turn(1, { commit: { subject: 'Add b to the exporter (#7)', sha } })] })
  w.archive()
  same(w, 'new commit and a chat that made it')
  const db = new DatabaseSync(w.path('inc.db'), { readOnly: true })
  assert.ok(db.prepare('SELECT 1 FROM edges WHERE src = ? AND kind = ?').get('turn:mk-0', 'made'))
  // A commit the chat stated before the commit existed links once the commit appears.
  const early = 'f'.repeat(7) + 'e0d1c2b3a4'
  w.chat('early', { turns: [turn(2, { commit: { subject: 'Not yet made', sha: early } })] })
  w.archive()
  same(w, 'a claim with no commit yet')
  w.commit(w.proj, 'src/c.ts', 'Not yet made')
  same(w, 'the commit arrives')
})
