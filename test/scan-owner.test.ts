import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const scan = (dir: string) => spawnSync(process.execPath, [resolve('scripts/scan-owner.mjs'), '--dir', dir], { encoding: 'utf8' })

test('the owner-data scan passes clean files and the public handle, and flags private paths and eval data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-scan-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs/a.md'), 'See https://github.com/dheerajponnaganti/thenwise and npm.\n')
    assert.equal(scan(dir).status, 0)

    writeFileSync(join(dir, 'docs/b.md'), `cloned from ${['carapace', 'private'].join('-')}\n`) // built here, so this file stays clean
    mkdirSync(join(dir, 'bench'), { recursive: true })
    writeFileSync(join(dir, 'bench/answers-r1.jsonl'), '{}\n')
    const r = scan(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /docs\/b\.md: matches/)
    assert.match(r.stderr, /bench\/answers-r1\.jsonl: eval or chat data/)
    assert.doesNotMatch(r.stderr, /docs\/a\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shields.io GitHub badge is a repo URL, and the name in prose is still flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-scan-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs/a.md'), '<img src="https://img.shields.io/github/v/release/dheerajponnaganti/thenwise-hub?label=version">\n<img src="https://img.shields.io/github/actions/workflow/status/dheerajponnaganti/thenwise/ci.yml">\n')
    assert.equal(scan(dir).status, 0, scan(dir).stderr)
    writeFileSync(join(dir, 'docs/b.md'), `Written by ${['Dhee', 'raj'].join('')}.\n`) // built here, so this file stays clean
    const r = scan(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /docs\/b\.md: names the author outside a repo URL/)
    assert.doesNotMatch(r.stderr, /docs\/a\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
