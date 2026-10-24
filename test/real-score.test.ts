import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scoreOne } from '../bench/real/score.ts'
import type { RealQuestion } from '../bench/real/score.ts'

const q: RealQuestion = {
  id: 'x-001', kind: 'current', question: 'How long does an access token last now?', as_of: null, answer: '15 minutes',
  must: [['15 minutes', '15 min'], ['refresh']], must_not: ['5 minutes'], sources: [{ type: 'pr', ref: '#74' }, { type: 'vault', ref: 'Mods/Logbook.md' }], only_in: 'pr', difficulty: 2,
}
const a = (answer: string) => ({ id: 'x-001', arm: 't', run: 1, answer })

test('all facts, any phrasing, gives a correct answer', () => {
  const s = scoreOne(q, a('Tokens last 15 min; a Refresh token renews them (PR #74).'))
  assert.equal(s.facts, 1)
  assert.equal(s.correct, true)
  assert.equal(s.cited, true)
})

test('a missing fact is partial, not correct', () => {
  const s = scoreOne(q, a('They last 15 minutes.'))
  assert.equal(s.facts, 0.5)
  assert.equal(s.correct, false)
})

test('an outdated fact fails, unless the answer says it was replaced', () => {
  assert.equal(scoreOne(q, a('5 minutes, with a refresh token. 15 minutes is wrong.')).outdated, true)
  const s = scoreOne(q, a('It used to be 5 minutes; now 15 minutes with a refresh token, per the Logbook note.'))
  assert.equal(s.outdated, false)
  assert.equal(s.correct, true)
  assert.equal(s.cited, true)
})

test('negatives are correct only when the answer abstains', () => {
  const n: RealQuestion = { ...q, kind: 'negative', must: [], must_not: [] }
  assert.equal(scoreOne(n, a('This is not recorded in the notes or PRs.')).correct, true)
  assert.equal(scoreOne(n, a('We chose Redis in PR #12.')).correct, false)
  assert.equal(scoreOne(q, a("I couldn't find it.")).abstained, true)
})

test('versions, hyphenated words and words in between still match', () => {
  const r: RealQuestion = { ...q, must: [['0.9.2'], ['squash'], ['real session']], must_not: [] }
  assert.equal(scoreOne(r, a('Shipped in v0.9.2, squash-merged, after a real Claude Code session.')).facts, 1)
  assert.equal(scoreOne(r, a('Shipped in 10.9.21, squashing, real sessions.')).facts, 0)
})
