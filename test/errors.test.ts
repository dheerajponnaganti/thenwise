import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const run = (data: string, ...args: string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'tw-err-'))
  return spawnSync(process.execPath, [resolve('src/cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, THENWISE_HOME: data } })
}
const oneLine = (r: { status: number | null; stderr: string }, re: RegExp) => {
  assert.equal(r.status, 1)
  assert.match(r.stderr, re)
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace')
}

test('S1-B5: a data folder that cannot be made gives one line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-ro-'))
  chmodSync(dir, 0o500)
  oneLine(run(join(dir, 'data'), 'ingest'), /^thenwise: .*(setup|permissions)/m)
  chmodSync(dir, 0o700)
})

test('S1-B6: a data folder path that is a file gives one line', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tw-file-')), 'afile')
  writeFileSync(file, '')
  oneLine(run(file, 'ingest'), /must be a folder/)
})

test('S1-B9: a damaged store says how to rebuild it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-bad-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.db'), Buffer.alloc(5000, 7))
  oneLine(run(dir, 'search', 'cache'), /damaged.*thenwise ingest/)
})
