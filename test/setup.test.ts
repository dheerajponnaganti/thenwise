import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { archive } from '../src/ingest/archive.ts'
import { isOff, loadConfigSafe, readConfigFile } from '../src/ingest/config.ts'
import { runDoctor } from '../src/setup/doctor.ts'
import { discoverProjects } from '../src/setup/projects.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const MARK = '[no-memory]'

function chat(dir: string, name: string, cwd: string, prompt: string) {
  mkdirSync(dir, { recursive: true })
  const row = (type: string, content: string, i: number) => JSON.stringify({ type, uuid: `${name}${i}`, timestamp: `2026-10-02T10:0${i}:00Z`, cwd, sessionId: name, entrypoint: 'cli', message: { role: type, content } })
  writeFileSync(join(dir, `${name}.jsonl`), `${row('user', prompt, 0)}\n${row('assistant', 'ok', 1)}\n`)
}

// F1: three projects (alpha is a git repo), one marked test chat, a gh that is signed out.
function f1(extra = true) {
  const home = mkdtempSync(join(tmpdir(), 'tw-setup-'))
  const work = join(home, 'work')
  mkdirSync(join(work, 'alpha', '.git'), { recursive: true })
  writeFileSync(join(work, 'alpha', '.gitignore'), 'node_modules')
  const proj = (key: string) => join(home, '.claude', 'projects', key)
  chat(proj('-work-alpha'), 'a1', join(work, 'alpha'), 'billing exporter retries')
  chat(proj('-work-alpha'), 'a2', join(work, 'alpha'), `cache warmer ${MARK}`)
  chat(proj('-work-beta'), 'b1', join(work, 'beta'), 'changelog format')
  if (extra) chat(proj('-work-personal'), 'p1', join(work, 'personal'), 'my diary')
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, THENWISE_HOME: join(home, '.thenwise') }
  const cli = (args: string[], input = '') => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', cwd: home })

  return { home, work, data: join(home, '.thenwise'), cli, cfg: () => JSON.parse(readFileSync(join(home, '.thenwise', 'config.json'), 'utf8')) }
}
const allFiles = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]))

test('S2-H1 S2-H4 S2-H6 S2-H8 S2-B5 S7-B2: setup --yes lists projects, drops personal, writes a versioned config', () => {
  const f = f1()
  const r = f.cli(['setup', '--yes', '--drop', 'personal'])
  assert.equal(r.status, 0, r.stderr)
  for (const name of ['alpha', 'beta', 'personal']) assert.match(r.stdout, new RegExp(name))
  assert.match(r.stdout, /\[ \] personal/)
  const c = f.cfg()
  assert.equal(c.version, 1)
  assert.deepEqual(c.ingest.roots, [join(f.work, 'alpha'), join(f.work, 'beta')])
  assert.deepEqual(c.ingest.repos, [join(f.work, 'alpha')])
  assert.ok(c.exclude_projects.includes('-work-personal'))
  assert.equal(c.vault.place, 'central')
  assert.equal(c.vault.path, '~/Thenwise')
  assert.equal(readConfigFile(f.data).errors.length, 0)
  const files = allFiles(join(f.data, 'archive', 'sessions')).join('\n')
  assert.ok(!files.includes('personal'), 'a dropped project never reaches the archive')
  assert.ok(files.includes('a1.jsonl.gz') && files.includes('b1.jsonl.gz'))
})

test('S2-H5 S7-B1: first sync shows chats done of total; a marked chat is never archived', () => {
  const f = f1()
  const r = f.cli(['setup', '--yes', '--drop', 'personal'])
  assert.match(r.stderr, /archiving chats: 4 of 4/)
  assert.match(r.stdout, /Archived 2 chats/)
  assert.match(r.stdout, /1 test chats/)
  assert.ok(!existsSync(join(f.data, 'archive', 'sessions', '-work-alpha', 'a2.jsonl.gz')))
})

test('S2-H8: a fresh home defaults roots to the projects found, with no owner folders', () => {
  const f = f1()
  const { config } = loadConfigSafe(f.home)
  assert.deepEqual(config!.roots.sort(), [join(f.work, 'alpha'), join(f.work, 'beta'), join(f.work, 'personal')])
  assert.deepEqual(config!.repos, [join(f.work, 'alpha')])
  assert.deepEqual(config!.githubRepos, [])
  assert.deepEqual(config!.vaults, [])
  assert.ok(!JSON.stringify(config).includes(homedir()), 'nothing from the real home folder')
})

