import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, renameSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { runHook } from '../src/hooks/hook.ts'
import { keyOf, snapshotAll } from '../src/ingest/plans.ts'
import { Graph } from '../src/query/engine.ts'
import { search } from '../src/query/commands.ts'
import { forget } from '../src/privacy/forget.ts'
import { World } from './world.ts'

// Built from pieces so this file holds no real-looking key.
const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const snaps = (w: World, dir = w.proj) => {
  const base = join(w.memDir, 'archive/plans', keyOf(dir))
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : []))
  try {
    return walk(base)
  } catch {
    return []
  }
}
const hook = (w: World, file: string) => {
  process.env.THENWISE_HOME = w.memDir
  try {
    return runHook('plan', { tool_name: 'Write', tool_input: { file_path: file }, cwd: w.proj }, { dir: w.memDir, cli: '' })
  } finally {
    delete process.env.THENWISE_HOME
  }
}

test('PL1: a Write on an existing task_plan.md snapshots the old content, masked, once', () => {
  const w = new World()
  const f = join(w.proj, 'task_plan.md')
  writeFileSync(f, `# Plan\nuse pelican retries ${KEY}\n`)
  assert.equal(hook(w, f), '')
  assert.equal(hook(w, f), '')
  const s = snaps(w)
  assert.equal(s.length, 1)
  const text = readFileSync(s[0]!, 'utf8')
  assert.match(text, /pelican/)
  assert.ok(!text.includes(KEY))
  assert.equal(statSync(s[0]!).mode & 0o077, 0)
  writeFileSync(f, '# Plan\nnew version\n')
  hook(w, f)
  assert.equal(snaps(w).length, 2)
  w.destroy()
})

test('PL2: a non-plan file and an off project do nothing', () => {
  const w = new World()
  writeFileSync(join(w.proj, 'notes.md'), '# n\n')
  writeFileSync(join(w.proj, 'progress.md'), '# p\n')
  hook(w, join(w.proj, 'notes.md'))
  assert.equal(snaps(w).length, 0)
  writeFileSync(join(w.memDir, 'config.json'), JSON.stringify({ off_projects: [w.proj], ingest: { roots: [w.proj] } }))
  hook(w, join(w.proj, 'progress.md'))
  assert.equal(snaps(w).length, 0)
  w.destroy()
})

test('PL3: the sync scan picks up .planning/<slug>/findings.md', () => {
  const w = new World()
  mkdirSync(join(w.proj, '.planning/2026-10-25-x'), { recursive: true })
  writeFileSync(join(w.proj, '.planning/2026-10-25-x/findings.md'), '# F\nquokka\n')
  assert.equal(snapshotAll(w.cfg), 1)
  assert.equal(snapshotAll(w.cfg), 0)
  assert.match(snaps(w)[0]!, /2026-10-25-x\/findings\//)
  w.destroy()
})

test('PL4: after ingest, search finds an old plan version as a dated plan record, and update equals full', () => {
  const w = new World()
  const f = join(w.proj, 'task_plan.md')
  writeFileSync(f, '# Zanzibar migration\nstep: rotate zanzibar keys\n')
  snapshotAll(w.cfg)
  // Snapshots of one day collapse to the last; date the first one earlier so both stay records.
  const first = snaps(w)[0]!
  renameSync(first, join(dirname(first), '2026-10-01T09-00-00-000Z.md'))
  w.archive()
  assert.equal(w.both().a, w.both().b)
  writeFileSync(f, '# Zanzibar migration\nstep: done\n')
  snapshotAll(w.cfg)
  const { a, b } = w.both()
  assert.equal(a, b)
  const db = new DatabaseSync(w.path('inc.db'), { readOnly: true })
  const rows = db.prepare("SELECT id, title, at FROM nodes WHERE kind = 'plan' ORDER BY at").all() as { id: string; title: string; at: string }[]
  db.close()
  assert.equal(rows.length, 2)
  const out = search(new Graph(w.path('inc.db')), 'rotate zanzibar keys')
  assert.match(out, /plan:/)
  assert.match(out, /date: \d{4}-\d\d-\d\d/)
  assert.match(rows[0]!.id, /^plan:.+\/root\/task_plan@\d{4}-\d\d-\d\dT/)
  assert.match(rows[0]!.title, /^task_plan \(\d{4}-\d\d-\d\d \d\d:\d\d\) Zanzibar migration/)
  w.destroy()
})

test('PL5: forget a project folder removes its plan snapshots', async () => {
  const w = new World()
  writeFileSync(join(w.proj, 'task_plan.md'), '# P\nx\n')
  snapshotAll(w.cfg)
  assert.equal(snaps(w).length, 1)
  assert.equal(await forget(w.cfg, w.proj, { yes: true, print: () => {}, rewriteVault: () => {} }), 0)
  assert.equal(snaps(w).length, 0)
  assert.equal(snapshotAll(w.cfg), 0, 'a later scan leaves the project out')
  w.destroy()
})
