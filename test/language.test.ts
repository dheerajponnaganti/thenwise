import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'
import { search } from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildLanguage } from '../src/query/language.ts'
import { buildPassageIndex } from '../src/query/passages.ts'

// Synthetic only. Six notes are titled with the same four words, so those words co-occur far above chance.
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'memv2-lang-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const node = (id: string, kind: string, title: string, text: string, extra: object = {}) => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, '2026-10-01T10:00:00Z', '', 'p', '', JSON.stringify(extra))
  for (let i = 0; i < 6; i++) node(`note:S${i}.md`, 'note', `Shards partition replica quorum design ${i}`, `Design ${i} covers shards, partition, replica and quorum.`)
  for (let i = 0; i < 60; i++) node(`note:F${i}.md`, 'note', `Filler${i}x subject${i}y`, `Unrelated text number ${i}.`)
  node('note:Layout.md', 'note', 'Layout memo', 'The partition scheme is documented here and nowhere else.')
  node('note:Backup.md', 'note', 'Nightly archive job', 'Runs at two in the morning.', { answers: ['How do I preserve my records every evening?'], aliases: ['cold storage'] })
  buildPassageIndex(db)
  buildLanguage(db)
  db.close()

  return file
}

test('mining: co-occurring title words become synonyms, filler does not', () => {
  const db = new DatabaseSync(fixture(), { readOnly: true })
  const syn = (w: string) => (db.prepare('SELECT syn FROM synonyms WHERE word = ? ORDER BY syn').all(w) as any[]).map((r) => r.syn)
  assert.deepEqual(syn('shards'), ['design', 'partition', 'quorum', 'replica'])
  assert.deepEqual(syn('filler1x'), [])
  assert.ok((db.prepare("SELECT count(*) n FROM vocab WHERE word = 'partition'").get() as any).n === 1)
})

test('expansion is off by default; --expand shows it, bounded to two words', () => {
  const g = new Graph(fixture())
  assert.doesNotMatch(search(g, 'shards scheme'), /also searched/)
  g.expand = true
  const s = g.search('shards scheme')
  assert.equal(s.expanded.length, 1)
  assert.deepEqual(s.expanded[0], { from: 'shards', to: ['design', 'partition'] }) // four exist, two are used
  const out = search(g, 'shards scheme')
  assert.match(out, /also searched: design, partition \(for shards\)/)
  assert.ok(s.good.some((h) => h.node.id === 'note:Layout.md'), 'the reworded note is found through the synonym')
})

test('typo: a word found nowhere is replaced by the closest vocabulary word', () => {
  const g = new Graph(fixture())
  const s = g.search('partiton')
  assert.deepEqual(s.fixed, [{ from: 'partiton', to: 'partition' }])
  assert.deepEqual(s.missing, [])
  assert.match(search(g, 'partiton'), /did you mean: partition \(for partiton\)/)
  assert.deepEqual(g.search('zzqqxx').fixed, []) // nothing close enough
})

test('answers and aliases find a note by a reworded question', () => {
  const g = new Graph(fixture())
  assert.equal(g.search('preserve records evening').good[0]?.node.id, 'note:Backup.md')
  assert.equal(g.search('cold storage').good[0]?.node.id, 'note:Backup.md')
  assert.ok(g.search('preserve records evening').hits[0]!.lanes.includes('title'))
})

test('ingest reads answers and aliases from front matter', () => {
  const home = mkdtempSync(join(tmpdir(), 'memv2-lang-ing-'))
  const vault = join(home, 'vault')
  mkdirSync(vault, { recursive: true })
  mkdirSync(join(home, '.memory'), { recursive: true })
  writeFileSync(join(vault, 'Backup.md'), '---\nanswers:\n  - How do I preserve my records?\naliases: [cold storage]\n---\n# Nightly job\nRuns at two.\n')
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: [], repos: [], github_repos: [], vaults: [vault] } }))
  const r = ingest(loadConfig(home), { prs: undefined })
  const g = new Graph(r.db)
  assert.deepEqual(g.nodes.get('note:Backup.md')!.extra, { answers: ['How do I preserve my records?'], aliases: ['cold storage'], edited: g.nodes.get('note:Backup.md')!.extra.edited })
  assert.equal(g.search('preserve records').good[0]?.node.id, 'note:Backup.md')
})
