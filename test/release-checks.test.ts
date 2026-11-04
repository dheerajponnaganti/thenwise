import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// @ts-expect-error a plain script with no types
import { section } from '../scripts/changelog-section.mjs'
// @ts-expect-error a plain script with no types
import { checkVersions } from '../scripts/check-versions.mjs'
// @ts-expect-error a plain script with no types
import { assemble, PLUGIN_FILES } from '../scripts/plugin-folder.mjs'

const ROOT = resolve('.')
const SCRIPT = resolve('scripts/check-plugin-build.mjs')

function versioned(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'thenwise-ver-'))
  mkdirSync(join(dir, '.claude-plugin'))
  mkdirSync(join(dir, '.plugin'))
  mkdirSync(join(dir, '.codex-plugin'))
  mkdirSync(join(dir, '.antigravity-plugin'))
  const write = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v))
  write('package.json', { version })
  write('package-lock.json', { version, packages: { '': { version } } })
  write('.claude-plugin/plugin.json', { version })
  write('.plugin/plugin.json', { version })
  write('.codex-plugin/plugin.json', { version })
  write('.antigravity-plugin/plugin.json', { version })
  write('.claude-plugin/marketplace.json', { plugins: [{ name: 'x' }] })
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\n- Done.\n`)

  return { dir, write }
}

test('changelog-section: one version, stopping at the next, and null when it is missing or empty', () => {
  const log = '# Changelog\n\n## Unreleased\n\n- New.\n\n## 1.2.0\n\nA line.\n\n- Done.\n\n## 1.1.0\n\n- Old.\n'
  assert.equal(section(log, '1.2.0'), 'A line.\n\n- Done.')
  assert.equal(section(log, '1.1.0'), '- Old.')
  assert.equal(section(log, '9.9.9'), null)
  assert.equal(section('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0'), null)
  assert.ok(section(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version))
})

test('check-versions: the real repo has one version everywhere', () => {
  assert.deepEqual(checkVersions(ROOT), [])
})

test('check-versions: every drift is named, and a matching tag passes', () => {
  assert.deepEqual(checkVersions(versioned().dir, 'v1.2.3'), [])
  assert.match(checkVersions(versioned().dir, 'v1.2.4').join(), /tag v1\.2\.4/)
  const plugin = versioned()
  plugin.write('.claude-plugin/plugin.json', { version: '1.2.2' })
  assert.match(checkVersions(plugin.dir).join(), /plugin\.json/)
  const copilot = versioned()
  copilot.write('.plugin/plugin.json', { version: '1.2.2' })
  assert.match(checkVersions(copilot.dir).join(), /\.plugin\/plugin\.json/)
  const codex = versioned()
  codex.write('.codex-plugin/plugin.json', { version: '1.2.2' })
  assert.match(checkVersions(codex.dir).join(), /\.codex-plugin\/plugin\.json/)
  const lock = versioned()
  lock.write('package-lock.json', { version: '1.2.3', packages: { '': { version: '1.2.2' } } })
  assert.match(checkVersions(lock.dir).join(), /root package/)
  const market = versioned()
  market.write('.claude-plugin/marketplace.json', { plugins: [{ name: 'x', version: '1.2.3' }] })
  assert.match(checkVersions(market.dir).join(), /marketplace/)
  const folder = versioned()
  mkdirSync(join(folder.dir, 'plugin'))
  assert.match(checkVersions(folder.dir).join(), /plugin\/package\.json version undefined.*plugin:folder/)
  const log = versioned()
  writeFileSync(join(log.dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.2\n')
  assert.match(checkVersions(log.dir).join(), /CHANGELOG/)
  assert.ok(checkVersions(versioned('1.2').dir).length > 0)
})

// A tiny project whose tags carry a plugin/ folder: the runtime files plus a dist/ that may or may not be a true build.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'thenwise-build-t-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a: number = 1\n')
  writeFileSync(join(dir, 'tsconfig.json'), readFileSync(join(ROOT, 'tsconfig.json')))
  writeFileSync(join(dir, 'tsconfig.build.json'), readFileSync(join(ROOT, 'tsconfig.build.json')))
  for (const f of PLUGIN_FILES as string[]) {
    // JSON files and LICENSE are files; the rest are folders, given one file each.
    const file = /\.json$|^LICENSE$/.test(f) ? f : join(f, 'x.md')
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), f === 'package.json' ? '{"type":"module"}\n' : `${f}\n`)
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  // Commits plugin/ as assembled from this source, with js as its dist/a.js, and tags it.
  const release = (tag: string, js: string) => {
    const dist = mkdtempSync(join(tmpdir(), 'thenwise-build-d-'))
    writeFileSync(join(dist, 'a.js'), js)
    assemble(dir, dist, join(dir, 'plugin'))
    git('add', '-A')
    git('commit', '-q', '-m', tag)
    git('tag', tag)
  }

  return { dir, git, run, release }
}

test('check-plugin-build: a true plugin/ passes; a changed dist, a stale file or no folder is refused', () => {
  const p = project()
  p.git('add', '-A')
  p.git('commit', '-q', '-m', 'First')
  assert.equal(p.run('--self').status, 0)
  assert.match(p.run('--folder', '--tag', 'HEAD').stderr, /no plugin\/ folder/)
  // What TypeScript really prints for this source, taken from a real build.
  const out = mkdtempSync(join(tmpdir(), 'thenwise-build-o-'))
  for (const f of ['src', 'tsconfig.json', 'tsconfig.build.json', 'package.json']) cpSync(join(p.dir, f), join(out, f), { recursive: true })
  symlinkSync(resolve('node_modules'), join(out, 'node_modules'), 'junction')
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(out, 'tsconfig.build.json')])
  const built = readFileSync(join(out, 'dist/a.js'), 'utf8')

  p.release('v1.0.0', built)
  const good = p.run('--folder', '--tag', 'v1.0.0')
  assert.equal(good.status, 0, good.stderr + good.stdout)

  p.release('v1.0.1', `${built}// planted\n`)
  const planted = p.run('--folder', '--tag', 'v1.0.1')
  assert.equal(planted.status, 1)
  assert.match(planted.stderr, /dist\/a\.js differs/)

  p.release('v1.0.2', built)
  writeFileSync(join(p.dir, 'hooks/x.md'), 'changed\n')
  p.git('add', '-A')
  p.git('commit', '-q', '-m', 'Hooks changed, plugin/ not rebuilt')
  p.git('tag', 'v1.0.3')
  const stale = p.run('--folder', '--tag', 'v1.0.3')
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /hooks\/x\.md differs/)
})