test('S2-H7: a second run shows the current answers and changes only what is asked', () => {
  const f = f1()
  f.cli(['setup', '--yes', '--drop', 'personal', '--no-sync', '--backup', 'git'])
  const first = f.cfg()
  const r = f.cli(['setup', '--yes', '--no-sync'])
  assert.match(r.stdout, /Current setup/)
  assert.match(r.stdout, /backup: git/)
  assert.deepEqual(f.cfg(), first)
  f.cli(['setup', '--yes', '--no-sync', '--backup', 'none'])
  assert.deepEqual({ ...f.cfg(), backup: first.backup }, first)
  assert.equal(f.cfg().backup.kind, 'none')
})

test('S2-H2 S2-H3 S2-B7: Obsidian vault inside a repo, no commit ignores the folder the writer uses', () => {
  const f = f1()
  const r = f.cli(['setup', '--yes', '--no-sync', '--place', 'obsidian', '--vault-path', join(f.work, 'alpha', 'vault'), '--no-commit-vault'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(f.work, 'alpha', '.gitignore'), 'utf8'), 'node_modules\nvault/_thenwise/\n')
  assert.equal(f.cfg().vault.place, 'obsidian')
  assert.equal(f.cfg().vault.commit, false)
})

test('S2-37: the menu has no per-project vault, and --place project is refused', () => {
  const f = f1()
  const r = f.cli(['setup', '--no-sync'], '\n1\n\nn\n\nnone\n')
  assert.ok(!r.stdout.includes('inside each project'))
  assert.equal(f.cli(['setup', '--yes', '--no-sync', '--place', 'project']).status, 2)
})

test('S2-7: --yes leaves PRs off', () => {
  const f = f1()
  f.cli(['setup', '--yes', '--no-sync'])
  assert.equal(f.cfg().ingest.prs, false)
})

test('S2-B1: no ~/.claude/projects says so, exits 0 and creates no store', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-empty-'))
  const r = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { env: { ...process.env, HOME: home, USERPROFILE: home, THENWISE_HOME: join(home, '.thenwise') }, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /no chats yet/)
  assert.ok(!existsSync(join(home, '.thenwise')))
})

test('S2-B2: broken config JSON names the line and is never overwritten', () => {
  const f = f1()
  mkdirSync(f.data)
  const bad = '{\n  "version": 1,\n  "ingest": {\n    "roots": [\n  }\n}\n'
  writeFileSync(join(f.data, 'config.json'), bad)
  const r = readConfigFile(f.data)
  assert.match(r.errors[0]!, /broken JSON at line \d+/)
  assert.equal(loadConfigSafe(f.home).config, null)
  const s = f.cli(['setup', '--yes'])
  assert.equal(s.status, 2)
  assert.match(s.stderr, /broken JSON at line/)
  assert.equal(readFileSync(join(f.data, 'config.json'), 'utf8'), bad)
  assert.equal(f.cli(['off']).status, 2)
  assert.equal(readFileSync(join(f.data, 'config.json'), 'utf8'), bad)
})

test('S2-B3: wrong types are named errors, unknown keys are warnings', () => {
  const f = f1()
  mkdirSync(f.data)
  writeFileSync(join(f.data, 'config.json'), JSON.stringify({ ingest: { roots: '/a' }, off: 'no', surprise: 1, vault: { place: 'moon' } }))
  const r = readConfigFile(f.data)
  assert.ok(r.errors.some((e) => /"ingest.roots" must be a list of text, found string/.test(e)))
  assert.ok(r.errors.some((e) => /"off" must be a boolean/.test(e)))
  assert.ok(r.errors.some((e) => /"vault.place" must be one of/.test(e)))
  assert.deepEqual(r.warnings, ['unknown key "surprise" (ignored)'])
})

test('S2-B4: a newer config version is refused', () => {
  const f = f1()
  mkdirSync(f.data)
  writeFileSync(join(f.data, 'config.json'), JSON.stringify({ version: 2 }))
  const r = loadConfigSafe(f.home)
  assert.equal(r.config, null)
  assert.match(r.errors[0]!, /newer than this Thenwise.*Update Thenwise/)
})

test('S2-B6: a vault in a cloud folder warns and needs a confirmation', () => {
  const f = f1()
  const cloud = join(f.home, 'Library', 'Mobile Documents', 'x')
  const r = f.cli(['setup', '--yes', '--no-sync', '--vault-path', cloud])
  assert.equal(r.status, 2)
  assert.match(r.stdout, /synced folder/)
  assert.ok(!existsSync(join(f.data, 'config.json')))
  assert.equal(f.cli(['setup', '--yes', '--no-sync', '--vault-path', cloud, '--allow-cloud']).status, 0)
  const g = f1()
  const ok = g.cli(['setup', '--no-sync', '--vault-path', cloud], '\n1\nshared\n\nn\n\nnone\n')
  assert.equal(ok.status, 2, 'declining the prompt stops setup')
})

