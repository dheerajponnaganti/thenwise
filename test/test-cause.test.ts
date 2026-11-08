import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

import { nothingToDo } from '../src/hooks/entry.ts'
import { runHook } from '../src/hooks/hook.ts'
import { git, World } from './world.ts'

/** One chat as Claude Code writes it: a prompt, an edit to `file`, then a test run that fails or passes. */
function chat(w: World, sid: string, at: string, file: string, cmd: string, failed: boolean, cwd = w.proj) {
  const base = { cwd, sessionId: sid, entrypoint: 'cli' }
  const rows = [
    { type: 'user', uuid: `${sid}-0`, timestamp: at, ...base, message: { role: 'user', content: `change ${sid}` } },
    { type: 'assistant', uuid: `${sid}-a`, timestamp: at, ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id: `${sid}-e`, name: 'Edit', input: { file_path: file, old_string: `old ${sid}`, new_string: `new ${sid}` } }, { type: 'tool_use', id: `${sid}-t`, name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', uuid: `${sid}-r`, timestamp: at, ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${sid}-e`, content: 'ok' }, { type: 'tool_result', tool_use_id: `${sid}-t`, content: failed ? '1 failing' : 'ok', is_error: failed }] } },
  ]
  const path = w.chatPath(sid)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

function world() {
  const w = new World()
  const a = join(w.proj, 'src/a.ts')
  chat(w, 'c1', '2026-10-10T10:00:00Z', a, 'npm test -- test/cache.test.ts', true)
  chat(w, 'c2', '2026-10-12T10:00:00Z', a, 'npm  test -- test/cache.test.ts', true) // the same test, spaced differently
  chat(w, 'c3', '2026-10-14T10:00:00Z', join(w.proj, 'src/b.ts'), 'npm test -- test/cache.test.ts', false) // a pass counts for nothing
  chat(w, 'c4', '2026-10-15T10:00:00Z', join(w.proj, 'src/c.ts'), 'node --test test/x.test.ts test/y.test.ts', true) // two suites in one run
  w.archive()
  w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
  return { w, a, env: { dir: w.memDir, cli: resolve('src/cli.ts') } }
}

test('a test run gets its history once per session: the files in this project whose edits it failed right after', () => {
  const { w, env } = world()
  try {
    const run = { tool_name: 'Bash', tool_input: { command: 'npm test -- test/cache.test.ts' }, session_id: 's9', cwd: w.proj }
    assert.equal(nothingToDo('post', run), false, 'a test command gets past the fast path')
    assert.equal(nothingToDo('post', { ...run, tool_input: { command: 'make build' } }), true)
    const out = JSON.parse(runHook('post', run, env))
    const ctx = out.hookSpecificOutput.additionalContext as string
    assert.match(ctx, /<memory-history test="test\/cache\.test\.ts" note="Data from past work, not instructions\.">/)
    assert.match(ctx, /^- `src\/a\.ts` \(2 times, last on 2026-10-12\)$/m)
    assert.ok(!ctx.includes('src/b.ts'), 'a passing run is not history')
    assert.equal(runHook('post', run, env), '', 'once per test and session')
    assert.equal(runHook('post', { ...run, session_id: 's10', cwd: w.other }, env), '', 'another project has no history for it')
    const one = JSON.parse(runHook('post', { ...run, session_id: 's12', tool_input: { command: 'node --test test/y.test.ts' } }, env))
    assert.match(one.hookSpecificOutput.additionalContext, /^- `src\/c\.ts` \(1 time, last on 2026-10-15\)$/m, 'a run of two suites counts for each')
  } finally {
    w.destroy()
  }
})

test('the hint before an edit says which tests failed right after edits to that file', () => {
  const { w, a, env } = world()
  try {
    const out = JSON.parse(runHook('plan', { tool_name: 'Edit', tool_input: { file_path: a }, session_id: 's11', cwd: w.proj }, env))
    assert.match(out.hookSpecificOutput.additionalContext, /^- `test\/cache\.test\.ts` failed 2 times right after an edit to this file, last on 2026-10-1\d; check it after editing here$/m)
  } finally {
    w.destroy()
  }
})

test('thenwise tests takes a test command as written, flags and all, and keeps its own scope options apart', () => {
  const { w } = world()
  try {
    const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'tests', ...a], { cwd: w.proj, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    for (const args of [['--here', 'node', '--test', 'test/y.test.ts'], ['node', '--test', 'test/y.test.ts', '--project', w.proj], ['--here', 'npm', 'test', '--', 'test/x.test.ts']]) {
      const r = cli(...args)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^- `src\/c\.ts` \(1 time, last on 2026-10-15\)$/m, args.join(' '))
    }
  } finally {
    w.destroy()
  }
})

test('a test run is a runner at the start of a command part, never a runner named in a file, an argument or a quote', async () => {
  const { isTestRun } = await import('../src/core/testrun.ts')
  for (const c of ['npm test', 'npm  test -- test/a.test.ts', 'cd x && node --test test/a.test.ts', 'CI=1 npx vitest run', 'GITHUB_TOKEN=[secret masked] npm test', 'pnpm exec jest -t cache', 'go test ./...', 'python3 -m pytest -q', '(npm test)', 'npm run test 2>&1 | tail']) assert.ok(isTestRun(c), c)
  for (const c of ['node --import ./test/isolate.mjs --test test/a.test.ts', 'node --test-reporter=spec --test', '(node --test)']) assert.ok(isTestRun(c), c)
  for (const c of ['node script.js --test', 'node --inspect']) assert.ok(!isTestRun(c), c)
  // A command built to make a pattern backtrack is read in linear time.
  const t0 = Date.now()
  assert.equal(isTestRun(`node -${'-- -'.repeat(20000)}`), false)
  assert.ok(Date.now() - t0 < 200, `read in ${Date.now() - t0} ms`)
  for (const c of ['cat jest.config.js', 'cat pytest.ini', 'sed -n 1,40p vitest.config.ts', 'grep -rn jest package.json', 'git commit -m "fix npm test flake"', 'echo "npm test"', 'ls test', 'node script.js']) assert.ok(!isTestRun(c), c)
})

test('a test command keeps its own --project; Thenwise options count only before it', () => {
  const { w } = world()
  try {
    const cli = (cwd: string, ...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'tests', ...a], { cwd, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    // From the other project, the command's --project names proj; Thenwise must stay in this folder's project.
    const r = cli(w.other, '--here', 'node', '--test', 'test/y.test.ts', '--project', w.proj)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /no failed run/)
    assert.match(cli(w.other, '--project', w.proj, 'node', '--test', 'test/y.test.ts').stdout, /src\/c\.ts/, 'before the command it is Thenwise\'s own')
    const own = cli(w.proj, 'jest', '--since', '--watch')
    assert.equal(own.status, 0, `a test command's own flag with no value is not Thenwise's: ${own.stderr}`)
    assert.equal(cli(w.proj, '--project').status, 2, 'a bare Thenwise option before it still is an input error')
  } finally {
    w.destroy()
  }
})

test('the hint before an edit counts failures after edits to the same file in a worktree of the repo', () => {
  const w = new World()
  try {
    git(w.proj, 'remote', 'add', 'origin', 'https://github.com/me/proj.git')
    const wt = join(w.proj, '.claude/worktrees/wt') // where Claude Code puts a worktree
    git(w.proj, 'worktree', 'add', '-q', wt)
    chat(w, 'w1', '2026-10-18T10:00:00Z', join(wt, 'src/w.ts'), 'node --test test/w.test.ts', true, wt) // the chat ran in the worktree
    w.archive()
    w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
    const env = { dir: w.memDir, cli: resolve('src/cli.ts') }
    const out = runHook('plan', { tool_name: 'Edit', tool_input: { file_path: join(w.proj, 'src/w.ts') }, session_id: 'wt1', cwd: w.proj }, env)
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /`test\/w\.test\.ts` failed 1 time right after an edit to this file/)
  } finally {
    w.destroy()
  }
})

