import assert from 'node:assert/strict'
import { test } from 'node:test'

import { correctionProposals, parseClaudeHistory } from '../src/core/corrections.ts'

const line = (display: string, sessionId: string, at: number, project = '/p') => JSON.stringify({ display, timestamp: at, sessionId, project })

test('history: prompts with time, session and project; slash commands and broken lines skipped', () => {
  const ev = parseClaudeHistory([line('use my name only', 's1', 1), line('/clear', 's1', 2), '{broken', ''].join('\n'))
  assert.deepEqual(ev, [{ text: 'use my name only', at: 1, sessionId: 's1', project: '/p' }])
})

test('a correction repeated across sessions becomes a proposal; short interruptions and one-session repeats do not', () => {
  const ev = parseClaudeHistory(
    [
      line("don't add claude as a co-author in commits", 's1', 1),
      line('please never add claude as co-author in my commits', 's2', 2),
      line("again: don't put claude in the commit co-author line", 's3', 3),
      line('stop', 's1', 4),
      line('stop', 's2', 5),
      line('stop', 's3', 6),
      line("don't use tabs in this file", 's4', 7),
      line("don't use tabs in this file please", 's4', 8),
      line("don't use tabs in this file at all", 's4', 9),
    ].join('\n'),
  )
  const p = correctionProposals(ev)
  assert.equal(p.length, 1)
  assert.equal(p[0]!.count, 3)
  assert.equal(p[0]!.sessions, 3)
  assert.equal(p[0]!.text, "again: don't put claude in the commit co-author line")
  assert.equal(correctionProposals(ev, { minCount: 3, minSessions: 1, same: 0.25 }).length, 2, 'the tabs rule counts once a single session is enough')
})
