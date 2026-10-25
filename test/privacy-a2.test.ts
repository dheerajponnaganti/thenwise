import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { backup } from '../src/backup/backup.ts'
import { saveNote } from '../src/capture/notes.ts'
import { loadConfigSafe } from '../src/ingest/config.ts'
import { pruneCfg } from '../src/ingest/ingest.ts'
import { forget } from '../src/privacy/forget.ts'
import { tighten } from '../src/privacy/perms.ts'
import { isForgotten, loadTombs } from '../src/privacy/tombstones.ts'
import { uninstall } from '../src/privacy/uninstall.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'tw-a2-'))
const mode = (p: string) => statSync(p).mode & 0o777
function cfgOf(home: string, extra: Record<string, unknown> = {}) {
  const data = join(home, '.thenwise')
  mkdirSync(data, { recursive: true, mode: 0o700 })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 1, ingest: { roots: [], repos: [], prs: false }, ...extra }))
  process.env.THENWISE_HOME = data

  return loadConfigSafe(home).config!
}

test('Folder backup refuses a folder it did not make and removes only what it copied', () => {
  const home = tmp()
  const vault = join(home, 'vault')
  const target = join(home, 'bk')
  mkdirSync(vault)
  mkdirSync(join(target, 'vault'), { recursive: true })
  writeFileSync(join(vault, 'a.md'), 'a')
  writeFileSync(join(vault, 'b.md'), 'b')
  writeFileSync(join(target, 'vault', 'mine.txt'), 'keep me')
  const cfg = cfgOf(home, { vault: { path: vault }, backup: { kind: 'folders', folders: [target] } })
  const bad = backup(cfg)
  assert.equal(bad.ok, false)
  assert.match(bad.lines.join('\n'), /did not write/)
  rmFile(join(target, 'vault', 'mine.txt'))
  assert.ok(backup(cfg).ok)
  writeFileSync(join(target, 'vault', 'mine.txt'), 'keep me')
  rmFile(join(vault, 'b.md'))
  assert.ok(backup(cfg).ok)
  assert.ok(existsSync(join(target, 'vault', 'mine.txt')))
  assert.ok(existsSync(join(target, 'vault', 'a.md')))
  assert.ok(!existsSync(join(target, 'vault', 'b.md')))
})

function rmFile(p: string) {
  spawnSync('rm', ['-f', p])
}

test('Git backup commits only _thenwise', () => {
  const home = tmp()
  const vault = join(home, 'vault')
  mkdirSync(join(vault, '_thenwise'), { recursive: true })
  writeFileSync(join(vault, '_thenwise', 'n.md'), 'n')
  writeFileSync(join(vault, 'private.md'), 'user work')
  const cfg = cfgOf(home, { vault: { path: vault }, backup: { kind: 'git' } })
  assert.ok(backup(cfg).ok)
  const files = spawnSync('git', ['-C', vault, 'ls-files'], { encoding: 'utf8' }).stdout
  assert.match(files, /_thenwise\/n\.md/)
  assert.doesNotMatch(files, /private\.md/)
})

test('Forget keeps a similar folder name, and ingest drops forgotten and paused repos and their cached PRs', async () => {
  const home = tmp()
  const work = join(home, 'work')
  const repo = join(work, 'my.app')
  const off = join(work, 'paused')
  for (const r of [repo, off, join(work, 'my-app')]) mkdirSync(r, { recursive: true })
  for (const r of [repo, off]) {
    spawnSync('git', ['-C', r, 'init', '-q'])
    spawnSync('git', ['-C', r, 'remote', 'add', 'origin', `https://github.com/o/${r.split('/').pop()}.git`])
  }
  const cfg = cfgOf(home, { ingest: { roots: [work], repos: [repo, off, join(work, 'my-app')], prs: false }, off_projects: [off] })
  const keyDir = join(cfg.memDir, 'archive/sessions/-work-my-app')
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(cfg.memDir, 'archive/manifest.json'), JSON.stringify({ '-work-my-app/s1.jsonl.gz': { cwd: repo }, '-work-my-app/s2.jsonl.gz': { cwd: join(work, 'my-app') } }))
  writeFileSync(join(cfg.memDir, 'prs-cache.json'), JSON.stringify({ 'o/my.app': { prs: [] }, 'o/paused': { prs: [] }, 'o/other': { prs: [] } }))
  assert.equal(await forget(cfg, repo, { yes: true, print: () => {}, rewriteVault: () => {} }), 0)
  const t = loadTombs(cfg.memDir)
  assert.ok(!isForgotten(t, '-work-my-app/s2', join(work, 'my-app')), 'my-app is not my.app')
  assert.ok(isForgotten(t, '-work-my-app/s1', repo))
  const p = pruneCfg(cfg)
  assert.deepEqual(p.repos, [join(work, 'my-app')])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cfg.memDir, 'prs-cache.json'), 'utf8'))), ['o/other'])
})

test('Notes are written 0600 in 0700 folders, and tighten also fixes an older ~/.memory', () => {
  const home = tmp()
  const mem = join(home, '.thenwise')
  mkdirSync(mem, { mode: 0o700 })
  const n = saveNote(mem, { id: 'x', type: 'decision', title: 't', summary: 's', status: 'inbox', valid_from: '', valid_to: '', supersedes: '', sources: [], created: '', project: '', path: '' } as any)
  assert.equal(mode(n.path), 0o600)
  assert.equal(mode(join(mem, 'notes', 'decision')), 0o700)
  const old = join(home, '.memory')
  mkdirSync(old)
  writeFileSync(join(old, 'graph.db'), 'x')
  chmodSync(join(old, 'graph.db'), 0o644)
  tighten(mem)
  assert.equal(mode(join(old, 'graph.db')), 0o600)
})

test('Uninstall does not signal a process that is not Thenwise, and lists the extras', async () => {
  const home = tmp()
  const cfg = cfgOf(home)
  const holder = spawn('sleep', ['30'])
  writeFileSync(join(cfg.memDir, 'sync.lock'), String(holder.pid))
  writeFileSync(join(cfg.memDir, 'team.json'), '{}')
  const lines: string[] = []
  uninstall(home, (l) => lines.push(l))
  const out = lines.join('\n')
  assert.match(out, /No background sync is running/)
  assert.match(out, /npm uninstall -g thenwise/)
  assert.match(out, /team server/)
  assert.equal(holder.kill(0), true, 'the unrelated process is still alive')
  holder.kill()
  await new Promise((res) => holder.on('close', res))
})