test('S2-B8: closing the input mid-setup leaves no config behind and the next run starts clean', () => {
  const f = f1()
  const r = f.cli(['setup', '--no-sync'], '\n2\n')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Nothing was changed/)
  assert.ok(!existsSync(f.data) || readdirSync(f.data).length === 0)
  assert.equal(f.cli(['setup', '--yes', '--no-sync']).status, 0)
})

test('S2-B10: dots, underscores, spaces and a key shared by two folders', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-keys-'))
  const proj = (k: string) => join(home, '.claude', 'projects', k)
  chat(proj('-a-b-c'), 's1', '/w/a.b/c', 'x')
  chat(proj('-a-b-c'), 's2', '/w/a.b/c', 'x')
  chat(proj('-a-b-c'), 's3', '/w/a_b c', 'x')
  chat(proj('-sp'), 's1', '/w/my project', 'x')
  const found = discoverProjects(join(home, '.claude'))
  const abc = found.find((p) => p.key === '-a-b-c')!
  assert.equal(abc.folder, '/w/a.b/c')
  assert.deepEqual(abc.clash, ['/w/a_b c'])
  assert.equal(found.find((p) => p.key === '-sp')!.folder, '/w/my project')
})

test('S2-B11: an existing ~/.memory with its own config is kept; setup offers to move it', () => {
  const f = f1()
  const old = join(f.home, '.memory')
  mkdirSync(old)
  writeFileSync(join(old, 'config.json'), JSON.stringify({ version: 1, ingest: { roots: ['/keep/me'] } }))
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: f.home, USERPROFILE: f.home, PATH: `${join(f.home, 'bin')}:/usr/bin:/bin`, THENWISE_HOME: '' }, encoding: 'utf8' })
  const r = run(['setup', '--yes', '--no-sync'])
  assert.match(r.stdout, /older folder/)
  assert.ok(JSON.parse(readFileSync(join(old, 'config.json'), 'utf8')).ingest.roots.includes('/keep/me'))
  assert.ok(!existsSync(join(f.home, '.thenwise')))
  run(['setup', '--yes', '--no-sync', '--move-data'])
  assert.ok(JSON.parse(readFileSync(join(f.home, '.thenwise', 'config.json'), 'utf8')).ingest.roots.includes('/keep/me'))
  assert.ok(!existsSync(old))
})

test('S2-H9 S2-B9: doctor names every check, and gives one fix line per broken part', async () => {
  const f = f1()
  f.cli(['setup', '--yes', '--no-sync'])
  f.cli(['archive'])
  f.cli(['ingest'])
  mkdirSync(join(f.home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(f.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'thenwise@thenwise': [{}] } }))
  const good = await runDoctor(f.home, { gh: () => true })
  assert.deepEqual(good.map((c) => c.name), ['node', 'data folder', 'config', 'archive', 'store', 'disk', 'plugin', 'mcp', 'gh'])
  assert.ok(good.every((c) => c.ok), JSON.stringify(good.filter((c) => !c.ok)))
  assert.equal(f.cli(['doctor']).stdout.split('\n').filter((l) => l.startsWith('ok')).length >= 5, true)

  const bad = (cs: { name: string; ok: boolean; detail: string }[], name: string) => cs.find((c) => c.name === name)!
  assert.match(bad(await runDoctor(f.home, { nodeVersion: '22.12.0', gh: () => true }), 'node').detail, /needs Node 22.16/)
  assert.match(bad(await runDoctor(f.home, { gh: () => false }), 'gh').detail, /gh auth login/)
  assert.match(bad(await runDoctor(f.home, { gh: () => true, mcp: () => false }), 'mcp').detail, /thenwise mcp/)
  writeFileSync(join(f.data, 'graph.db'), 'not a database at all')
  const hurt = bad(await runDoctor(f.home, { gh: () => true }), 'store')
  assert.equal(hurt.ok, false)
  assert.match(hurt.detail, /thenwise ingest/)
  writeFileSync(join(f.home, '.claude', 'plugins', 'installed_plugins.json'), '{"plugins":{}}')
  assert.match(bad(await runDoctor(f.home, { gh: () => true }), 'plugin').detail, /\/plugin install/)
  if (process.platform !== 'win32') {
    chmodSync(f.data, 0o500)
    const ro = bad(await runDoctor(f.home, { gh: () => true }), 'data folder')
    chmodSync(f.data, 0o700)
    assert.equal(ro.ok, false)
    assert.match(ro.detail, /not writable/)
  }
  const empty = mkdtempSync(join(tmpdir(), 'tw-doc-'))
  const none = await runDoctor(empty, { gh: () => true })
  assert.match(bad(none, 'archive').detail, /thenwise archive/)
  for (const c of none.filter((x) => !x.ok)) assert.equal(c.detail.includes('\n'), false)
})

