// The hook fast path (Graph with lazy: true) must print exactly what the full in-memory graph prints.
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { asof, current, get, path, resume, search, trace, tried, why } from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { buildPassageIndex } from '../src/query/passages.ts'
import { tempDir } from './mcp-fixture.ts'

test('fast path prints the same file history and resume brief as the full graph', () => {
  const dir = tempDir()
  const mk = (n: string) => (mkdirSync(join(dir, n, '.git'), { recursive: true }), realpathSync(join(dir, n)).replace(/\\/g, '/'))
  const a = mk('alpha')
  const b = mk('beta')
  mkdirSync(join(a, 'My Docs'), { recursive: true })
  const odd = `${a}/My Docs/notes [v2] (1).md`
  const file = join(dir, 'graph.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const node = (id: string, kind: string, title: string, text: string, at: string, source = '', extra: object = {}, project = 'alpha') => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, at, '', project, source, JSON.stringify(extra))
  const edge = (s: string, d: string, k: string) => db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(s, d, k, '', '{}')
  for (const r of [a, b]) node(`file:${r}/README.md`, 'file', 'README.md', '', '')
  node(`file:${odd}`, 'file', 'notes [v2] (1).md', '', '')
  node(`file:${a}/src/hub.ts`, 'file', 'hub.ts', '', '')
  node('ses:s1', 'session', 'work', 'work', '2026-10-05T09:00:00Z', '', { cwd: a })
  node('sum:s1', 'summary', 'summary', 'Summary: shipping the cache. Next: finish the readme.', '2026-10-07T12:00:00Z', 'ses:s1')
  for (let i = 0; i < 5; i++) node(`turn:t${i}`, 'turn', `t${i}`, `Prompt ${i} about README.md\n\nWe decided to keep it short because readers skim. Failed attempt ${i}.`, `2026-10-0${i + 1}T10:00:00Z`, 'ses:s1')
  node('commit:alpha:aaaaaaa1111', 'commit', 'Update README', 'Reworks the readme', '2026-10-08T00:00:00Z', a, { onMain: true })
  node('commit:alpha:bbbbbbb2222', 'commit', 'Try readme', 'Tries a readme', '2026-10-09T00:00:00Z', a, { onMain: false, branch: 'x' })
  node('commit:alpha:ccccccc3333', 'commit', 'v1.2.3 release', 'Release', '2026-10-10T00:00:00Z', a, { onMain: true })
  node('pr:alpha#4', 'pr', 'Docs PR', 'Docs work for the readme', '2026-10-06T00:00:00Z', 'u', { state: 'OPEN', url: 'https://x.test/4', repo: a })
  node('note:Pending.md', 'note', 'Pending', 'Next to build: the readme polish\n- [ ] **first** item readme', '2026-10-04T00:00:00Z', `${a}/Pending.md`)
  for (let i = 0; i < 5; i++) edge(`turn:t${i}`, `file:${a}/README.md`, 'read')
  edge('commit:alpha:aaaaaaa1111', `file:${a}/README.md`, 'changed')
  edge('commit:alpha:bbbbbbb2222', `file:${a}/README.md`, 'changed')
  edge('pr:alpha#4', `file:${a}/README.md`, 'touches')
  edge('turn:t1', `file:${odd}`, 'edited')
  edge('turn:t0', 'ses:s1', 'part_of')
  // A hub: more than 30 readers.
  for (let i = 0; i < 35; i++) (node(`turn:h${i}`, 'turn', `h${i}`, `filler ${i}`, '2026-10-02T00:00:00Z', 'ses:s1'), edge(`turn:h${i}`, `file:${a}/src/hub.ts`, 'read'))
  edge('turn:t2', `file:${a}/src/hub.ts`, 'read')
  buildPassageIndex(db)
  db.close()

  const both = (f: (g: Graph) => string, scope?: string) => {
    const out = [false, true].map((lazy) => {
      const g = new Graph(file, { lazy })
      if (scope) g.scopeTo(scope)
      return f(g)
    })
    assert.equal(out[1], out[0])
    return out[1]!
  }
  for (const p of ['README.md', `${a}/README.md`, odd, `${a}/src/hub.ts`, 'src/hub.ts', 'nothing-here.ts']) for (const s of [a, b, undefined]) both((g) => trace(g, p), s)
  assert.match(both((g) => trace(g, 'README.md'), a), /Update README|aaaaaaa/)
  assert.match(both((g) => resume(g), a), /Next on the build list/)
  both((g) => resume(g, 'alpha'))
  both((g) => resume(g, 'readme'), b)
  // All query verbs: lazy output equals full output, with and without scope.
  for (const s of [a, b, undefined]) {
    for (const q of ['readme', 'cache shipping', 'decided short readers', 'README.md', 'pr 4', 'aaaaaaa', 'nonexistent zzz']) {
      both((g) => search(g, q), s)
      both((g) => current(g, q), s)
      both((g) => why(g, q), s)
      both((g) => tried(g, q), s)
      for (const d of ['2026-10-03', '2026-10-09', '2026-10-20', '2026-01-01']) both((g) => asof(g, d, q), s)
    }
    for (const id of ['turn:t1', 'turn:t1#p1', 'turn:t1#p9', 'ses:s1', 'commit:alpha', 'pr:alpha#4', 'nope']) both((g) => get(g, id), s)
    both((g) => path(g, 'README.md', 'Pending'), s)
    both((g) => path(g, 'turn:t1', 'commit:alpha:aaaaaaa1111'), s)
  }
})
