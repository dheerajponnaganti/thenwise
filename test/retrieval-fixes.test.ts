import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { excerpt, get, search } from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex, splitPassages } from '../src/query/passages.ts'

type N = [id: string, text: string, at: string, source?: string, extra?: object, title?: string, kind?: string]
function store(nodes: N[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'tw-retr-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  for (const [id, text, at, source = 'ses:a', extra = {}, title = 'chat', kind = 'turn'] of nodes) db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, at, '', 'p', source, JSON.stringify(extra))
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

test('NEWER skips a sibling within 30 minutes and is one short line with its reason', () => {
  const t = 'Mango cache decision'
  const g = store([
    ['turn:s1', 'The mango cache decision was eight shards.', '2026-10-01T10:00:00Z', 'ses:a', {}, t],
    ['turn:s2', 'The mango cache decision was eight shards, same brief.', '2026-10-01T10:10:00Z', 'ses:a', {}, t],
    ['turn:later', 'Mango cache decision changed: sixteen shards now.', '2026-10-05T10:00:00Z', 'ses:z', {}, t],
  ])
  const out = search(g, 'mango cache decision shards')
  assert.doesNotMatch(out, /NEWER: turn:s2/)
  assert.match(out, /^ {3}NEWER: turn:later \(2026-10-0\d\), same title\. Read it before saying what holds now\.$/m)
  assert.doesNotMatch(out, /newer says/)
})

test('a stub just over a third of the minimum still joins the next unit', () => {
  const stub = 'Short stub line of about two hundred characters. '.repeat(5).trim()
  const long = 'A long sentence that fills most of a passage. '.repeat(17).trim()
  const ps = splitPassages(`${long}\n\n${stub}\n\n${long}`)
  assert.ok(ps.every((p) => p.length >= 300), ps.map((p) => p.length).join(','))
})


test('search shows the top 3 with the next turn of their chat, then one-liners, under the tool output cap', () => {
  const g = store(Array.from({ length: 20 }, (_, i): N => [`turn:q${String(i).padStart(2, '0')}`, `${i % 2 ? 'The quartz widget cache came up again in this step.' : 'Unrelated talk about lunch plans.'}\n\n${Array.from({ length: 40 }, (_, k) => `w${i}x${k}`).join(' ')}`, `2026-10-0${1 + (i % 9)}T1${i % 10}:00:00Z`, `ses:${i % 3}`]))
  const out = search(g, 'quartz widget cache')
  assert.match(out, /same chat, next \(turn:q\d+\)/)
  assert.match(out, /more matches:\n4\. turn:q\d+ \S+ · p \| /)
  assert.match(out, /memory_read <id> prints one in full/)
  assert.doesNotMatch(out, /\bget <id>/, 'an agent reads tool names, not CLI verbs')
  assert.ok(out.length <= 4000, String(out.length))
  process.env.THENWISE_CLI_VERBS = '1'
  try {
    assert.match(search(g, 'quartz widget cache'), /; get <id> prints one in full/, 'the CLI names its own commands')
  } finally {
    delete process.env.THENWISE_CLI_VERBS
  }
})

test('a search whose results hold markdown bold with quotes or dots does not break the excerpt', () => {
  const text = `**Why that number:** the release was **"0.1.2"**, not **0.2.0.** ${'Plan history version push notes. '.repeat(20)}`
  const g = store([['turn:md', text, '2026-10-01T10:00:00Z'], ['turn:other', 'Unrelated words only here.', '2026-10-02T10:00:00Z']])
  assert.doesNotThrow(() => search(g, 'version push'))
  assert.match(search(g, 'version push'), /turn:md/)
})

const filler = (n: number): N[] => Array.from({ length: n }, (_, i): N => [`turn:f${i}`, `Plain notes about the cache and its settings, round ${i}, with words of their own: f${i}a f${i}b.`, '2026-10-01T09:00:00Z', `ses:f${i % 5}`])

test('a search says when no shown passage holds all its rare words, and not when one does', () => {
  const apart = store([...filler(80), ['turn:z', 'The zephyr cache notes were written down.', '2026-10-02T10:00:00Z'], ['turn:m', 'The marmot cache notes were written down.', '2026-10-02T11:00:00Z']])
  assert.match(search(apart, 'zephyr marmot cache notes'), /^no shown passage has all of: (zephyr, marmot|marmot, zephyr) \(the closest lacks \w+\)$/m)
  const together = store([...filler(80), ['turn:zm', 'The zephyr and marmot cache notes were written down.', '2026-10-02T10:00:00Z'], ['turn:m', 'The marmot cache notes were written down.', '2026-10-02T11:00:00Z']])
  assert.doesNotMatch(search(together, 'zephyr marmot cache notes'), /no shown passage/)
})

test('a passage of only what the person typed is labelled [prompt] and weighs less in tried', async () => {
  const { tried } = await import('../src/query/commands.ts')
  const prompt = `We tried the zinc cache and it failed. ${'Context the person pasted about the zinc cache layout and the shards. '.repeat(9)}`
  const g = store([
    ['turn:ask', `${prompt}\n\n${'I will look at the layout first, then the shard count and the lock files. '.repeat(4)}`, '2026-10-02T10:00:00Z', 'ses:a', { promptLen: prompt.length }],
    ['turn:ans', `Can you check it?\n\nWe tried the zinc cache and it failed. ${'The answer explains the zinc cache layout and the shards it used. '.repeat(9)}`, '2026-10-02T11:00:00Z', 'ses:b', { promptLen: 17 }],
  ])
  const out = tried(g, 'tried zinc cache failed')
  assert.match(out, /\[prompt\] turn:ask\n/)
  assert.ok(out.indexOf('turn:ans') < out.indexOf('turn:ask'), out)
  assert.doesNotMatch(search(g, 'zinc cache shards'), /\[prompt\] turn:ans/)
})

test('one-line results whose titles differ only in numbers fold into the first', () => {
  const g = store([
    ...Array.from({ length: 3 }, (_, i): N => [`turn:top${i}`, `The quokka release process step ${i}.`, `2026-10-0${i + 1}T10:00:00Z`, `ses:t${i}`]),
    ...Array.from({ length: 7 }, (_, i): N => [`pr:o/r#${i + 3}`, `Quokka release notes for this one.`, `2026-10-1${i}T10:00:00Z`, `o/r`, {}, `Release v0.1.${i + 3}`, 'pr']),
    ...Array.from({ length: 3 }, (_, i): N => [`turn:same${i}`, `The quokka release came up again, part ${i}.`, `2026-09-0${i + 1}T10:00:00Z`, `ses:s${i}`, {}, 'continue']),
  ])
  const out = search(g, 'quokka release')
  const lines = out.split('more matches:\n')[1]!.split('\n')
  assert.equal(lines.filter((l) => / pr:o\/r#\d+ /.test(l)).length, 1, out)
  assert.match(out, /\(\+\d more titled like it: pr:o\/r#\d+(, pr:o\/r#\d+)+\)/)
  assert.equal(lines.filter((l) => / turn:same\d /.test(l)).length, 3, 'turns with one title are different work and never fold')
})

test('a hit on a title line alone shows the start of the text under it', () => {
  const g = store([['turn:c', 'The shards now number eight because one file locked up under load.', '2026-10-02T10:00:00Z', 'ses:a', {}, 'Zinc cache split']])
  assert.match(search(g, 'zinc'), /\| \*\*Zinc\*\* cache split\n {3}\| The shards now number eight because one file locked up under load\./)
})

test('a result line is date, project and source, with no passage or lane fields', () => {
  const g = store([['turn:x', 'Quartz cache moved to eight shards because the single file locked.', '2026-10-02T10:00:00Z', 'ses:1234567890']])
  const out = search(g, 'quartz shards')
  assert.match(out, /^1\. \[turn\] turn:x\n {3}\d{4}-10-0\d \d\d:\d\d · p · chat ses:12345678\n/m)
  assert.doesNotMatch(out, /found by:|passage: p|source:/)
})
