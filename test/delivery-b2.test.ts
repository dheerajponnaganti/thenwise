// Delivery fixes B2: query scope and paths, branch labels, paging, resume brief, plans, and the hooks.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { readTarget, runHook, shortPath, takeLock } from '../src/hooks/hook.ts'
import { keyOf, plansPart } from '../src/ingest/plans.ts'
import { buildPassageIndex } from '../src/query/passages.ts'
import { Graph } from '../src/query/engine.ts'
import { asof, resume, trace } from '../src/query/commands.ts'
import { readLog } from '../src/core/log.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'
import { World } from './world.ts'

type N = [id: string, kind: string, title: string, text: string, at: string, source?: string, extra?: object, project?: string]
/** Writes a graph.db from node and edge lists (the same schema the ingest writes). */
function build(dir: string, nodes: N[], edges: [string, string, string][] = []): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'graph.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const ins = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)')
  for (const [id, kind, title, text, at, source = '', extra = {}, project = 'p'] of nodes) ins.run(id, kind, title, text, at, '', project, source, JSON.stringify(extra))
  for (const [a, b, k] of edges) db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(a, b, k, '', '{}')
  buildPassageIndex(db)
  db.close()

  return file
}
const repo = (dir: string, name: string) => {
  const p = join(dir, name)
  mkdirSync(join(p, '.git'), { recursive: true })

  return realpathSync(p)
}
// The hook messages from the structured log, one per line. Logging is on here: these tests read it.
delete process.env.THENWISE_LOG
const logOf = (dir: string) => readLog(dir).filter((e) => e.msg).map((e) => e.msg).join('\n')

