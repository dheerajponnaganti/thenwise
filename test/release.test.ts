import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { CONFIG_VERSION, loadConfigSafe } from '../src/ingest/config.ts'
import { STORE_FORMAT, storeFormat } from '../src/ingest/ingest.ts'

const ROOT = new URL('..', import.meta.url).pathname
const CLI = join(ROOT, 'src/cli.ts')

// R-H3: licence, changelog and one version everywhere.
test('R-H3: Apache 2.0, a changelog entry for the version, and one version in package, plugin and marketplace', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'))
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(plugin.version, pkg.version)
  assert.equal(market.plugins[0].version, pkg.version)
  assert.equal(market.plugins[0].name, plugin.name)
  assert.equal(pkg.license, 'Apache-2.0')
  assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0[\s\S]*Copyright 2026 /)
  assert.ok(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').includes(`\n## ${pkg.version}\n`))
})

// A home with one small chat, run through the real CLI.
function home() {
  const h = mkdtempSync(join(tmpdir(), 'tw-rel-'))
  const proj = join(h, '.claude', 'projects', '-work-alpha')
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(h, 'work', 'alpha'), { recursive: true })
  const row = (type: string, content: string, i: number) => JSON.stringify({ type, uuid: `u${i}`, timestamp: `2026-10-02T10:0${i}:00Z`, cwd: join(h, 'work', 'alpha'), sessionId: 's1', entrypoint: 'cli', message: { role: type, content } })
  writeFileSync(join(proj, 's1.jsonl'), `${row('user', 'billing exporter retries', 0)}\n${row('assistant', 'we chose eight shards', 1)}\n`)
  const data = join(h, '.thenwise')
  const env = { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: data }
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: h })

  return { h, data, cli }
}

test('R-B2: a store and config from 0.1.0 are kept and read by the next version', () => {
  const { h, data, cli } = home()
  try {
    assert.equal(cli('setup', '--yes', '--no-sync').status, 0)
    assert.equal(JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')).version, CONFIG_VERSION)
    assert.equal(cli('archive').status, 0)
    assert.equal(cli('ingest').status, 0)
    const before = cli('search', 'eight shards').stdout
    assert.match(before, /^ +\| we chose \*\*eight\*\* \*\*shards\*\*/m) // a result line, not the echoed query
    // "The next version": same formats, new package number. The store is updated in place, not rebuilt, and answers the same.
    const db = join(data, 'graph.db')
    assert.equal(storeFormat(db), STORE_FORMAT)
    const r = cli('ingest')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /nothing new/)
    assert.equal(cli('search', 'eight shards').stdout, before)
    // A config from before versions existed (no "version" key) still loads.
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
    delete cfg.version
    writeFileSync(join(data, 'config.json'), JSON.stringify(cfg))
    const loaded = loadConfigSafe(h)
    assert.deepEqual(loaded.errors, [])
    assert.ok(loaded.config)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('R-B3: a newer store or config is refused with a message and nothing is changed', () => {
  const { h, data, cli } = home()
  try {
    assert.equal(cli('setup', '--yes', '--no-sync').status, 0)
    assert.equal(cli('archive').status, 0)
    assert.equal(cli('ingest').status, 0)
    const db = join(data, 'graph.db')
    const d = new DatabaseSync(db)
    d.prepare("UPDATE meta SET value = ? WHERE key = 'format'").run(String(STORE_FORMAT + 1))
    d.close()
    const bytes = readFileSync(db)
    const r = cli('ingest')
    assert.notEqual(r.status, 0)
    assert.match(r.stdout + r.stderr, /newer Thenwise.*Update Thenwise/)
    assert.deepEqual(readFileSync(db), bytes)

    const file = join(data, 'config.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    cfg.version = CONFIG_VERSION + 1
    writeFileSync(file, JSON.stringify(cfg))
    const text = readFileSync(file, 'utf8')
    const r2 = cli('ingest')
    assert.notEqual(r2.status, 0)
    assert.match(r2.stdout + r2.stderr, /newer than this Thenwise.*Update Thenwise/)
    assert.equal(readFileSync(file, 'utf8'), text)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

// R-B4: nothing in what ships may carry the owner's data.
const OWNER = [/\/Users\/dheeraj/i, /\/home\/dheeraj/i, /carapace-private/i, /carapace-crew/i, /\.memory\/eval/, /claude mods/i, /iCloud~md~obsidian/]
// The author's name is allowed only where a licence, a manifest or a repo URL names the author.
const NAME_OK = new Set(['LICENSE', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'])
const NAME = /dheeraj|ponnaganti/i

function scanDir(dir: string, label: string): string[] {
  const hits: string[] = []
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const full = join(e.parentPath, e.name)
    const rel = full.slice(dir.length + 1).replace(/\\/g, '/')
    const text = readFileSync(full, 'latin1')
    for (const re of OWNER) if (re.test(text)) hits.push(`${label}: ${rel} matches ${re}`)
    if (NAME.test(text) && !NAME_OK.has(rel.replace(/^package\//, ''))) hits.push(`${label}: ${rel} names the author`)
  }

  return hits
}

test('R-B4: the npm tarball and the release tree hold no owner data', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-scan-'))
  try {
    // Tarball: pack builds dist first (prepack).
    const name = execFileSync('npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop()!
    const out = join(tmp, 'x')
    mkdirSync(out)
    execFileSync('tar', ['-xzf', join(tmp, name), '-C', out])
    assert.deepEqual(scanDir(out, 'tarball'), [])

    // Release tree: tracked files that scripts/release-branch.mjs keeps, plus dist.
    const skip = ['test', 'bench', 'fixtures', 'docs', 'scripts', '.github']
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !skip.includes(f.split('/')[0]!))
    const tree = join(tmp, 'tree')
    for (const f of tracked) {
      mkdirSync(join(tree, f, '..'), { recursive: true })
      writeFileSync(join(tree, f), readFileSync(join(ROOT, f)))
    }
    mkdirSync(join(tree, 'dist'))
    execFileSync(process.execPath, ['-e', `require('fs').cpSync(${JSON.stringify(join(out, 'package/dist'))}, ${JSON.stringify(join(tree, 'dist'))}, {recursive:true})`])
    assert.deepEqual(scanDir(tree, 'release'), [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
