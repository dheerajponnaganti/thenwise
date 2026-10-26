import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex } from '../src/query/passages.ts'

type N = [id: string, text: string, at: string, source?: string, title?: string]
function graph(nodes: N[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'tw-013-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  for (const [id, text, at, source = 'ses:a', title = 'chat'] of nodes) db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'turn', title, text, at, '', 'p', source, '{}')
  buildPassageIndex(db)
  db.close()

  return new Graph(file)
}
const filler = (i: number) => Array.from({ length: 12 }, (_, k) => `unrelated filler line ${i}${k} about release chores`).join('. ')

test('R13-H2: when nothing matches, the words the first results share are searched too, and the header says so', () => {
  // The question says "rollout freeze"; the record that answers says "deploy embargo", like the first results do.
  const g = graph([
    ['turn:q1', 'The rollout freeze came up: deploy embargo zanzibar quokka.', '2026-10-01T10:00:00Z', 'ses:a'],
    ['turn:q2', 'Another rollout freeze note, deploy embargo zanzibar quokka.', '2026-10-02T10:00:00Z', 'ses:b'],
    ['turn:gold', 'Decision: the deploy embargo zanzibar quokka holds until the audit ends.', '2026-10-04T10:00:00Z', 'ses:d'],
    // The other question words are known to the store, each in a passage of its own, so no passage covers half of them.
    ...['policy', 'written', 'security', 'council'].map((w, i): N => [`turn:w${i}`, `${filler(i)}. One ${w} mention.`, '2026-10-05T10:00:00Z', `ses:w${i}`]),
  ])
  const q = 'why is there a rollout freeze policy written by the security council'
  g.feedback = false
  assert.equal(g.search(q).good.length, 0, 'without feedback nothing covers half the question')
  g.feedback = true
  const s = g.search(q)
  assert.ok(s.feedback.length > 0 && s.feedback.length <= 5)
  assert.ok(s.good.slice(0, 3).some((h) => h.node.id === 'turn:gold'), s.good.map((h) => h.node.id).join(' '))
  assert.match(c.search(g, q), /also searched \(from the first results\): /)
})

test('R13-B1: the first results share no rare word: nothing is added', () => {
  const g = graph([
    ['turn:a', 'rollout freeze talk about bananas and pears', '2026-10-01T10:00:00Z', 'ses:a'],
    ['turn:b', 'rollout freeze talk about rockets and moons', '2026-10-02T10:00:00Z', 'ses:b'],
    ['turn:c', 'rollout freeze talk about violins and drums', '2026-10-03T10:00:00Z', 'ses:c'],
  ])
  assert.deepEqual(g.search('why is there a rollout freeze policy written by the security council').feedback, [])
})

test('R13-H3: a turn result reads as one unit: what was asked, the match, and how the next turn answered', () => {
  const prompt = 'How should the exporter cut its files?'
  const g = graph([
    ['turn:t1', `${prompt}\n\n${'Some opening words before the answer. '.repeat(30)}The exporter cuts files into eight shards.`, '2026-10-01T10:00:00Z', 'ses:a', prompt],
    ['turn:t2', 'Go ahead.\n\nDone: the exporter now writes eight shard files.', '2026-10-01T10:05:00Z', 'ses:a', 'Go ahead.'],
  ])
  const out = c.search(g, 'exporter eight shards')
  const block = out.split(/\n\n(?=\d+\. )/).find((b) => b.startsWith('1. [turn] turn:t1'))!
  assert.match(block, /asked: How should the exporter cut its files\?/)
  assert.match(block, /same chat, next \(turn:t2\): Done: the exporter now writes eight shard files\./)
  assert.ok(block.length < 700, String(block.length))
})

test('R13-H4: THENWISE_OUTPUT_CHARS=8000 shows five results in full, and the answer stays under the budget', () => {
  const g = graph(Array.from({ length: 12 }, (_, i): N => [`turn:x${i}`, `The exporter shard plan, part ${i}. ${filler(i)}`, `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`, `ses:s${i}`]))
  process.env.THENWISE_OUTPUT_CHARS = '8000'
  try {
    const out = c.search(g, 'exporter shard plan')
    assert.equal(out.match(/^\d+\. \[turn\]/gm)?.length, 5)
    assert.ok(out.length < 8000)
  } finally {
    delete process.env.THENWISE_OUTPUT_CHARS
  }
  assert.equal(c.search(g, 'exporter shard plan').match(/^\d+\. \[turn\]/gm)?.length, 3)
})
