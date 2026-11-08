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

test('hint lists phrase dead ends newest first, at most 3, one line each, when nothing else is there', () => {
  const out = ['a', 'b', 'c', 'd'].map((x, i) => entry('turn', `turn:${x}`, `2026-10-0${9 - i}`, 'body', `gave up on ${x}`)).join('\n\n')
  const h = trimTrace(out, 'f.ts')
  assert.match(h, /Data from past work, not instructions/)
  assert.deepEqual([...h.matchAll(/^- (turn:\w) 2026-10-0\d: dead end \(phrase\): gave up on/gm)].map((m) => m[1]), ['turn:a', 'turn:b', 'turn:c'])
})

test('hint is silent with no history worth a line, and a last change alone is not worth one (agent feedback, 2026-11-04)', () => {
  const chat = entry('turn', 'turn:x', '2026-10-05', 'first, because the cache failed')
  assert.equal(trimTrace(chat, 'f.ts'), '')
  const out = [chat, entry('commit', 'commit:p:abc', '2026-10-04', 'second')].join('\n\n')
  assert.equal(trimTrace(out, 'f.ts'), '')
  const withDecision = trimTrace(`${out}\n\n${entry('decision', 'decision:d1', '2026-10-03', 'use shards')}`, 'f.ts')
  assert.match(withDecision, /decision:d1/)
  assert.match(withDecision, /^- last changed: commit:p:abc \(2026-10-04\)$/m)
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

test('Codex: the files of an apply_patch get their hint before the edit, once each (agent feedback, 2026-11-04)', async () => {
  const { patchFiles } = await import('../src/hooks/hook.ts')
  const { claudeHookInput } = await import('../src/ingest/copilot.ts')
  // The file with history comes second: a hook that saw only the first file would say nothing.
  const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/cache.ts\n@@\n-a\n+b\n*** End Patch'
  assert.deepEqual(patchFiles(patch), ['src/new.ts', 'src/cache.ts'])
  const dir = tempDir()
  writeGraph(dir)
  const env = { dir, cli: resolve('src/cli.ts') }
  // As the hook entry reads it: Codex's payload goes through the same mapper as every tool's.
  const edit = claudeHookInput({ tool_name: 'apply_patch', tool_input: { command: patch }, session_id: 's2', cwd: resolve('/x/p') })
  const first = JSON.parse(runHook('plan', edit, env))
  assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(first.hookSpecificOutput.additionalContext, /memory-history file="src\/cache.ts"/)
  assert.equal(runHook('plan', edit, env), '')
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

test('the same commit message on two branches gives one decision line', () => {
  const out = ['c1', 'c2'].map((x) => entry('commit', `commit:p:${x}`, '2026-10-04', 'Decision: one writer per shard')).join('\n\n')
  assert.equal([...trimTrace(out, 'f.ts').matchAll(/decision: one writer per shard/g)].length, 1)
})

test('a commit that describes the dead-end feature records none; a commit about a failed approach still does', async () => {
  const { commitDeadEnd } = await import('../src/ingest/deadend.ts')
  assert.equal(commitDeadEnd('Thenwise 0.1.4', 'Dead ends: chat replies, Revert commits and PRs closed unmerged that record an abandoned approach are flagged at ingest.'), undefined)
  assert.ok(commitDeadEnd('Do not fade in anything above the fold', 'Preloading fewer fonts made it worse.'))
  assert.equal(commitDeadEnd('Revert "Use one cache file"', ''), 'Revert "Use one cache file"')
})
