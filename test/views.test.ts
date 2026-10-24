import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'
import { buildPassageIndex } from '../src/query/passages.ts'
import { writeViews } from '../src/views/views.ts'

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'memv2-views-')), 'g.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const node = (id: string, kind: string, title: string, text: string, at: string, project = 'proj', source = '', extra: object = {}) => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, at, '', project, source, JSON.stringify(extra))
  const edge = (src: string, dst: string, kind: string) => db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(src, dst, kind, '', '{}')
  node('pr:proj#7', 'pr', 'Add cache', 'Adds the cache. '.repeat(40), '2026-10-02T00:00:00Z', 'proj', 'https://example.test/pull/7', { state: 'MERGED', url: 'https://example.test/pull/7' })
  node('commit:proj:abcdef1234567', 'commit', 'Rework cache', 'Body', '2026-10-12T00:00:00Z', 'proj', '', { trailers: { decision: ['keep eight shards'] } })
  node('commit:proj:1111111aaaaaaa', 'commit', 'Tidy', '', '2026-10-13T00:00:00Z')
  node('ses:s1', 'session', 'Start the cache work', 'Start the cache work', '2026-10-05T09:00:00Z', 'key', 'key/s1', { cwd: '/home/proj' })
  node('turn:t1', 'turn', 'Start the cache work', 'Start the cache work', '2026-10-05T09:01:00Z', 'key', 'ses:s1')
  node('sum:m1', 'summary', 'Compaction summary of s1', 'We were building the cache.', '2026-10-06T00:00:00Z', 'key', 'ses:s1')
  node('file:/home/proj/src/cache.ts', 'file', 'cache.ts', '', '', '', '', { aliases: ['src/cache.ts'] })
  node('file:/home/proj/src/lonely.ts', 'file', 'lonely.ts', '', '', '', '', { aliases: ['src/lonely.ts'] })
  edge('turn:t1', 'ses:s1', 'part_of')
  edge('turn:t1', 'commit:proj:abcdef1234567', 'made')
  edge('turn:t1', 'file:/home/proj/src/cache.ts', 'edited')
  edge('pr:proj#7', 'file:/home/proj/src/cache.ts', 'touches')
  edge('commit:proj:abcdef1234567', 'file:/home/proj/src/cache.ts', 'changed')
  edge('commit:proj:1111111aaaaaaa', 'file:/home/proj/src/lonely.ts', 'changed')
  buildPassageIndex(db)
  db.close()

  return file
}
const tree = (d: string): Record<string, string> => Object.fromEntries(readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), 'utf8')]))

test('a fixture graph gives the expected files, a second run changes nothing, stale files go', () => {
  const db = fixture()
  const vault = mkdtempSync(join(tmpdir(), 'memv2-vault-'))
  const gen = join(vault, 'Memory v2/Generated')
  mkdirSync(join(gen, 'Files'), { recursive: true })
  writeFileSync(join(gen, 'Files/old.md'), '---\ngenerated: true\n---\nstale')
  writeFileSync(join(gen, 'Files/mine.md'), 'written by the owner, no marker')
  writeFileSync(join(vault, 'Keep.md'), 'outside the folder')
  const a = writeViews(db, vault, { builtAt: '2026-10-20T00:00:00Z' })
  assert.deepEqual(a.files, ['Files/src-cache-ts.md', 'Files/src-lonely-ts.md', 'Index.md', 'Timelines/proj.md'])
  assert.equal(a.removed, 1)
  const files = tree(gen)
  assert.deepEqual(Object.keys(files).map((p) => p.slice(gen.length + 1)).sort(), ['Files/mine.md', 'Files/src-cache-ts.md', 'Files/src-lonely-ts.md', 'Index.md', 'Timelines/proj.md'])
  assert.equal(readFileSync(join(vault, 'Keep.md'), 'utf8'), 'outside the folder')
  for (const [p, t] of Object.entries(files)) if (!p.endsWith('mine.md')) assert.match(t, /^---\ngenerated: true\n---\n\n> Generated and rebuilt by `memory views`.*Do not edit/)
  const tl = files[join(gen, 'Timelines/proj.md')]!
  const order = ['PR #7', 'session began', 'compaction summary', 'decision: keep eight shards']
  assert.deepEqual(order.map((o) => tl.indexOf(o)).slice().sort((x, y) => x - y), order.map((o) => tl.indexOf(o)))
  assert.match(tl, /\[PR #7\]\(https:\/\/example\.test\/pull\/7\)/)
  assert.doesNotMatch(tl, /Tidy/) // a commit without a decision is not a timeline line
  const f = files[join(gen, 'Files/src-cache-ts.md')]!
  assert.ok(f.indexOf('commit') < f.indexOf('session'), 'newest first')
  assert.ok(f.split('\n').every((l) => l.length < 420), 'passages are trimmed')
  assert.match(files[join(gen, 'Index.md')]!, /Built from the graph of 2026-10-20/)
  const before = statSync(join(gen, 'Index.md')).mtimeMs
  const b = writeViews(db, vault, { builtAt: '2026-10-20T00:00:00Z' })
  assert.equal(b.written, 0)
  assert.equal(b.removed, 0)
  assert.deepEqual(tree(gen), files)
  assert.equal(statSync(join(gen, 'Index.md')).mtimeMs, before)
})

test('ingest skips the Generated folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'memv2-views-ing-'))
  const vault = join(home, 'vault')
  mkdirSync(join(vault, 'Memory v2/Generated'), { recursive: true })
  mkdirSync(join(home, '.memory'), { recursive: true })
  writeFileSync(join(vault, 'Real.md'), '# Real\nbody\n')
  writeFileSync(join(vault, 'Memory v2/Generated/Index.md'), '---\ngenerated: true\n---\n# Index\nown output\n')
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: [], repos: [], github_repos: [], vaults: [vault] } }))
  const db = new DatabaseSync(ingest(loadConfig(home)).db, { readOnly: true })
  assert.deepEqual((db.prepare("SELECT id FROM nodes WHERE kind = 'note'").all() as any[]).map((r) => r.id), ['note:Real.md'])
})

test('a chat run from the home folder belongs to the project folder it worked in', async () => {
  const { folderOf } = await import('../src/views/views.ts')
  assert.equal(folderOf('file:/Users/x/carapace-film/src/Film.tsx'), 'carapace-film')
  assert.equal(folderOf('file:/Users/x/.claude/settings.json'), undefined)
})

test('a configured project claims a chat by the words of its first prompt', async () => {
  const { loadConfig } = await import('../src/ingest/config.ts')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'memv2-cfg-'))
  mkdirSync(join(home, '.memory'))
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ views: { projects: { 'launch film': { words: ['Product Demo'], paths: ['~/film'] } } } }))
  const cfg = loadConfig(home)
  assert.deepEqual(cfg.viewProjects, [{ name: 'launch film', words: ['product demo'], paths: [join(home, 'film')] }])
})
