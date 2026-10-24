import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfig } from '../src/ingest/config.ts'
import { docsPart, walk } from '../src/ingest/parts.ts'

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
  assert.ok(sources.some((s) => s === join(home, 'CLAUDE.md')))
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