test('B2-13/14: a common file name prefers the session repo; absolute, spaced, bracketed and note: paths match', () => {
  const dir = tempDir()
  const repos = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'z'].map((n) => repo(dir, n))
  const mine = repos[6]!
  mkdirSync(join(mine, 'My Docs'), { recursive: true })
  const nodes: N[] = [...repos.map((r): N => [`file:${r}/README.md`, 'file', 'README.md', '', '']), [`file:${mine}/My Docs/notes [v2] (1).md`, 'file', 'notes [v2] (1).md', '', '']]
  const g = new Graph(build(dir, nodes))
  g.scopeTo(mine)
  assert.equal(g.exact('README.md')[0]!.id, `file:${mine}/README.md`)
  const odd = `${mine}/My Docs/notes [v2] (1).md`
  assert.equal(g.exact(odd)[0]?.id, `file:${odd}`)
  assert.equal(g.exact(`note: ${odd}`)[0]?.id, `file:${odd}`)
  assert.equal(g.exact(odd.replace(/\//g, '\\'))[0]?.id, `file:${odd}`)
  assert.equal(shortPath('C:\\Work\\app\\src\\a.ts', 'c:\\work\\app'), 'src/a.ts')
  assert.equal(shortPath('/w/app/src/a.ts', '/w/app/'), 'src/a.ts')
})

test('B2-15/16: the compaction brief is for this repo and this session, and puts what is next first', () => {
  const dir = tempDir()
  const base = realpathSync(dir)
  const mk = (name: string) => {
    const p = join(base, name)
    mkdirSync(join(p, '.git'), { recursive: true })
    return p
  }
  const mine = mk('carapace')
  const crew = mk('carapace-tools')
  const ses = (id: string, cwd: string, at: string): N => [id, 'session', 'work', 'work', at, '', { cwd }, keyOf(cwd)]
  const nodes: N[] = [
    ses('ses:mine', mine, '2026-10-01T09:00:00Z'),
    ses('ses:crew', crew, '2026-10-02T09:00:00Z'), // newer, and the folder name contains "carapace"
    ['turn:m1', 'turn', 'mine', 'Mine: wiring the shells', '2026-10-01T10:00:00Z', 'ses:mine'],
    ['turn:c1', 'turn', 'crew', 'Crew: unrelated research', '2026-10-02T10:00:00Z', 'ses:crew'],
    ['note:pending.md', 'note', 'Pending', '- **Next to build:** the shell wiring', '2026-10-01T00:00:00Z', join(mine, 'pending.md')],
  ]
  const f = build(join(dir, 'store'), nodes)
  const g = new Graph(f)
  g.scopeTo(mine)
  const out = resume(g, '')
  assert.match(out, /Mine: wiring/)
  assert.doesNotMatch(out, /Crew: unrelated/)
  assert.ok(out.indexOf('## Next on the build list') < out.indexOf('## Last 1 turns'), 'next comes before old turns')
  // Through the hook: the current transcript is read directly (the store has no such session), masked.
  const tr = join(dir, 'live.jsonl')
  const key = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  writeFileSync(tr, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-25T10:00:00Z', cwd: mine, sessionId: 'live', message: { role: 'user', content: `fix the zebra bug ${key}` } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-25T10:00:05Z', cwd: mine, sessionId: 'live', message: { role: 'assistant', content: [{ type: 'text', text: 'zebra fixed' }] } })}\n`)
  process.env.THENWISE_SYNC = 'off'
  try {
    const env = { dir: join(dir, 'store'), cli: resolve('src/cli.ts') }
    const reply = runHook('session-start', { source: 'compact', cwd: mine, transcript_path: tr, session_id: 'live' }, env)
    assert.match(reply, /zebra bug/)
    assert.ok(!reply.includes(key))
    assert.match(reply, /Mine: wiring/)
    assert.doesNotMatch(reply, /Crew: unrelated/)
  } finally {
    process.env.THENWISE_SYNC = 'off' // the preload's default
  }
})

test('B2-17: asof prefers on-main commits, labels others, never picks a stash', () => {
  const c = (sha: string, title: string, at: string, extra: object): N => [`commit:p:${sha}`, 'commit', title, `cache work ${title}`, at, '/x/p', { sha, ...extra }]
  const dir = tempDir()
  const g = new Graph(build(dir, [c('aaaaaaa1', 'main cache', '2026-10-01T00:00:00Z', {}), c('bbbbbbb2', 'branch cache', '2026-10-05T00:00:00Z', { onMain: false, branch: 'hb' }), c('ccccccc3', 'WIP on main: cache', '2026-10-06T00:00:00Z', { onMain: false })]))
  const out = asof(g, '2026-10-10', 'cache')
  assert.match(out, /show aaaaaaa:<path>/)
  assert.doesNotMatch(out, /show (bbbbbbb|ccccccc)/)
  assert.match(out, /on branch hb, not on main/)
  const only = new Graph(build(tempDir(), [c('ddddddd4', 'gone cache', '2026-10-01T00:00:00Z', { unreachable: true })]))
  assert.match(asof(only, '2026-10-10', 'cache'), /no longer in git/)
})

test('B2-22/23: other projects cannot fill the limit, paused ones leave the fallback, a deleted repo keeps its scope', () => {
  const dir = tempDir()
  const a = repo(dir, 'a')
  const b = repo(dir, 'b')
  const gone = join(realpathSync(dir), 'gone-repo')
  const ses = (id: string, cwd: string): N => [id, 'session', 'work', 'work', '2026-10-01T09:00:00Z', '', { cwd }, keyOf(cwd)]
  const nodes: N[] = [ses('ses:a', a), ses('ses:b', b), ses('ses:g', gone), ['turn:gone', 'turn', 'old', 'zebra in a deleted repo', '2026-10-01T10:00:00Z', 'ses:g']]
  for (let i = 0; i < 450; i++) nodes.push([`turn:b${i}`, 'turn', 'b', 'zebra zebra zebra', '2026-10-02T10:00:00Z', 'ses:b'])
  nodes.push(['turn:a0', 'turn', 'a', 'zebra crossing story for the project with extra words', '2026-10-03T10:00:00Z', 'ses:a'])
  const g = new Graph(build(dir, nodes))
  g.scopeTo(a)
  assert.ok(g.search('zebra').hits.some((h) => h.node.id === 'turn:a0'), 'in-scope hit survives 450 stronger hits elsewhere')
  g.scope = undefined
  g.hide = (r) => r === b
  assert.ok(!g.search('zebra').hits.some((h) => h.node.source === 'ses:b'))
  g.hide = undefined
  g.scopeTo(a)
  assert.equal(g.rootOf(g.nodes.get('turn:gone')!), gone)
  assert.equal(g.inScope(g.nodes.get('turn:gone')), false, 'a deleted repo is its own project, not global')
})

test('B2-24: memory_trace pages instead of dropping the oldest items', () => {
  const nodes: N[] = [['file:/x/p/big.ts', 'file', 'big.ts', '', '']]
  const edges: [string, string, string][] = []
  for (let i = 0; i < 30; i++) {
    const id = `turn:t${String(i).padStart(2, '0')}`
    nodes.push([id, 'turn', `t${i}`, `edit number ${i} of big.ts ${'filler words '.repeat(25)}`, `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`])
    edges.push([id, 'file:/x/p/big.ts', 'edited'])
  }
  const g = new Graph(build(tempDir(), nodes, edges))
  const first = trace(g, 'x/p/big.ts', 100, 0, 3000)
  assert.ok(first.length < 3600, `${first.length}`)
  const more = /offset=(\d+)/.exec(first)
  assert.ok(more, 'says how to get older items')
  const second = trace(g, 'x/p/big.ts', 100, Number(more![1]), 3000)
  assert.ok(first.includes('turn:t29') && !second.includes('turn:t29'))
  const ids = (s: string) => new Set(s.match(/turn:t\d\d/g))
  assert.ok([...ids(second)].every((x) => !ids(first).has(x)), 'pages do not overlap')
})

test('B2-26: plans collapse per day, nest under the repo, and a Bash change is caught afterwards', () => {
  const w = new World()
  process.env.THENWISE_HOME = w.memDir
  try {
    const nested = join(w.proj, 'sub')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'task_plan.md'), '# Plan\none\n')
    const env = { dir: w.memDir, cli: '' }
    runHook('post', { tool_name: 'Bash', tool_input: { command: 'echo hi >> sub/task_plan.md' }, cwd: nested, session_id: 's' }, env)
    writeFileSync(join(nested, 'task_plan.md'), '# Plan\ntwo\n')
    runHook('post', { tool_name: 'Bash', tool_input: { command: 'sed -i s/one/two/ task_plan.md' }, cwd: nested, session_id: 's' }, env)
    const base = join(w.memDir, 'archive/plans', keyOf(w.proj))
    assert.ok(existsSync(base), 'keyed by the repo root, so sessions in the repo find it')
    const files = readdirSync(join(base, 'sub~root', 'task_plan'))
    assert.equal(files.length, 2, 'both versions stay on disk')
    const recs = plansPart(w.cfg).nodes.filter((n) => n.kind === 'plan')
    assert.equal(recs.length, 1, 'one record for the day')
    assert.match(recs[0]!.text, /two/)
  } finally {
    delete process.env.THENWISE_HOME
    w.destroy()
  }
})

test('B2-27/28: the file hint is spent only on an answer, per agent; a plain Bash read gets it too', () => {
  const dir = tempDir()
  writeGraph(dir)
  const env = { dir, cli: resolve('src/cli.ts') }
  const read = (file: string, agent?: string) => runHook('read', { tool_name: 'Read', tool_input: { file_path: file }, cwd: '/x/p', session_id: 's1', ...(agent ? { agent_id: agent } : {}) }, env)
  assert.equal(read('/x/p/nothing.ts'), '')
  assert.equal(read('/x/p/nothing.ts'), '', 'still empty, and no crash')
  assert.ok(!readdirSync(join(dir, 'hook-state')).some((f) => readFileSync(join(dir, 'hook-state', f), 'utf8').includes('nothing.ts')), 'a failure does not spend the hint')
  assert.match(read('/x/p/src/cache.ts', 'sub1'), /memory-history/)
  assert.match(read('/x/p/src/cache.ts'), /memory-history/, 'a subagent read did not spend the main thread hint')
  assert.equal(read('/x/p/src/cache.ts'), '')
  assert.ok(!readdirSync(join(dir, 'hook-state')).some((f) => f.endsWith('.tmp')))
  const post = (command: string) => runHook('post', { tool_name: 'Bash', tool_input: { command }, cwd: '/x/p', session_id: 's2' }, env)
  assert.match(post('sed -n 1,20p src/cache.ts'), /memory-history/)
  assert.equal(post('ls src'), '')
  assert.equal(readTarget('cat a.ts b.ts', '/x'), undefined)
  assert.equal(readTarget('cat a.ts | head', '/x'), undefined)
  assert.equal(readTarget('head -n 5 a.ts', '/x'), '/x/a.ts')
  assert.equal(readTarget('tail -n 5 /y/a.ts', '/x'), '/y/a.ts')
  assert.equal(readTarget('rm a.ts', '/x'), undefined)
  assert.equal(readTarget('cat -n a.ts', '/x'), '/x/a.ts')
})

test('B2-28: the Bash hook on a non-read command is cheap and never opens the store', () => {
  const dir = tempDir()
  writeGraph(dir)
  const run = () => {
    const t = Date.now()
    const r = spawnSync(process.execPath, [resolve('src/cli.ts'), 'hook', 'post'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/x/p', session_id: 's' }), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: dir, HOME: dir } })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), '')

    return Date.now() - t
  }
  run()
  const ms = run()
  assert.ok(ms < 600, `${ms} ms`)
})

test('B2-32: a lock older than an hour is stale even when its pid is alive', () => {
  const lock = join(tempDir(), 'sync.lock')
  writeFileSync(lock, String(process.pid))
  assert.equal(takeLock(lock, process.pid + 1), false)
  const old = new Date(Date.now() - 2 * 3_600_000)
  utimesSync(lock, old, old)
  assert.equal(takeLock(lock, process.pid + 1), true)
})

test('B2-33/34: hooks.json matches clear and compact, and ends a session with a sync', () => {
  const h = JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks
  assert.match('clear', new RegExp(`^(${h.SessionStart[0].matcher})$`))
  assert.match('compact', new RegExp(`^(${h.SessionStart[0].matcher})$`))
  assert.ok(h.SessionEnd[0].hooks[0].args.includes('session-end'))
  assert.ok(h.PostToolUse.some((x: any) => x.matcher.includes('Bash')))
  const dir = tempDir()
  process.env.THENWISE_SYNC = 'off'
  try {
    runHook('session-end', { cwd: '/x/p' }, { dir, cli: '' })
    runHook('session-start', { source: 'clear', cwd: '/x/p' }, { dir, cli: '' })
    runHook('session-start', { source: 'compact', cwd: '/x/p' }, { dir, cli: '' })
    assert.equal(logOf(dir).match(/sync off/g)?.length, 3, 'each one tried to start a sync')
  } finally {
    process.env.THENWISE_SYNC = 'off' // the preload's default
  }
})
