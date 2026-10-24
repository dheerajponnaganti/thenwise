import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { asof, current, excerpt, get, path, search, tried, trace, why } from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex, splitPassages } from '../src/query/passages.ts'

// Synthetic graph only: nothing here comes from a real transcript.
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'memv2-query-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const node = (id: string, kind: string, title: string, text: string, at: string, source = '', extra: object = {}) => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, at, '', 'p', source, JSON.stringify(extra))
  const edge = (src: string, dst: string, kind: string) => db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(src, dst, kind, '', '{}')
  node('note:Shards.md', 'note', 'Cache shards plan', 'Plan: the cache is split into shards. Decision: use eight shards because one big file got slow.', '2026-10-01T10:00:00Z', '/v/Shards.md')
  node('note:Shards2.md', 'note', 'Cache shards plan revised', 'Plan: the cache now uses sixteen shards, replacing the eight shards plan.', '2026-10-10T10:00:00Z', '/v/Shards2.md')
  node('ses:s1', 'session', 'work', 'work', '2026-10-05T09:00:00Z')
  node('turn:t1', 'turn', 'single file cache', 'We tried a single cache file for the storage layer. It failed under load and we reverted it.', '2026-10-05T10:00:00Z', 'ses:s1')
  node('turn:t2', 'turn', 'storage chat', 'The cache file is stored on disk next to the index. Nothing else to report here.', '2026-10-06T10:00:00Z', 'ses:s1')
  node('turn:t3', 'turn', 'ui', 'Because the button was too small we made it larger so that taps land.', '2026-10-07T10:00:00Z', 'ses:s1')
  node('turn:t4', 'turn', 'ui again', 'The button colour is blue and the button label is Save.', '2026-10-07T11:00:00Z', 'ses:s1')
  node('pr:proj#7', 'pr', 'Add cache module', 'Adds the cache module in src/cache.ts', '2026-10-02T00:00:00Z', 'https://example.test/pull/7', { state: 'MERGED', url: 'https://example.test/pull/7' })
  node('commit:proj:abcdef1234567', 'commit', 'Rework cache', 'Reworks the cache module', '2026-10-12T00:00:00Z')
  node('file:/p/src/cache.ts', 'file', 'cache.ts', '', '')
  node('file:/p/hub.ts', 'file', 'hub.ts', '', '')
  node('file:/p/x.ts', 'file', 'x.ts', '', '')
  node('file:/p/y.ts', 'file', 'y.ts', '', '')
  edge('pr:proj#7', 'file:/p/src/cache.ts', 'touches')
  edge('commit:proj:abcdef1234567', 'file:/p/src/cache.ts', 'changed')
  edge('turn:t2', 'pr:proj#7', 'mentions')
  edge('turn:t1', 'ses:s1', 'part_of')
  // A hub: 35 turns read it, so no path may go through it.
  edge('pr:proj#7', 'file:/p/hub.ts', 'touches')
  edge('turn:t4', 'file:/p/hub.ts', 'read')
  edge('turn:t4', 'pr:proj#7', 'mentions')
  for (let i = 0; i < 35; i++) {
    node(`turn:h${i}`, 'turn', `hub ${i}`, `filler ${i}`, '2026-10-08T00:00:00Z', 'ses:s1')
    edge(`turn:h${i}`, 'file:/p/hub.ts', 'read')
  }
  edge('pr:proj#7', 'file:/p/x.ts', 'touches')
  edge('turn:t3', 'file:/p/x.ts', 'edited')
  buildPassageIndex(db)
  db.close()
  return file
}

test('passage splitting keeps a stable size and ids', () => {
  const para = 'This is a sentence about storing data. '.repeat(10).trim()
  const ps = splitPassages(Array(8).fill(para).join('\n\n'))
  assert.ok(ps.length > 2)
  for (const p of ps.slice(0, -1)) assert.ok(p.length >= 600 && p.length <= 900, `length ${p.length}`)
  assert.deepEqual(splitPassages('short'), ['short'])
  assert.ok(splitPassages('word '.repeat(1000)).every((p) => p.length <= 900))
  const g = new Graph(fixture())
  assert.deepEqual(g.passages('turn:t1').map((p) => p.pid), ['turn:t1#p0'])
})

test('stemming: storing, stored and store match', () => {
  const g = new Graph(fixture())
  for (const w of ['storing', 'stored', 'store']) assert.ok(g.search(w).good.some((h) => h.node.id === 'turn:t2'), w)
})

test('RRF ranks a passage found by several lanes above one found by a single lane', () => {
  const g = new Graph(fixture())
  const s = g.search('cache shards plan')
  assert.equal(s.good[0]!.node.kind, 'note')
  assert.ok(s.good[0]!.lanes.includes('bm25') && s.good[0]!.lanes.includes('title'))
  const exact = g.search('PR #7')
  assert.equal(exact.good[0]!.node.id, 'pr:proj#7')
  assert.ok(exact.good[0]!.lanes.includes('exact'))
})

