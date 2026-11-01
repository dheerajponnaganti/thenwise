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

const ROOT = resolve('.')
const SCRIPT = resolve('scripts/check-plugin-build.mjs')

function versioned(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'thenwise-ver-'))
  mkdirSync(join(dir, '.claude-plugin'))
  const write = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v))
  write('package.json', { version })
  write('package-lock.json', { version, packages: { '': { version } } })
  write('.claude-plugin/plugin.json', { version })
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
  const lock = versioned()
  lock.write('package-lock.json', { version: '1.2.3', packages: { '': { version: '1.2.2' } } })
  assert.match(checkVersions(lock.dir).join(), /root package/)
  const market = versioned()
  market.write('.claude-plugin/marketplace.json', { plugins: [{ name: 'x', version: '1.2.3' }] })
  assert.match(checkVersions(market.dir).join(), /marketplace/)
  const log = versioned()
  writeFileSync(join(log.dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.2\n')
  assert.match(checkVersions(log.dir).join(), /CHANGELOG/)
  assert.ok(checkVersions(versioned('1.2').dir).length > 0)
})

// A tiny project with a tag on main and a release branch that holds the built dist/.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'thenwise-build-t-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a: number = 1\n')
  writeFileSync(join(dir, 'tsconfig.json'), readFileSync(join(ROOT, 'tsconfig.json')))
  writeFileSync(join(dir, 'tsconfig.build.json'), readFileSync(join(ROOT, 'tsconfig.build.json')))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  git('add', '.')
  git('commit', '-q', '-m', 'First')
  git('tag', 'v1.0.0')
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })
  const release = (js: string) => {
    git('checkout', '-q', '-B', 'release', 'v1.0.0')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist/a.js'), js)
    git('add', '-f', 'dist')
    git('commit', '-q', '-m', 'Release')
  }

  return { dir, git, run, release }
}

test('check-plugin-build: a true build passes, and a changed dist or source is refused', () => {
  const p = project()
  assert.equal(p.run('--self').status, 0)
  // What TypeScript really prints for this source, taken from a real build.
  const out = mkdtempSync(join(tmpdir(), 'thenwise-build-o-'))
  for (const f of ['src', 'tsconfig.json', 'tsconfig.build.json', 'package.json']) cpSync(join(p.dir, f), join(out, f), { recursive: true })
  symlinkSync(resolve('node_modules'), join(out, 'node_modules'), 'junction')
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(out, 'tsconfig.build.json')])
  const built = readFileSync(join(out, 'dist/a.js'), 'utf8')

  p.release(built)
  const good = p.run('--release', 'release', '--tag', 'v1.0.0')
  assert.equal(good.status, 0, good.stderr + good.stdout)

  p.release(`${built}// planted\n`)
  const planted = p.run('--release', 'release', '--tag', 'v1.0.0')
  assert.equal(planted.status, 1)
  assert.match(planted.stderr, /a\.js differs/)

  p.release(built)
  writeFileSync(join(p.dir, 'src/a.ts'), 'export const a: number = 2\n')
  p.git('add', '.')
  p.git('commit', '-q', '-m', 'Changed source')
  const source = p.run('--release', 'release', '--tag', 'v1.0.0')
  assert.equal(source.status, 1)
  assert.match(source.stderr, /src\/a\.ts differs/)
})

test('check-plugin-build: no arguments prints usage', () => {
  assert.equal(project().run().status, 2)
})
