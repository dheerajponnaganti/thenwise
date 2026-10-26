import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { nothingToDo } from '../src/hooks/entry.ts'
import { syncRun } from '../src/hooks/hook.ts'
import { archive } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'
import { Graph } from '../src/query/engine.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'
import { diffStores, git, World } from './world.ts'

test('R8-H2 R8-H3: a sync writes the vault only after an ingest that changed something, or once a day', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ vault: { path: join(dir, 'vault') } }))
  // A stand-in cli: records each step and says what an ingest found.
  const cli = join(dir, 'fake-cli.mjs')
  writeFileSync(cli, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(dir, 'calls'))}, process.argv.slice(2).join(' ') + '\\n')\nif (process.argv[2] === 'ingest') console.log(process.env.FAKE_INGEST ?? 'nothing new: 0 chat files read in 0.0 s')\n`)
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
  const home = process.env.THENWISE_HOME
  process.env.THENWISE_HOME = dir
  try {
    syncRun({ dir, cli })
    assert.ok(calls().includes('vault write'), 'no stamp yet: the first sync writes the vault')
    writeFileSync(join(dir, 'calls'), '')
    syncRun({ dir, cli })
    assert.ok(!calls().includes('vault write'), 'nothing new and written today: skipped')
    writeFileSync(join(dir, 'calls'), '')
    process.env.FAKE_INGEST = 'updated: 1 chat files read in 0.1 s'
    syncRun({ dir, cli })
    assert.ok(calls().includes('vault write'), 'a changed ingest writes it again')
  } finally {
    delete process.env.FAKE_INGEST
    if (home === undefined) delete process.env.THENWISE_HOME
    else process.env.THENWISE_HOME = home
  }
})

test('R8-H4: with roots found from the chats, a new project folder is an update, not a rebuild', () => {
  const w = new World()
  try {
    writeFileSync(join(w.home, '.thenwise/config.json'), JSON.stringify({ ingest: { vaults: [], prs: false } }))
    w.chat('a', { turns: [{ prompt: 'zebra in proj', reply: 'proj zebra plan' }], cwd: w.proj }, '-home-proj')
    const one = loadConfig(w.home)
    assert.ok(one.rootsAuto && !one.roots.includes(w.other))
    archive(one)
    assert.equal(ingest(one, { db: w.path('g.db') }).mode, 'full')
    w.chat('b', { turns: [{ prompt: 'zebra in other', reply: 'other zebra plan' }], cwd: w.other }, '-home-other')
    const two = loadConfig(w.home)
    assert.ok(two.roots.includes(w.other))
    archive(two)
    const r = ingest(two, { db: w.path('g.db') })
    assert.equal(r.mode, 'update')
    assert.ok(new Graph(w.path('g.db')).nodes.has('turn:b-0'), 'the new project is in scope')
    ingest(two, { db: w.path('full.db'), full: true })
    assert.equal(diffStores(w.path('g.db'), w.path('full.db')), '')
  } finally {
    w.destroy()
  }
})

test('R8-H5: git history is the main line plus the commits the chats name; git_all reads every branch', () => {
  const w = new World()
  try {
    git(w.proj, 'checkout', '-q', '-b', 'feature')
    const shas = Array.from({ length: 20 }, (_, i) => w.commit(w.proj, `src/f${i}.ts`, `Feature step ${i}`))
    git(w.proj, 'checkout', '-q', 'main')
    git(w.proj, 'merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature')
    w.chat('a', { turns: [{ prompt: `why did ${shas[4]!.slice(0, 7)} change f4`, reply: 'it moved the step' }] })
    w.archive()
    const { a, b } = w.both()
    assert.equal(a, b, diffStores(w.path('inc.db'), w.path('full.db')))
    const titles = (db: string) => (new DatabaseSync(w.path(db), { readOnly: true }).prepare("SELECT title FROM nodes WHERE kind = 'commit' AND project = 'proj' ORDER BY title").all() as { title: string }[]).map((r) => r.title)
    assert.deepEqual(titles('full.db'), ['Add a', 'Feature step 4', 'Merge feature'])
    w.cfg.gitAll = true
    w.full('all.db')
    assert.equal(titles('all.db').length, 22)
  } finally {
    w.destroy()
  }
})

test('R8-H6: post on a plain command stops before the full hook, and the quick check sends reads on', () => {
  const dir = tempDir()
  assert.equal(nothingToDo('post', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: dir }), true)
  assert.equal(nothingToDo('post', { tool_name: 'Bash', tool_input: { command: 'cat src/x.ts' }, cwd: dir }), false)
  assert.equal(nothingToDo('post', { tool_name: 'Bash', tool_input: { command: 'cat a | grep b' }, cwd: dir }), true)
  assert.equal(nothingToDo('post', { tool_name: 'Edit', tool_input: { file_path: '/x' }, cwd: dir }), false)
  writeFileSync(join(dir, 'task_plan.md'), '# plan\n')
  assert.equal(nothingToDo('post', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: dir }), false, 'plan files: the full hook snapshots them')
  assert.equal(nothingToDo('read', { tool_name: 'NotebookRead', tool_input: { file_path: '/x' } }), true)
  const r = spawnSync(process.execPath, [resolve('src/cli.ts'), 'hook', 'post'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: tempDir() }), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: tempDir() } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('R8-B2: three hundred distinct words keep the term cache at 256', () => {
  const g = new Graph(writeGraph(tempDir()), { lazy: true })
  for (let i = 0; i < 300; i++) g.search(`cache word${i} zeta${i}`)
  assert.ok((g as unknown as { idfCache: Map<string, unknown> }).idfCache.size <= 256)
})

test('R8-B3: the hook matchers name whole tools, so NotebookRead and ReadMcpResource start no hook', () => {
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks
  const all = [...hooks.PreToolUse, ...hooks.PostToolUse].map((h: { matcher: string }) => new RegExp(h.matcher))
  for (const name of ['NotebookRead', 'ReadMcpResource', 'NotebookEdit', 'BashOutput']) assert.ok(!all.some((re) => re.test(name)), name)
  for (const name of ['Read', 'Edit', 'Write', 'MultiEdit', 'Bash']) assert.ok(all.some((re) => re.test(name)), name)
})
