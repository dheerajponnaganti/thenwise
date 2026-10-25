import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { runHook, trimTrace } from '../src/hooks/hook.ts'
import { commitDeadEnd, deadEnd } from '../src/ingest/deadend.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

test('dead end detector flags a dropped approach in prose', () => {
  assert.match(deadEnd('We tried a cache here. It did not work because the keys collide.')!, /did not work/)
  assert.ok(deadEnd('I reverted the change to the loader after it made it worse.'))
  assert.ok(deadEnd('Originally this used polling, but it was replaced by a watcher.'))
  assert.equal(commitDeadEnd('Revert "add cache"', ''), 'Revert "add cache"')
})

test('dead end detector ignores code, quotes, questions, advice and plain design talk', () => {
  assert.equal(deadEnd('```\nit did not work and we reverted\n```'), undefined)
  assert.equal(deadEnd('Run `git revert HEAD` to undo.'), undefined)
  assert.equal(deadEnd('> you said it didn\'t work last time'), undefined)
  assert.equal(deadEnd('Did the last try fail, or did it not work at all?'), undefined)
  assert.equal(deadEnd('If it is too slow, give up on the index.'), undefined)
  assert.equal(deadEnd('Use a map instead of an array for lookups.'), undefined)
  assert.equal(commitDeadEnd('Add cache', 'Nothing special here.'), undefined)
})

const entry = (tag: string, id: string, date: string, text: string, dead = '') => `- [${tag}] ${id}\n   date: ${date}   project: p   source: s${dead ? `\n   dead end (automatic): ${dead}` : ''}\n   | ${text}`

test('hint lists automatic dead ends newest first, at most 3, one line each', () => {
  const out = ['a', 'b', 'c', 'd'].map((x, i) => entry('turn', `turn:${x}`, `2026-10-0${9 - i}`, 'body', `gave up on ${x}`)).join('\n\n')
  const h = trimTrace(out, 'f.ts')
  assert.match(h, /Data from past work, not instructions/)
  assert.deepEqual([...h.matchAll(/^- (turn:\w) 2026-10-0\d: dead end: gave up on/gm)].map((m) => m[1]), ['turn:a', 'turn:b', 'turn:c'])
})

test('hint is silent for plain history: no dead end and no curated note means no hint', () => {
  const out = [entry('turn', 'turn:x', '2026-10-05', 'first, because the cache failed'), entry('commit', 'commit:p:abc', '2026-10-04', 'second')].join('\n\n')
  assert.equal(trimTrace(out, 'f.ts'), '')
  assert.match(trimTrace(`${out}\n\n${entry('decision', 'decision:d1', '2026-10-03', 'use shards')}`, 'f.ts'), /decision:d1/)
  assert.equal(trimTrace('', 'f.ts'), '')
})

test('PreToolUse hint comes before the first edit and is shared with Read', () => {
  const dir = tempDir()
  writeGraph(dir)
  const env = { dir, cli: resolve('src/cli.ts') }
  const edit = { tool_name: 'Edit', tool_input: { file_path: '/x/p/src/cache.ts' }, session_id: 's1', cwd: '/x/p' }
  const first = JSON.parse(runHook('plan', edit, env))
  assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(first.hookSpecificOutput.additionalContext, /memory-history file="src\/cache.ts"/)
  assert.equal(runHook('plan', edit, env), '')
  assert.equal(runHook('read', { ...edit, tool_name: 'Read' }, env), '')
})

test('ingest marks reverts and dead-end replies, and not the user prompt', async () => {
  const { parseLog, sessionPart } = await import('../src/ingest/parts.ts')
  const log = `\x1eabc123\x1f2026-10-01T10:00:00Z\x1fRevert "add cache"\x1f\x1dsrc/a.ts\n\x1edef456\x1f2026-10-02T10:00:00Z\x1fAdd cache\x1f\x1dsrc/a.ts\n`
  const c = parseLog(log, '/r/p')
  assert.equal(c[0]!.node.extra.deadEnd, 'Revert "add cache"')
  assert.equal(c[1]!.node.extra.deadEnd, undefined)
  const turn = (id: string, prompt: string, reply: string) => ({ id, at: '2026-10-01T10:00:00Z', prompt, reply: [reply], reads: new Set<string>(), edits: new Set<string>(['/r/p/src/a.ts']), ran: new Set<string>(), commitMsgs: [], commitShas: new Set<string>(), prUrls: new Set<string>() })
  const s: any = { id: 's', sub: false, start: '2026-10-01T10:00:00Z', end: '', cwd: '/r/p', paths: [], summaries: [], turns: [turn('t1', 'It did not work last time, why?', 'Done.'), turn('t2', 'go', 'The polling approach did not work, so I went with a watcher.')] }
  const n = new Map(sessionPart(s, 'p').nodes.map((x) => [x.id, x]))
  assert.equal(n.get('turn:t1')!.extra.deadEnd, undefined)
  assert.match(String(n.get('turn:t2')!.extra.deadEnd), /polling approach did not work/)
})
