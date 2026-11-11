import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { loadConfig } from '../src/ingest/config.ts'
import { ingest } from '../src/ingest/ingest.ts'


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

test('#111: a project view path written with backslashes claims the chats that edited files under it', async () => {
  const { sessionProjects } = await import('../src/views/views.ts')
  const { Graph } = await import('../src/query/engine.ts')
  const { writeGraph } = await import('./mcp-fixture.ts')
  const file = writeGraph(mkdtempSync(join(tmpdir(), 'tw-view-win-')))
  const db = new DatabaseSync(file)
  db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run('file:/x/q/src/a.ts', 'file', 'a.ts', '', '2026-10-05T10:00:00Z', '', 'p', '', '{}')
  db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run('turn:t1', 'file:/x/q/src/a.ts', 'edited', '', '{}')
  db.close()
  // On Windows a configured path keeps its backslashes, while file ids always use forward slashes.
  const { projectOf } = sessionProjects(new Graph(file), [{ name: 'win view', words: [], paths: ['\\x\\q'] }])
  assert.equal(projectOf.get('ses:s1'), 'win view')
})