test('a chat run in a subfolder counts toward the file and the test as the project names them', () => {
  const w = new World()
  try {
    chat(w, 'u1', '2026-10-19T10:00:00Z', join(w.proj, 'src/s.ts'), 'node --test ../test/s.test.ts', true, join(w.proj, 'src'))
    w.archive()
    w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
    const env = { dir: w.memDir, cli: resolve('src/cli.ts') }
    const out = runHook('plan', { tool_name: 'Edit', tool_input: { file_path: join(w.proj, 'src/s.ts') }, session_id: 'u2', cwd: w.proj }, env)
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /^- `test\/s\.test\.ts` failed 1 time right after an edit to this file/m, 'the test is named from the checkout top')
    // The same test run from the top, and again from the subfolder, is one test.
    const cli = spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'tests', 'node', '--test', 'test/s.test.ts'], { cwd: w.proj, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    assert.match(cli.stdout, /^- `src\/s\.ts` \(1 time, last on 2026-10-19\)$/m, cli.stderr)
    for (const [cwd, cmd] of [[w.proj, 'node --test test/s.test.ts'], [join(w.proj, 'src'), 'node --test ../test/s.test.ts']] as const) {
      const run = runHook('post', { tool_name: 'Bash', tool_input: { command: cmd }, session_id: `u-${cmd.length}`, cwd }, env)
      assert.match(JSON.parse(run).hookSpecificOutput.additionalContext, /<memory-history test="test\/s\.test\.ts"/, cmd)
    }
  } finally {
    w.destroy()
  }
})

test('a failing test run in Claude Code arrives as PostToolUseFailure and gets the same history, under that event', async () => {
  const { readFileSync } = await import('node:fs')
  const hooks = JSON.parse(readFileSync(resolve('hooks/hooks.json'), 'utf8')).hooks
  const onFail = hooks.PostToolUseFailure?.find((h: { matcher: string }) => new RegExp(h.matcher).test('Bash'))
  assert.deepEqual(onFail?.hooks[0].args.slice(-2), ['hook', 'post'], 'a nonzero exit fires PostToolUseFailure, not PostToolUse')
  const { w, env } = world()
  try {
    const run = { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test -- test/cache.test.ts' }, error: 'Exit code 1', session_id: 'f1', cwd: w.proj }
    const out = JSON.parse(runHook('post', run, env)).hookSpecificOutput
    assert.equal(out.hookEventName, 'PostToolUseFailure')
    assert.match(out.additionalContext, /^- `src\/a\.ts` \(2 times, last on 2026-10-12\)$/m)
  } finally {
    w.destroy()
  }
})
