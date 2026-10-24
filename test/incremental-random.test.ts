import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { Graph } from '../src/query/engine.ts'
import * as c from '../src/query/commands.ts'
import { World, diffStores, tick } from './world.ts'
import type { TurnSpec } from './world.ts'

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const WORDS = 'billing exporter retries queue backoff cache warmer schema migration release rollback timeout shard index replica checkpoint'.split(' ')
const SUBJECTS = ['Add b', 'Fix cache', 'Tune queue']
const QUESTIONS = ['billing exporter retries', 'queue backoff decision', 'src/a.ts', 'Details plan', 'why rollback', 'tried cache warmer', '#7', 'schema migration']

function answers(db: string): string[] {
  const g = new Graph(db)
  const out: string[] = []
  for (const q of QUESTIONS) out.push(c.search(g, q), c.current(g, q), c.why(g, q), c.tried(g, q), c.trace(g, q), c.asof(g, '2026-12-01', q))
  out.push(c.resume(g, ''), c.resume(g, 'proj'), c.path(g, 'billing', 'Details'))
  g.db.close()
  return out
}

function play(seed: number, steps: number) {
  const r = rng(seed)
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!
  const sentence = () => Array.from({ length: 6 }, () => pick(WORDS)).join(' ')
  const w = new World()
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'lib/d.ts'].map((f) => join(w.proj, f))
  const shas: string[] = []
  let n = 0
  const mkTurn = (): TurnSpec => {
    const t: TurnSpec = { prompt: sentence(), reply: `${sentence()} because ${sentence()}`, reads: r() < 0.5 ? [pick(files)] : [], edits: r() < 0.3 ? [pick(files)] : [] }
    if (r() < 0.2 && shas.length) t.commit = { subject: pick(SUBJECTS), sha: pick(shas) }
    if (r() < 0.1) t.prUrl = 'https://github.com/me/proj/pull/7'
    if (r() < 0.1 && shas.length) t.prompt += ` see ${pick(shas).slice(0, 7)} and PR #7 and lib/d.ts`
    return t
  }
  const ids = () => [...w.chats.keys()]
  const ops: (() => string)[] = [
    () => (w.chat(`n${++n}`, { turns: [mkTurn(), mkTurn()] }), 'add a chat'),
    () => (w.chat(`n${++n}`, { turns: [mkTurn()] }, '-home-other'), 'add a chat in the other project'),
    () => (ids().length ? (w.grow(pick(ids()), [mkTurn()]), 'grow a chat') : 'nothing'),
    () => {
      const id = pick(ids())
      if (!id) return 'nothing'
      w.chat(id, { turns: w.chats.get(id)!.spec.turns.slice(0, -1).length ? w.chats.get(id)!.spec.turns.slice(0, -1) : [mkTurn()] }, w.chats.get(id)!.key)
      return 'rewrite a chat shorter'
    },
    () => {
      const id = pick(ids())
      if (!id) return 'nothing'
      const src = w.chats.get(id)!
      w.chat(`n${++n}`, { turns: [...src.spec.turns, mkTurn()], summary: { text: `Summary ${sentence()}`, from: id } }, src.key)
      return 'resume a chat as a copy with a compaction'
    },
    () => {
      shas.push(w.commit(w.proj, pick(['src/b.ts', 'lib/d.ts', 'src/c.ts']), r() < 0.5 ? pick(SUBJECTS) : `${pick(['Add', 'Fix', 'Tune'])} ${sentence()} (#7)`, r() < 0.4 ? `Decision: ${sentence()}\nWhy: ${sentence()}` : '', tick(3)))
      return 'commit'
    },
    () => (w.note(`${pick(['Plan', 'Details', 'Extra', 'Log'])}.md`, `---\ndate: 2026-10-0${1 + Math.floor(r() * 9)}\n---\n# ${sentence()}\nSee [[${pick(['Plan', 'Details', 'Extra'])}]] and src/a.ts and PR #7.\n`), 'write a note'),
    () => (rmSync(join(w.vault, `${pick(['Details', 'Extra', 'Log'])}.md`), { force: true }), 'delete a note'),
    () => (writeFileSync(w.prs, JSON.stringify(r() < 0.3 ? [] : [{ number: 7, title: `PR ${sentence()}`, body: `Body ${sentence()} src/b.ts`, state: pick(['OPEN', 'MERGED']), createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-03T00:00:00Z', mergeCommit: shas.length ? { oid: pick(shas) } : undefined, url: 'https://github.com/me/proj/pull/7', files: [{ path: 'src/b.ts' }], comments: [] }])), 'change the PR list'),
    () => (writeFileSync(join(w.proj, 'CLAUDE.md'), `# Rules\n- ${sentence()} always\n- ${sentence()} never\n`), 'edit CLAUDE.md'),
    () => {
      const dir = join(w.home, '.claude/projects', w.key, 'memory')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${pick(['m1', 'm2'])}.md`), `---\nname: ${sentence()}\n---\n${sentence()}\n`)
      return 'write an auto-memory file'
    },
    () => {
      const id = pick(ids())
      if (!id) return 'nothing'
      const file = w.chatPath(id, w.chats.get(id)!.key)
      const text = readFileSync(file, 'utf8')
      const word = WORDS.find((x) => text.includes(x))
      if (!word) return 'nothing'
      const T = new Date(Date.parse('2026-09-30T00:00:00Z'))
      utimesSync(file, T, T)
      w.archive()
      writeFileSync(file, text.replace(word, word.split('').reverse().join('')))
      utimesSync(file, T, T)
      return 'rewrite a chat in place under the same size and time'
    },
    () => {
      const id = pick(ids())
      if (!id) return 'nothing'
      rmSync(join(w.memDir, 'archive/sessions', w.chats.get(id)!.key, `${id}.jsonl.gz`), { force: true })
      rmSync(w.chatPath(id, w.chats.get(id)!.key), { force: true })
      const man = join(w.memDir, 'archive/manifest.json')
      const m = JSON.parse(readFileSync(man, 'utf8'))
      delete m[`${w.chats.get(id)!.key}/${id}.jsonl`]
      writeFileSync(man, JSON.stringify(m))
      w.chats.delete(id)
      return 'forget a chat'
    },
  ]
  // Start from a small history so the first changes land on something.
  for (let i = 0; i < 3; i++) w.chat(`s${i}`, { turns: [mkTurn(), mkTurn()] })
  shas.push(w.commit(w.proj, 'src/b.ts', 'Add b (#7)'))
  w.archive()
  assert.equal(w.ingest('inc.db').mode, 'full')
  const log: string[] = []
  for (let i = 0; i < steps; i++) {
    log.push(pick(ops)())
    w.archive()
    const { r: res, a, b } = w.both()
    assert.equal(a, b, `seed ${seed}, step ${i + 1} (${log.join(' > ')}), mode ${res.mode}\n${diffStores(w.path('inc.db'), w.path('full.db'))}`)
    assert.notEqual(res.mode, 'full', `step ${i + 1} fell back to a full rebuild`)
  }
  assert.deepEqual(answers(w.path('inc.db')), answers(w.path('full.db')))
  if (process.env.SHOW) console.log(log.join(' > '), new DatabaseSync(w.path('inc.db')).prepare('SELECT kind, count(*) n FROM edges GROUP BY kind').all().map((x) => `${x.kind} ${x.n}`).join(', '))
  w.destroy()
}

test('S3-H6: 20 random changes, one by one, give the same store as a full rebuild (seed 1)', () => play(1, 20))
test('S3-H6: 20 random changes, one by one, give the same store as a full rebuild (seed 2)', () => play(2, 20))
test('S3-H6: 20 random changes, one by one, give the same store as a full rebuild (seed 3)', () => play(3, 20))
test('S3-H6: 40 random changes (seed 4)', () => play(4, 40))