test('S7-H4: off for a project archives nothing from it; on resumes; a global off pauses everything', () => {
  const f = f1()
  assert.match(f.cli(['off', '--project', join(f.work, 'beta')]).stdout, /off for/)
  assert.deepEqual(f.cfg().off_projects.map((p: string) => resolve(p)), [resolve(f.work, 'beta')])
  const r = f.cli(['archive'])
  assert.match(r.stdout, /1 chat of paused projects/)
  const files = allFiles(join(f.data, 'archive', 'sessions')).join('\n')
  assert.ok(!files.includes('b1.jsonl.gz') && files.includes('a1.jsonl.gz') && files.includes('p1.jsonl.gz'))
  f.cli(['on', '--project', join(f.work, 'beta')])
  assert.deepEqual(f.cfg().off_projects, [])
  f.cli(['archive'])
  assert.ok(allFiles(join(f.data, 'archive', 'sessions')).join('\n').includes('b1.jsonl.gz'))
  f.cli(['off'])
  assert.equal(f.cfg().off, true)
  chat(join(f.home, '.claude', 'projects', '-work-alpha'), 'a3', join(f.work, 'alpha'), 'new')
  f.cli(['archive'])
  assert.ok(!allFiles(join(f.data, 'archive', 'sessions')).join('\n').includes('a3.jsonl.gz'))
})

test('S7-H4: isOff matches the project and folders inside it', () => {
  const cfg = { off: false, offProjects: ['/w/alpha'] }
  assert.ok(isOff(cfg, '/w/alpha') && isOff(cfg, '/w/alpha/src') && !isOff(cfg, '/w/alphabet') && !isOff(cfg, '/w/beta') && !isOff(cfg, undefined))
  assert.ok(isOff({ off: true, offProjects: [] }, '/anywhere'))
})

test('S7-B1 S7-B2: excluded chats are never archived; the old copy of a marked chat goes at once, that of an excluded project waits for --prune-excluded', () => {
  const f = f1()
  f.cli(['setup', '--yes', '--no-sync'])
  const sess = join(f.data, 'archive', 'sessions')
  // An older Thenwise archived the marked chat and the personal project.
  mkdirSync(join(sess, '-work-alpha'), { recursive: true })
  writeFileSync(join(sess, '-work-alpha', 'a2.jsonl.gz'), 'x')
  mkdirSync(join(sess, '-work-personal'), { recursive: true })
  writeFileSync(join(sess, '-work-personal', 'p1.jsonl.gz'), 'x')
  const cfgFile = join(f.data, 'config.json')
  const user = JSON.parse(readFileSync(cfgFile, 'utf8'))
  writeFileSync(cfgFile, JSON.stringify({ ...user, exclude_projects: [...(user.exclude_projects ?? []), '-work-personal'] }))
  const cfg = loadConfigSafe(f.home).config!
  const r = archive(cfg)
  assert.equal(r.excludedChats, 1)
  assert.deepEqual(r.pruned, ['-work-alpha/a2.jsonl'])
  assert.ok(!existsSync(join(sess, '-work-alpha', 'a2.jsonl.gz')), 'a [no-memory] chat is never kept')
  assert.deepEqual(r.leftover, ['-work-personal/p1.jsonl'])
  assert.ok(existsSync(join(sess, '-work-personal', 'p1.jsonl.gz')), 'an excluded project is not deleted without the flag')
  assert.match(f.cli(['archive']).stdout, /archived chats belong to excluded/)
  const p = archive(cfg, { prune: true })
  assert.deepEqual(p.pruned, ['-work-personal/p1.jsonl'])
  assert.ok(!existsSync(join(sess, '-work-alpha', 'a2.jsonl.gz')) && !existsSync(join(sess, '-work-personal', 'p1.jsonl.gz')))
  assert.deepEqual(archive(cfg).leftover, [])
})

test('decide names a similar note and still saves the new one', () => {
  const f = f1()
  assert.equal(f.cli(['decide', 'Keep the price cache in eight shards by store id']).status, 0)
  const again = f.cli(['decide', 'Keep the price cache in nine shards by store id'])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /saved as/)
  assert.match(again.stdout, /Similar note: n-\S+: Keep the price cache in eight shards/)
  assert.doesNotMatch(f.cli(['decide', 'Ship the billing export on Fridays only']).stdout, /Similar note/)
})