test('check-plugin-build --pr: plugin/ may change only with a version bump, and only as its source built', () => {
  const p = project()
  p.git('add', '-A')
  p.git('commit', '-q', '-m', 'First')
  const out = mkdtempSync(join(tmpdir(), 'thenwise-build-o-'))
  for (const f of ['src', 'tsconfig.json', 'tsconfig.build.json', 'package.json']) cpSync(join(p.dir, f), join(out, f), { recursive: true })
  symlinkSync(resolve('node_modules'), join(out, 'node_modules'), 'junction')
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(out, 'tsconfig.build.json')])
  const built = readFileSync(join(out, 'dist/a.js'), 'utf8')
  p.release('v1.0.0', built)
  const base = p.git('rev-parse', 'HEAD')

  writeFileSync(join(p.dir, 'notes.txt'), 'a normal change\n')
  p.git('add', '-A')
  p.git('commit', '-q', '-m', 'Normal change')
  const normal = p.run('--pr', base)
  assert.equal(normal.status, 0, normal.stderr)
  assert.match(normal.stdout, /unchanged/)

  p.release('v1.0.1', `${built}// unreleased\n`)
  const noBump = p.run('--pr', base)
  assert.equal(noBump.status, 1)
  assert.match(noBump.stderr, /only a release pull request may change plugin\//)

  writeFileSync(join(p.dir, 'package.json'), '{"type":"module","version":"2.0.0"}\n')
  p.release('v2.0.0', built)
  const release = p.run('--pr', base)
  assert.equal(release.status, 0, release.stderr + release.stdout)

  p.release('v2.0.1', `${built}// planted\n`)
  const planted = p.run('--pr', base)
  assert.equal(planted.status, 1)
  assert.match(planted.stderr, /dist\/a\.js differs/)
})

test('check-plugin-build: no arguments prints usage', () => {
  assert.equal(project().run().status, 2)
})
