import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { accept, readNotes, reject, saveNote } from '../src/capture/notes.ts'
import { distill, parseItems } from '../src/capture/distill.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'
import { Graph } from '../src/query/engine.ts'
import { asof, current, search } from '../src/query/commands.ts'

// Synthetic only. The model is a fake `claude` script; nothing here calls a real model.
const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim()

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memv2-capture-'))
  const proj = join(home, 'proj')
  mkdirSync(proj, { recursive: true })
  git(proj, 'init', '-q', '-b', 'main')
  writeFileSync(join(proj, 'a.txt'), 'a')
  git(proj, 'add', '.')
  git(proj, 'commit', '-q', '-m', 'Add a', '-m', 'Decision: use plain files\nWhy: nothing to install\nDead-end: a database server')
  mkdirSync(join(home, '.memory/archive/sessions/-proj'), { recursive: true })
  writeFileSync(join(home, 'prs.json'), '[]')
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: [proj], repos: [proj], github_repos: ['me/proj'], vaults: [] } }))
  const line = (o: object) => JSON.stringify(o)
  const u = (id: string, text: string, at: string) => line({ type: 'user', uuid: id, timestamp: at, cwd: proj, entrypoint: 'cli', message: { role: 'user', content: text } })
  const a = (id: string, text: string, at: string) => line({ type: 'assistant', uuid: id, timestamp: at, cwd: proj, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const session = [u('u1', `we pick sqlite for storage, token ${KEY}`, '2026-10-01T10:00:00Z'), a('a1', 'Agreed, because it ships with node.', '2026-10-01T10:00:01Z'), u('u2', 'redis was too heavy', '2026-10-01T10:01:00Z'), a('a2', 'Dropped redis.', '2026-10-01T10:01:01Z')].join('\n')
  writeFileSync(join(home, '.memory/archive/sessions/-proj/s1.jsonl.gz'), gzipSync(session))

  const bin = join(home, 'claude')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(process.env.MOCK_LOG, input + '\\n=====\\n')
const out = input.includes('Old fact:') ? process.env.MOCK_CONTRA : fs.readFileSync(process.env.MOCK_ITEMS, 'utf8')
process.stdout.write(JSON.stringify({ result: out, usage: { output_tokens: 42 } }))
`)
  chmodSync(bin, 0o755)
  process.env.MEMORY_CLAUDE_BIN = bin
  process.env.MOCK_LOG = join(home, 'mock.log')
  process.env.MOCK_ITEMS = join(home, 'items.json')
  process.env.MOCK_CONTRA = '{"contradicts":"no"}'
  const items = (list: object[]) => writeFileSync(process.env.MOCK_ITEMS!, JSON.stringify({ items: list }))
  const cfg = loadConfig(home)
  const run = () => ingest(cfg, { prs: join(home, 'prs.json'), db: join(home, 'g.db') })

  return { home, cfg, items, run, db: join(home, 'g.db') }
}

test('parsing drops sourceless items and holds the per-chunk caps', () => {
  const labels = new Set(['t1', 't2'])
  const d = (n: number) => ({ type: 'decision', title: `d${n}`, summary: 'x', sources: ['t1'] })
  const p = parseItems(JSON.stringify({ items: [{ type: 'decision', title: 'no src', summary: 'x', sources: [] }, { type: 'decision', title: 'bad src', summary: 'x', sources: ['t9'] }, d(1), d(2), d(3), { type: 'rule', title: 'r1', summary: 'x', sources: ['t2'] }, { type: 'rule', title: 'r2', summary: 'x', sources: ['t2'] }, d(5)] }), labels)
  assert.deepEqual(p.items.map((i) => i.title), ['d1', 'd2', 'd3', 'r1'])
  assert.equal(p.dropped, 4)
  assert.deepEqual(parseItems('not json', labels), { items: [], dropped: 0 })
})

test('inbox notes are not searchable until accepted; secrets never reach the model; reject works', { skip: process.platform === 'win32' && 'the mock claude is a shebang script' }, () => {
  const f = fixture()
  f.items([{ type: 'decision', title: 'Storage is sqlite', summary: 'We chose sqlite because it ships with node.', sources: ['t1'] }, { type: 'dead_end', title: 'Redis was too heavy', summary: 'Tried redis, dropped it as too heavy.', sources: ['t2'] }])
  const r = distill(f.cfg, { now: Date.parse('2026-10-02T00:00:00Z') })
  assert.equal(r.proposals, 2)
  assert.ok(!readFileSync(process.env.MOCK_LOG!, 'utf8').includes(KEY))
  assert.ok(readFileSync(process.env.MOCK_LOG!, 'utf8').includes('[secret masked]'))
  const log = readFileSync(join(f.home, '.memory/distill-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(log[0].output_tokens, 42)
  assert.equal(log[0].items, 2)

  const [dec, dead] = [readNotes(f.cfg.memDir).find((n) => n.status === 'inbox' && n.type === 'decision')!, readNotes(f.cfg.memDir).find((n) => n.status === 'inbox' && n.type === 'dead_end')!]
  f.run()
  assert.ok(!new Graph(f.db).nodes.has(`curated:${dec.id}`))
  assert.doesNotMatch(search(new Graph(f.db), 'sqlite ships with node'), /curated:/)
  assert.deepEqual(dec.sources, ['ses:s1', 'turn:u1'])
  accept(f.cfg.memDir, { ids: [dec.id] }, '2026-10-03T00:00:00Z')
  reject(f.cfg.memDir, [dead.id])
  f.run()
  const g = new Graph(f.db)
  assert.ok(g.nodes.has(`curated:${dec.id}`))
  assert.ok(!g.nodes.has(`curated:${dead.id}`))
  assert.equal(g.nodes.get(`curated:${dec.id}`)!.kind, 'decision')
  assert.match(search(g, 'sqlite ships with node'), /curated:/)
  assert.equal(readNotes(f.cfg.memDir).find((n) => n.id === dead.id)!.status, 'rejected')
})

test('duplicates are refused, the state file skips distilled turns, unreviewed inbox notes expire after 14 days', { skip: process.platform === 'win32' && 'the mock claude is a shebang script' }, () => {
  const f = fixture()
  f.items([{ type: 'decision', title: 'Storage is sqlite', summary: 'We chose sqlite because it ships with node.', sources: ['t1'] }])
  assert.equal(distill(f.cfg, { now: Date.parse('2026-10-02T00:00:00Z') }).proposals, 1)
  const again = distill(f.cfg, { now: Date.parse('2026-10-02T01:00:00Z') })
  assert.equal(again.calls, 0) // nothing new since the last turn distilled
  writeFileSync(join(f.home, '.memory/distill-state.json'), '{}')
  f.items([{ type: 'decision', title: 'Storage is SQLite!', summary: 'Different words entirely about the engine.', sources: ['t1'] }])
  const dup = distill(f.cfg, { now: Date.parse('2026-10-02T02:00:00Z') })
  assert.equal(dup.proposals, 0)
  assert.equal(dup.dropped, 1)
  assert.equal(readNotes(f.cfg.memDir).length, 1)
  distill(f.cfg, { dryRun: true, now: Date.parse('2026-10-30T00:00:00Z') })
  assert.equal(readNotes(f.cfg.memDir)[0]!.status, 'inbox') // a dry run changes nothing
  writeFileSync(join(f.home, '.memory/distill-state.json'), '{}')
  distill(f.cfg, { now: Date.parse('2026-10-30T00:00:00Z') })
  assert.equal(readNotes(f.cfg.memDir)[0]!.status, 'expired')
  f.run()
  assert.ok(![...new Graph(f.db).nodes.keys()].some((k) => k.startsWith('curated:n-')))
})

test('contradiction: yes supersedes on accept and closes the old note; no changes nothing', { skip: process.platform === 'win32' && 'the mock claude is a shebang script' }, () => {
  for (const answer of ['yes', 'no']) {
    const f = fixture()
    const old = saveNote(f.cfg.memDir, { id: 'n-old', type: 'decision', title: 'Storage is redis', summary: 'We store memory in redis.', status: 'active', valid_from: '2026-09-01T00:00:00Z', valid_to: '', supersedes: '', sources: [], created: '2026-09-01T00:00:00Z', project: 'p', path: '' })
    process.env.MOCK_CONTRA = `{"contradicts":"${answer}"}`
    f.items([{ type: 'decision', title: 'Storage is sqlite', summary: 'We store memory in sqlite, not redis.', sources: ['t1'] }])
    assert.equal(distill(f.cfg, { now: Date.parse('2026-10-02T00:00:00Z') }).calls, 2)
    const prop = readNotes(f.cfg.memDir).find((n) => n.status === 'inbox')!
    assert.equal(prop.supersedes, answer === 'yes' ? 'n-old' : '')
    accept(f.cfg.memDir, { ids: [prop.id] }, '2026-10-05T00:00:00Z')
    const after = readNotes(f.cfg.memDir).find((n) => n.id === old.id)!
    assert.equal(after.status, answer === 'yes' ? 'superseded' : 'active')
    assert.equal(after.valid_to, answer === 'yes' ? '2026-10-05T00:00:00Z' : '')
    f.run()
    const g = new Graph(f.db)
    assert.equal(current(g, 'we store memory in redis').includes('curated:n-old'), answer === 'no')
    assert.equal(asof(g, '2026-10-04', 'we store memory in redis').includes('curated:n-old'), true)
    assert.equal(asof(g, '2026-10-06', 'we store memory in redis').includes('curated:n-old'), answer === 'no')
  }
})

test('trailers become active notes, once', () => {
  const f = fixture()
  f.run()
  const first = readNotes(f.cfg.memDir)
  assert.deepEqual(first.map((n) => [n.type, n.status, n.title]).sort(), [['dead_end', 'active', 'a database server'], ['decision', 'active', 'use plain files']])
  assert.match(first.find((n) => n.type === 'decision')!.summary, /Why: nothing to install/)
  reject(f.cfg.memDir, []) // no-op
  f.run()
  assert.equal(readNotes(f.cfg.memDir).length, 2)
  assert.ok(new Graph(f.db).nodes.size > 0 && [...new Graph(f.db).nodes.keys()].filter((k) => k.startsWith('curated:tr-')).length === 2)
})
