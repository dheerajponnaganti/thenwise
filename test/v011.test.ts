import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

import { trimTrace } from '../src/hooks/hook.ts'
import { sessionPart } from '../src/ingest/parts.ts'
import { parseSession } from '../src/ingest/transcript.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { diffStores, World } from './world.ts'

// A chat as Claude Code writes it, with real Edit and Bash tool calls. Each step is one turn.
type Step = { prompt: string; edits?: [string, string, string][]; test?: 'pass' | 'fail' }
function chat(id: string, steps: Step[], cwd = '/x/p', day = '2026-10-05'): string {
  const out: object[] = []
  const base = { cwd, sessionId: id, entrypoint: 'cli' }
  steps.forEach((s, i) => {
    const at = `${day}T10:${String(i).padStart(2, '0')}:00Z`
    out.push({ type: 'user', uuid: `${id}-${i}`, timestamp: at, ...base, message: { role: 'user', content: s.prompt } })
    const blocks: object[] = (s.edits ?? []).map(([file, o, n], k) => ({ type: 'tool_use', id: `${id}-${i}-e${k}`, name: 'Edit', input: { file_path: file, old_string: o, new_string: n } }))
    if (s.test) blocks.push({ type: 'tool_use', id: `${id}-${i}-t`, name: 'Bash', input: { command: 'npm test' } })
    if (blocks.length) out.push({ type: 'assistant', uuid: `${id}-${i}-a`, timestamp: at, ...base, message: { role: 'assistant', content: blocks } })
    if (s.test) out.push({ type: 'user', uuid: `${id}-${i}-r`, timestamp: at, ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-${i}-t`, is_error: s.test === 'fail', content: s.test === 'fail' ? '1 failing' : 'ok' }] } })
  })

  return `${out.map((o) => JSON.stringify(o)).join('\n')}\n`
}
const part = (text: string, id: string) => sessionPart(parseSession(text, id, '/h'), 'p')
const turnOf = (p: ReturnType<typeof part>, id: string) => p.nodes.find((n) => n.id === `turn:${id}`)!

test('R11-H1: an edit put back three turns later is an undone dead end, naming both turns and the file', () => {
  const p = part(chat('u', [{ prompt: 'try a lock', edits: [['/x/p/src/a.ts', 'let v = 1', 'let v = lock(1)']] }, { prompt: 'look at b' }, { prompt: 'more' }, { prompt: 'drop the lock', edits: [['/x/p/src/a.ts', 'let v = lock(1)', 'let v = 1']] }]), 'u')
  const t = turnOf(p, 'u-3')
  assert.equal(t.extra.deadEndKind, 'undone')
  assert.match(String(t.extra.deadEnd), /^undone edit to src\/a\.ts \(made in turn u-0, put back in turn u-3\)$/)
  assert.ok(p.edges.some((e) => e.src === 'turn:u-3' && e.dst === 'file:/x/p/src/a.ts' && e.kind === 'dead_end'))
  assert.equal(turnOf(p, 'u-0').extra.deadEnd, undefined)
})

test('R11-H2 R11-B2: tests that fail after an edit, then work on another file, is a failed-test dead end; a failure alone is not', () => {
  const p = part(chat('f', [{ prompt: 'change a', edits: [['/x/p/src/a.ts', 'x', 'y']], test: 'fail' }, { prompt: 'try b instead', edits: [['/x/p/src/b.ts', 'p', 'q']] }]), 'f')
  assert.equal(turnOf(p, 'f-1').extra.deadEndKind, 'failed-test')
  assert.match(String(turnOf(p, 'f-1').extra.deadEnd), /tests failed after editing src\/a\.ts; moved on to src\/b\.ts/)
  const quiet = part(chat('g', [{ prompt: 'change a', edits: [['/x/p/src/a.ts', 'x', 'y']], test: 'fail' }, { prompt: 'explain the failure' }]), 'g')
  assert.ok(quiet.nodes.every((n) => !n.extra.deadEnd))
  const fixed = part(chat('k', [{ prompt: 'change a', edits: [['/x/p/src/a.ts', 'x', 'y']], test: 'fail' }, { prompt: 'fix a', edits: [['/x/p/src/a.ts', 'y', 'z']], test: 'pass' }, { prompt: 'now b', edits: [['/x/p/src/b.ts', 'p', 'q']] }]), 'k')
  assert.ok(fixed.nodes.every((n) => !n.extra.deadEnd), 'fixed and green, then other work: no dead end')
})

test('R11-H3: a [dead-end] line in a prompt makes the turn a dead end with that text', () => {
  const p = part(chat('m', [{ prompt: 'that was a mistake\n[dead-end] the single-file cache\nlet us move on' }]), 'm')
  assert.equal(turnOf(p, 'm-0').extra.deadEnd, 'the single-file cache')
  assert.equal(turnOf(p, 'm-0').extra.deadEndKind, 'marked')
})

test('R11-B1: an edit undone in a later session is not a dead end', () => {
  const later = part(chat('s2', [{ prompt: 'put it back', edits: [['/x/p/src/a.ts', 'let v = lock(1)', 'let v = 1']] }], '/x/p', '2026-10-09'), 's2')
  assert.ok(later.nodes.every((n) => !n.extra.deadEnd))
})

test('R11-H5: the hint puts what happened first, then curated notes, commit decisions and the last change', () => {
  const entry = (kind: string, id: string, date: string, body: string, dead?: string) => `- [${kind}] ${id}\n   date: ${date}   project: p   source: x${dead ? `\n   dead end (automatic, ${dead})` : ''}\n   | ${body}`
  const out = [
    entry('turn', 'turn:new', '2026-10-09', 'talk', 'phrase): it did not work'),
    entry('turn', 'turn:u', '2026-10-08', 'edit', 'undone): undone edit to src/a.ts (made in turn a, put back in turn b)'),
    entry('commit', 'commit:p:c3', '2026-10-07', 'Rework a\n   | Decision: keep a single writer'),
    entry('decision', 'decision:d1', '2026-10-06', 'use shards for the exporter'),
    entry('commit', 'commit:p:c2', '2026-10-05', 'Older change'),
  ].join('\n\n')
  const h = trimTrace(out, 'src/a.ts')
  const order = ['undone edit to src/a.ts', 'decision:d1', 'decision: keep a single writer', 'last changed: commit:p:c3', 'dead end (phrase)'].map((x) => h.indexOf(x))
  assert.ok(order.every((x) => x > 0), h)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(h.length < 600 * 4)
})

test('R11-H4: thenwise deadend writes an active note that the next ingest gives to tried', () => {
  const w = new World()
  try {
    const r = spawnSync(process.execPath, [resolve('src/cli.ts'), 'deadend', 'shards without a lock lost writes'], { encoding: 'utf8', env: { ...process.env, HOME: w.home } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /dead end saved as n-/)
    w.archive()
    w.ingest('g.db')
    const out = c.tried(new Graph(w.path('g.db')), 'shards without a lock')
    assert.match(out, /\[dead_end\]/)
  } finally {
    w.destroy()
  }
})

test('R11-B3: an update after a chat gains an undone edit equals a full rebuild', () => {
  const w = new World()
  try {
    const first: Step[] = [{ prompt: 'try a lock', edits: [[`${w.proj}/src/a.ts`, 'let v = 1', 'let v = lock(1)']] }]
    mkdirSync(dirname(w.chatPath('d1')), { recursive: true })
    writeFileSync(w.chatPath('d1'), chat('d1', first, w.proj))
    w.archive()
    w.ingest('inc.db')
    writeFileSync(w.chatPath('d1'), chat('d1', [...first, { prompt: 'drop it', edits: [[`${w.proj}/src/a.ts`, 'let v = lock(1)', 'let v = 1']] }], w.proj))
    w.archive()
    const { a, b } = w.both()
    assert.equal(a, b, diffStores(w.path('inc.db'), w.path('full.db')))
    assert.equal(new Graph(w.path('inc.db')).nodes.get('turn:d1-1')!.extra.deadEndKind, 'undone')
  } finally {
    w.destroy()
  }
})