test('asof excludes later nodes and names the replacement', () => {
  const g = new Graph(fixture())
  const early = asof(g, '2026-10-05', 'cache shards plan')
  assert.ok(early.includes('Shards.md') && !early.includes('Shards2.md') && !early.includes('commit:proj'))
  assert.ok(early.includes('later on the same topic'), early)
  const pr = asof(g, '2026-10-03', 'cache module')
  assert.ok(pr.includes('later on the same file') && pr.includes('abcdef1'), pr)
})

test('path explains each hop in words and avoids hubs', () => {
  const g = new Graph(fixture())
  const out = path(g, 'turn:t3', 'turn:t4')
  assert.ok(!out.includes('hub.ts'), out)
  assert.ok(out.includes('edited') && out.includes('PR #7') && out.includes('touches'), out)
  assert.ok(path(g, 'turn:h1', 'turn:h2').includes('no connection'))
})

test('why and tried rank passages with markers first, and keep the plain ones below', () => {
  const g = new Graph(fixture())
  const first = (s: string) => /1\. \[\w+\] (\S+)/.exec(s)?.[1]
  assert.equal(first(why(g, 'button')), 'turn:t3')
  assert.ok(why(g, 'button').indexOf('turn:t3') < why(g, 'button').indexOf('turn:t4'))
  assert.equal(first(tried(g, 'cache file')), 'turn:t1')
})

test('not recorded when nothing matches, with a warning on the closest items', () => {
  const g = new Graph(fixture())
  assert.match(search(g, 'quantum pizza'), /^not recorded/)
  const weak = search(g, 'cache pizza spaceship harpoon')
  assert.ok(!weak.startsWith('not recorded') || weak.includes('WARNING'))
  // A topic with no stated reason still returns its passages; the markers count says none states one.
  assert.match(why(g, 'sixteen shards'), /markers: 0/)
})

test('trace groups by date, newest first; get returns the full text', () => {
  const g = new Graph(fixture())
  const t = trace(g, 'src/cache.ts')
  assert.ok(t.indexOf('== 2026-10-12 ==') < t.indexOf('== 2026-10-02 =='), t)
  assert.ok(get(g, 'turn:t1').includes('reverted it'))
  assert.ok(get(g, 'turn:t1#p0').includes('reverted it'))
})

test('the same db gives byte-identical output', () => {
  const f = fixture()
  const run = () => { const g = new Graph(f); return [search(g, 'cache shards'), why(g, 'button'), trace(g, 'PR #7'), asof(g, '2026-10-06', 'cache'), path(g, 'turn:t3', 'turn:t4')].join('\n---\n') }
  assert.equal(run(), run())
})

test('dates are shown and read in the owner time zone', async () => {
  const { endOf, local } = await import('../src/query/engine.ts')
  process.env.MEMORY_TZ = 'Asia/Kolkata'
  // engine reads MEMORY_TZ at load; this checks the formatting rule with the zone the test process has.
  assert.match(local('2026-10-13T18:40:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/)
  assert.equal(local('2026-10-23'), '2026-10-23')
  assert.ok(Date.parse(endOf('2026-10-13')) > Date.parse('2026-10-13T00:00:00Z'))
})

test('current puts the final and newer record first and flags newer records in search', () => {
  const g = new Graph(fixture())
  const first = (s: string) => /1\. \[\w+\] (\S+)/.exec(s)?.[1]
  // The revised plan (newer note) beats the older plan for what holds now.
  assert.equal(first(current(g, 'cache shards plan')), 'note:Shards2.md')
  // A commit outranks older chat about the same thing.
  const c = current(g, 'cache module')
  assert.ok(c.indexOf('commit:proj:abcdef1234567') < c.indexOf('turn:t2') || c.indexOf('turn:t2') < 0)
  // Plain search still ranks by relevance, but says a newer record exists.
  assert.match(search(g, 'eight shards plan'), /NEWER on this topic: note note:Shards2\.md/)
})

test('results show the words around the match, and asof names the commit to read files at', () => {
  const long = `${'filler words here. '.repeat(40)}the **cache** answer sits here${' and more filler.'.repeat(40)}`
  const cut = excerpt(long, 200)
  assert.ok(cut.length <= 210 && cut.includes('**cache** answer') && cut.startsWith('... ') && cut.endsWith(' ...'), cut)
  assert.equal(excerpt('short text', 200), 'short text')
  const g = new Graph(fixture())
  assert.match(asof(g, '2026-10-13', 'cache module'), /show abcdef1:<path>/)
  assert.doesNotMatch(asof(g, '2026-10-05', 'cache shards plan'), /show abcdef1/)
})
