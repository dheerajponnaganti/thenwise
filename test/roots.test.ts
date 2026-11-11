import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfig } from '../src/ingest/config.ts'
import { aliasesOf, docsPart, fileNode, walk } from '../src/ingest/parts.ts'
import { World } from './world.ts'

test('E1 fix: an unreadable folder under a root is skipped, not fatal', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-walk-'))
  mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'CLAUDE.md'), '# rules')
  chmodSync(join(root, 'locked'), 0o000)
  const out: string[] = []
  walk(root, (n) => n === 'CLAUDE.md', out)
  chmodSync(join(root, 'locked'), 0o700)
  assert.deepEqual(out, [join(root, 'CLAUDE.md')])
})

test('E1 fix: the home folder as a root reads only its own CLAUDE.md, never the whole tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-home-'))
  mkdirSync(join(home, 'deep/a'), { recursive: true })
  writeFileSync(join(home, 'CLAUDE.md'), '# home rules\n- one rule')
  writeFileSync(join(home, 'deep/a/CLAUDE.md'), '# deep rules\n- should not be read')
  const cfg = { ...loadConfig(home), roots: [home] }
  const sources = docsPart(cfg).nodes.map((n) => n.source)
  assert.ok(sources.some((s) => s === join(home, 'CLAUDE.md').replace(/\\/g, '/'))) // stored paths use forward slashes
  assert.ok(!sources.some((s) => s.includes('deep')))
})

test('E1 fix: a chat run in the disk root is not offered as a project', async () => {
  const { discoverProjects } = await import('../src/setup/projects.ts')
  const claude = mkdtempSync(join(tmpdir(), 'tw-claude-'))
  for (const [key, cwd] of [['-', '/'], ['-x-app', '/x/app']] as const) {
    mkdirSync(join(claude, 'projects', key), { recursive: true })
    writeFileSync(join(claude, 'projects', key, 's.jsonl'), JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n')
  }
  const found = discoverProjects(claude).map((p) => p.folder)
  assert.ok(found.includes('/x/app'), JSON.stringify(found))
  assert.ok(!found.includes('/'))
})

test('#109: a root with a trailing slash gives whole file aliases, on any system; update equals rebuild', () => {
  const alias = (id: string, roots: string[]) => aliasesOf(fileNode(id, new Set(['changed']), roots))
  for (const r of ['/x/p', '/x/p/', '/x/p//', '/x/p\\']) assert.deepEqual(alias('file:/x/p/src/a.ts', [r]), ['src/a.ts'], r)
  for (const r of ['C:\\x\\p', 'C:\\x\\p\\', 'C:/x/p/']) assert.deepEqual(alias('file:C:/x/p/src/a.ts', [r]), ['src/a.ts'], r)
  assert.deepEqual(alias('file:/x/p/src/a.ts', ['/x/p/', '/x/p']), ['src/a.ts'], 'one root written two ways is one alias')
  assert.deepEqual(alias('file:/x/p', ['/x/p/']), [], 'the root itself has no alias')

  const w = new World()
  try {
    // The config is read once: every root, repo and folder loses its trailing slashes there; a disk root keeps its own.
    const load = (ingest: object) => (writeFileSync(join(w.home, '.thenwise/config.json'), JSON.stringify({ ingest })), (w.cfg = loadConfig(w.home)))
    assert.deepEqual(load({ roots: ['/', 'C:\\', 'C:\\x\\p\\', '~/p/'] }).roots, ['/', 'C:\\', 'C:\\x\\p', join(w.home, 'p')])
    load({ roots: [`${w.proj}/`], repos: [`${w.proj}//`], vaults: [`${w.vault}/`] })
    assert.deepEqual([w.cfg.roots, w.cfg.repos, w.cfg.vaults], [[w.proj], [w.proj], [w.vault]])
    w.ingest('inc.db')
    w.commit(w.proj, 'src/b.ts', 'Add b')
    const r = w.both()
    assert.equal(r.a, r.b, 'an update stores the same aliases as a rebuild')
    const db = new DatabaseSync(w.path('full.db'), { readOnly: true })
    const aliases = (db.prepare("SELECT alias FROM file_alias WHERE alias LIKE '%a.ts' OR alias LIKE '%b.ts' ORDER BY alias").all() as { alias: string }[]).map((x) => x.alias)
    db.close()
    assert.ok(aliases.includes('src/a.ts') && aliases.includes('src/b.ts'), JSON.stringify(aliases))
    assert.ok(!aliases.some((a) => /^(rc|c)\//.test(a)), JSON.stringify(aliases))
  } finally {
    w.destroy()
  }
})
