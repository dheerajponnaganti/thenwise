import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { testKey } from '../src/ingest/facts.ts'
import { World } from './world.ts'

const TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/** Chat lines as Claude Code writes them: a prompt, tool calls, and their results. */
function lines(w: World, sid: string, turn: string, at: string, prompt: string, calls: { id: string; name: string; input: object; error?: boolean; out?: string }[]): string {
  const base = { cwd: w.proj, sessionId: sid, entrypoint: 'cli' }
  const out: object[] = [{ type: 'user', uuid: turn, timestamp: at, ...base, message: { role: 'user', content: prompt } }]
  out.push({ type: 'assistant', uuid: `${turn}-a`, timestamp: at, ...base, message: { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) } })
  out.push({ type: 'user', uuid: `${turn}-r`, timestamp: at, ...base, message: { role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.out ?? (c.error ? '1 failing' : 'ok'), is_error: !!c.error })) } })
  return `${out.map((o) => JSON.stringify(o)).join('\n')}\n`
}

test('a turn keeps its edits and test runs; an edit a later turn puts back is marked undone; commands are masked; update equals rebuild', () => {
  const w = new World()
  try {
    const file = w.chatPath('f1')
    mkdirSync(dirname(file), { recursive: true })
    const a = join(w.proj, 'src/a.ts')
    writeFileSync(file, lines(w, 'f1', 't1', '2026-10-10T10:00:00Z', 'try a mutex pool', [
      { id: 'e1', name: 'Edit', input: { file_path: a, old_string: 'const pool = 1', new_string: 'const pool = mutexPool()' } },
      { id: 'b1', name: 'Bash', input: { command: `GITHUB_TOKEN=${TOKEN} npm test -- test/cache.test.ts` }, error: true },
    ]))
    w.archive()
    w.ingest('inc.db')
    // The next turn puts the old text back: the mutex pool was tried and undone.
    appendFileSync(file, lines(w, 'f1', 't2', '2026-10-10T10:05:00Z', 'go back', [{ id: 'e2', name: 'Edit', input: { file_path: a, old_string: 'const pool = mutexPool()', new_string: 'const pool = 1' } }]))
    w.archive()
    const r = w.both()
    assert.equal(r.a, r.b, 'an update stores the same facts as a rebuild')

    const db = new DatabaseSync(w.path('full.db'), { readOnly: true })
    const changes = db.prepare('SELECT node, file, undone FROM changes ORDER BY at').all() as { node: string; file: string; undone: number }[]
    assert.deepEqual(changes.map((c) => [c.node, c.undone]), [['turn:t1', 1], ['turn:t2', 0]])
    assert.ok(changes[0]!.file.endsWith('src/a.ts') && !changes[0]!.file.includes('\\'))
    const tests = db.prepare('SELECT node, key, failed, cmd, after FROM tests').all() as { node: string; key: string; failed: number; cmd: string; after: string }[]
    assert.equal(tests.length, 1)
    assert.equal(tests[0]!.key, 'test/cache.test.ts')
    assert.equal(tests[0]!.failed, 1)
    assert.ok(tests[0]!.after.endsWith('src/a.ts'), 'the file edited just before the run')
    assert.ok(!tests[0]!.cmd.includes(TOKEN), 'a token in a command is masked')
    db.close()
  } finally {
    w.destroy()
  }
})

test('#108: a Bash call that tests and commits keeps its test run; update equals rebuild', () => {
  const w = new World()
  try {
    const file = w.chatPath('f2')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, lines(w, 'f2', 't1', '2026-10-10T10:00:00Z', 'test and commit', [{ id: 'b1', name: 'Bash', input: { command: 'npm test && git commit -m "Fix it"' }, out: 'ok\n[main 1a2b3c4] Fix it' }]))
    w.archive()
    w.ingest('inc.db')
    appendFileSync(file, lines(w, 'f2', 't2', '2026-10-10T10:05:00Z', 'again', [{ id: 'b2', name: 'Bash', input: { command: 'git commit -m "Retry" && npm test' }, error: true, out: '[main 5d6e7f8] Retry\n1 failing' }]))
    // The tests passed, then git found nothing to commit: the call failed, the test run did not.
    appendFileSync(file, lines(w, 'f2', 't3', '2026-10-10T10:10:00Z', 'once more', [{ id: 'b3', name: 'Bash', input: { command: 'npm test && git commit -m "Again"' }, error: true, out: 'ok\nnothing to commit, working tree clean' }]))
    w.archive()
    const r = w.both()
    assert.equal(r.a, r.b, 'an update stores the same test runs as a rebuild')
    const db = new DatabaseSync(w.path('full.db'), { readOnly: true })
    const tests = db.prepare('SELECT node, failed FROM tests ORDER BY at').all() as { node: string; failed: number }[]
    db.close()
    assert.deepEqual(tests.map((t) => [t.node, t.failed]), [['turn:t1', 0], ['turn:t2', 1], ['turn:t3', 0]])
  } finally {
    w.destroy()
  }
})

test('the test key is the test files a command names, else the command without flags', () => {
  assert.equal(testKey('node --test test/b.test.ts test/a.test.ts'), 'test/a.test.ts test/b.test.ts')
  assert.equal(testKey('go test ./... -run TestCache pkg/cache_test.go'), 'pkg/cache_test.go')
  assert.equal(testKey('CI=1 npm test --silent'), 'npm test')
  assert.equal(testKey('pytest -q'), 'pytest')
  assert.equal(testKey("node --test 'test/*.test.ts'"), 'test/*.test.ts', 'a glob is the whole suite, not its suffix')
})
