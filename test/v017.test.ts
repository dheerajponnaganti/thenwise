import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { docFiles, docsPart, skippedDocs } from '../src/ingest/parts.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex } from '../src/query/passages.ts'
import { World } from './world.ts'

type N = { id: string; kind?: string; title?: string; text: string; at: string; source?: string; extra?: object }
function graph(nodes: N[], edges: [string, string, string][] = []) {
  const file = join(mkdtempSync(join(tmpdir(), 'tw-017-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  for (const n of nodes) db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(n.id, n.kind ?? 'turn', n.title ?? n.text.slice(0, 40), n.text, n.at, '', 'p', n.source ?? 'ses:a', JSON.stringify(n.extra ?? {}))
  for (const [src, dst, kind] of edges) db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(src, dst, kind, '', '{}')
  buildPassageIndex(db)
  db.close()

  return new Graph(file)
}
const first = (s: string) => /1\. \[\w+\] (\S+)/.exec(s)?.[1]
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-03T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-03T10:00:00Z' } })

test('R7-H1: a CLAUDE.md is one record per heading section, dated by its last commit, each with a passage', () => {
  const w = new World()
  try {
    writeFileSync(join(w.proj, 'CLAUDE.md'), '# Style\nShort sentences only.\n\n## Commits\nOne commit per chunk of work.\n```\n# not a heading\n```\n\n## Tests\nRun the unit tests before a push.\n')
    git(w.proj, 'add', 'CLAUDE.md')
    git(w.proj, 'commit', '-q', '-m', 'Add rules')
    const docs = docsPart(w.cfg).nodes.filter((n) => n.source === join(w.proj, 'CLAUDE.md'))
    assert.deepEqual(docs.map((n) => n.title), ['Style', 'Commits', 'Tests'])
    assert.ok(docs.every((n) => Date.parse(n.at) === Date.parse('2026-10-03T10:00:00Z') && n.extra.dateFrom === 'git'))
    assert.match(docs[1]!.text, /# not a heading/) // a fenced line is text, not a heading
    w.archive()
    w.ingest('g.db')
    const db = new DatabaseSync(w.path('g.db'), { readOnly: true })
    assert.equal(db.prepare("SELECT count(DISTINCT node) n FROM passages WHERE node LIKE 'doc:%CLAUDE.md#%'").get()!.n, 3)
    assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'rule'").get()!.n, 0)
    db.close()
  } finally {
    w.destroy()
  }
})

test('R7-B1: a CLAUDE.md two folders below a root is not read, and is listed as skipped', () => {
  const w = new World()
  try {
    for (const d of ['one', 'deep/er']) mkdirSync(join(w.proj, d), { recursive: true })
    writeFileSync(join(w.proj, 'one', 'CLAUDE.md'), '# One\nRead this one below the root.\n')
    writeFileSync(join(w.proj, 'deep', 'er', 'CLAUDE.md'), '# Deep\nA third-party checkout, not read.\n')
    const read = docFiles(w.cfg)
    assert.ok(read.includes(join(w.proj, 'one', 'CLAUDE.md')))
    assert.ok(!read.includes(join(w.proj, 'deep', 'er', 'CLAUDE.md')))
    assert.deepEqual(skippedDocs(w.cfg), [join(w.proj, 'deep', 'er', 'CLAUDE.md')])
    w.cfg.docs = [join(w.proj, 'deep', 'er')]
    assert.ok(docFiles(w.cfg).includes(join(w.proj, 'deep', 'er', 'CLAUDE.md')))
  } finally {
    w.destroy()
  }
})

test('R7-H2: current puts a merged PR from last week above a CLAUDE.md section saved today', () => {
  const g = graph([
    { id: 'pr:p#1', kind: 'pr', title: 'Move the deploy region to eu-west', text: 'The deploy region setting now lives in config and is eu-west.', at: '2026-10-19T10:00:00Z', source: 'https://x/pull/1', extra: { state: 'MERGED' } },
    { id: 'doc:/x/CLAUDE.md#0', kind: 'doc', title: 'Deploy', text: 'The deploy region setting is read from config.', at: '2026-10-26T10:00:00Z', source: '/x/CLAUDE.md', extra: { dateFrom: 'mtime' } },
  ])
  assert.equal(first(c.current(g, 'deploy region setting')), 'pr:p#1')
})

test('R7-H3: naming a file ranks its records by relevance, found by the graph lane', () => {
  const nodes: N[] = [{ id: 'turn:best', text: 'README.md explains the marketplace step because the plugin install needs it first.', at: '2026-10-01T10:00:00Z' }, { id: 'file:/x/p/README.md', kind: 'file', title: 'README.md', text: '', at: '' }]
  const edges: [string, string, string][] = [['turn:best', 'file:/x/p/README.md', 'read']]
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `commit:p:${i}abc1234`, kind: 'commit', title: `Update README wording ${i}`, text: `Update README wording ${i}`, at: `2026-10-1${i}T10:00:00Z`, source: '/x/p' })
    edges.push([`commit:p:${i}abc1234`, 'file:/x/p/README.md', 'changed'])
  }
  const s = c.rank(graph(nodes, edges), 'why', 'why does README.md explain the marketplace step')
  assert.equal(s.items[0]!.h.node.id, 'turn:best')
  for (const x of s.items.filter((x) => x.h.node.kind === 'commit')) assert.ok(!x.h.lanes.includes('exact'), x.h.node.id)
})

test('R7-H4 R7-B3: one NEWER line per answer, with its reason; later records that only share the query words get none', () => {
  const filler = (topic: string) => `${topic} ${'The rest of this long passage talks about unrelated build and release chores in detail. '.repeat(6)}`
  const g = graph([
    { id: 'turn:a1', text: filler('Quokka cache uses eight shards for the exporter.'), at: '2026-10-01T10:00:00Z', source: 'ses:a' },
    { id: 'turn:b1', text: filler('Quokka cache exporter now uses sixteen shards instead of eight.'), at: '2026-10-09T10:00:00Z', source: 'ses:b' },
    { id: 'turn:a2', text: filler('Quokka cache warmup reads the manifest first.'), at: '2026-10-02T10:00:00Z', source: 'ses:c' },
    { id: 'turn:b2', text: filler('Quokka cache warmup now skips the manifest when it is fresh.'), at: '2026-10-10T10:00:00Z', source: 'ses:d' },
  ])
  const out = c.search(g, 'quokka cache shards')
  assert.equal((out.match(/NEWER on this topic/g) ?? []).length, 1)
  assert.match(out, /NEWER on this topic \(shares the words [^)]+\)/)
  const g2 = graph([
    { id: 'note:gw', kind: 'note', title: 'Gateway', text: 'Zebra cache plan for the API gateway: a small in-memory map, cleared on deploy, owned by the platform team.', at: '2026-10-01T10:00:00Z', source: '/v/gw.md' },
    { id: 'note:img', kind: 'note', title: 'Images', text: 'Zebra cache plan for mobile thumbnails: a disk LRU on the phone, sized by free storage, owned by the apps team.', at: '2026-10-09T10:00:00Z', source: '/v/img.md' },
  ])
  assert.doesNotMatch(c.search(g2, 'zebra cache plan'), /NEWER on this topic/)
})

test('R7-H5 R7-H6: asof lists the best match first, names the newest, and follows a turn to its commit', () => {
  const g = graph(
    [
      { id: 'turn:apr', title: 'Poll interval value', text: 'The poll interval value is 30 seconds for the sync worker.', at: '2026-04-10T10:00:00Z', source: 'ses:a' },
      // Later and on topic, but it only asks: sorting the matches newest first used to put it on top.
      { id: 'turn:jun', title: 'dashboard chat', text: 'Someone asked again what the poll interval value should be for the dashboard; nobody answered.', at: '2026-06-10T10:00:00Z', source: 'ses:b' },
      { id: 'commit:p:fff1234', kind: 'commit', title: 'Set poll interval to 30 seconds', text: 'Set poll interval to 30 seconds', at: '2026-04-11T10:00:00Z', source: '/x/p' },
    ],
    [['turn:apr', 'commit:p:fff1234', 'made']],
  )
  const out = c.asof(g, '2026-07-01', 'poll interval value')
  assert.equal(first(out), 'turn:apr')
  assert.match(out, /newest among the matches: turn on 2026-06-10/)
  assert.match(out, /later on a commit made from it: commit fff1234/)
})
