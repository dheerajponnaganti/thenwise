import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { excerpt, get, search } from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex, splitPassages } from '../src/query/passages.ts'

type N = [id: string, text: string, at: string, source?: string, extra?: object, title?: string]
function store(nodes: N[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'tw-retr-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  for (const [id, text, at, source = 'ses:a', extra = {}, title = 'chat'] of nodes) db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'turn', title, text, at, '', 'p', source, JSON.stringify(extra))
  buildPassageIndex(db)
  db.close()
  return new Graph(file)
}

test('excerpt picks distinct rare terms over a repeated common word', () => {
  const table = '**MB** row. '.repeat(30)
  const text = `${table}${'filler words go here. '.repeat(10)}The sizes were **593** and **317** for the **Android** build. ${table}`
  const idf = (w: string) => (w === 'mb' ? 0.1 : 3)
  const cut = excerpt(text, 200, [], idf)
  assert.ok(cut.includes('**593** and **317**'), cut)
})

test('subagent briefs rank below real answers and near-duplicates take one slot', () => {
  const brief = 'Read-only audit of the quartz widget cache folder logic. Report findings.'
  const g = store([
    ['turn:b1', brief, '2026-10-01T10:00:00Z', 'ses:a', { subagent: true }, brief],
    ['turn:b2', `${brief} `, '2026-10-01T10:01:00Z', 'ses:a', { subagent: true }, brief],
    ['turn:real', 'The quartz widget cache folder logic reads the old path because the migration never ran.', '2026-10-02T10:00:00Z', 'ses:b'],
  ])
  const ids = g.search('quartz widget cache folder logic').hits.map((h) => h.node.id)
  assert.equal(ids[0], 'turn:real')
  assert.equal(ids.filter((i) => i.startsWith('turn:b')).length, 1)
})

test('coverage counts a query word found in the neighbouring turn at half weight', () => {
  const g = store([
    ['turn:c1', 'We pushed the repo and opened the project page.', '2026-10-01T10:00:00Z', 'ses:a'],
    ['turn:c2', 'The first workflow run failed on lint.', '2026-10-01T10:05:00Z', 'ses:a'],
    ['turn:c3', 'Unrelated chat about lunch.', '2026-10-01T10:10:00Z', 'ses:a'],
  ])
  const h = g.search('repo workflow run failed lint').hits.find((x) => x.node.id === 'turn:c2')!
  const alone = store([['turn:c1', 'We pushed the repo and opened the project page.', '2026-10-01T10:00:00Z', 'ses:z'], ['turn:c2', 'The first workflow run failed on lint.', '2026-10-01T10:05:00Z', 'ses:a'], ['turn:c3', 'Unrelated chat about lunch.', '2026-10-01T10:10:00Z', 'ses:a']]).search('repo workflow run failed lint').hits.find((x) => x.node.id === 'turn:c2')!
  assert.ok(h.cov > alone.cov, `${h.cov} vs ${alone.cov}`)
})

test('splitPassages leaves no stub before a long unit', () => {
  const stub = 'Short stub line of about two hundred characters. '.repeat(4).trim()
  const long = 'A long sentence that fills most of a passage. '.repeat(17).trim()
  const ps = splitPassages(`${long}\n\n${stub}\n\n${long}`)
  assert.ok(ps.every((p) => p.length >= 200), ps.map((p) => p.length).join(','))
})

test('get prints a whole short node when given a passage id', () => {
  const text = `${'First part of the story. '.repeat(45)}\n\nThe reason sits in the second part.`
  const g = store([['turn:long', text, '2026-10-01T10:00:00Z']])
  assert.ok(g.passages('turn:long').length > 1)
  assert.match(get(g, 'turn:long#p0'), /reason sits in the second part/)
})

test('NEWER skips a sibling within 30 minutes and shows what the newer record says', () => {
  const g = store([
    ['turn:s1', 'The mango cache decision was eight shards.', '2026-10-01T10:00:00Z', 'ses:a'],
    ['turn:s2', 'The mango cache decision was eight shards, same brief.', '2026-10-01T10:10:00Z', 'ses:a'],
    ['turn:later', 'Mango cache decision changed: sixteen shards now.', '2026-10-05T10:00:00Z', 'ses:z'],
  ])
  const out = search(g, 'mango cache decision shards')
  assert.doesNotMatch(out, /NEWER on this topic[^:]*: turn turn:s2/)
  assert.match(out, /NEWER on this topic \(shares the words [^)]+\): turn turn:later[^\n]*\n\s+newer says: .*sixteen shards/)
})

test('a stub just over a third of the minimum still joins the next unit', () => {
  const stub = 'Short stub line of about two hundred characters. '.repeat(5).trim()
  const long = 'A long sentence that fills most of a passage. '.repeat(17).trim()
  const ps = splitPassages(`${long}\n\n${stub}\n\n${long}`)
  assert.ok(ps.every((p) => p.length >= 300), ps.map((p) => p.length).join(','))
})


test('search shows the top 3 with the next turn of their chat, then one-liners, under the tool output cap', () => {
  const g = store(Array.from({ length: 20 }, (_, i): N => [`turn:q${String(i).padStart(2, '0')}`, `${i % 2 ? 'The quartz widget cache came up again in this step.' : 'Unrelated talk about lunch plans.'} ${Array.from({ length: 40 }, (_, k) => `w${i}x${k}`).join(' ')}`, `2026-10-0${1 + (i % 9)}T1${i % 10}:00:00Z`, `ses:${i % 3}`]))
  const out = search(g, 'quartz widget cache')
  assert.match(out, /same chat, next \(turn:q\d+\)/)
  assert.match(out, /more matches \(get <id> prints one\):\n4\. turn:q\d+ \S+ project: p \| /)
  assert.ok(out.length <= 4000, String(out.length))
})

test('a search whose results hold markdown bold with quotes or dots does not break the excerpt', () => {
  const text = `**Why that number:** the release was **"0.1.2"**, not **0.2.0.** ${'Plan history version push notes. '.repeat(20)}`
  const g = store([['turn:md', text, '2026-10-01T10:00:00Z'], ['turn:other', 'Unrelated words only here.', '2026-10-02T10:00:00Z']])
  assert.doesNotThrow(() => search(g, 'version push'))
  assert.match(search(g, 'version push'), /turn:md/)
})
