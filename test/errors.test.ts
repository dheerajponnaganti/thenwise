import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { World } from './world.ts'

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

test('--help and --version print to stdout and exit 0', () => {
  const data = mkdtempSync(join(tmpdir(), 'tw-flags-'))
  const h = run(data, '--help')
  assert.equal(h.status, 0)
  assert.match(h.stdout, /^usage: thenwise/)
  const v = run(data, '--version')
  assert.equal(v.status, 0)
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/)
})

/** A real store, made by ingest, then cut short: SQLite reads its first page and fails further in. */
function damagedStore(dir: string): string {
  const home = mkdtempSync(join(tmpdir(), 'tw-dmg-'))
  const file = join(dir, 'other.db')
  spawnSync(process.execPath, [resolve('src/cli.ts'), 'ingest', '--db', file], { encoding: 'utf8', env: { ...process.env, HOME: home, THENWISE_HOME: join(home, '.thenwise') } })
  truncateSync(file, 4096)
  return file
}

test('#75: a database error names the file that cannot be read, with advice that fits it, whatever --db says', () => {
  const data = mkdtempSync(join(tmpdir(), 'tw-db-'))
  // A --db file that is no store at all: named, and nothing about the store in the data folder, which is fine.
  const notes = join(data, 'notes.txt')
  writeFileSync(notes, 'not a store')
  let r = run(data, 'search', '--db', notes, 'walrus')
  oneLine(r, /notes\.txt cannot be read as a Thenwise store\. If it is one, it is damaged: delete it and run thenwise ingest --db .*notes\.txt to build it again/)
  assert.doesNotMatch(r.stderr, /delete graph\.db/)
  // A damaged Thenwise store given with --db gets the advice to rebuild it there, not to leave --db out.
  const other = damagedStore(data)
  r = run(data, 'search', '--db', other, 'walrus')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /other\.db cannot be read as a Thenwise store\. If it is one, it is damaged: delete it and run thenwise ingest --db/)
  // A command that does not read --db, with the data folder's store damaged: the store is named, the healthy --db file is not.
  writeFileSync(join(data, 'graph.db'), 'not a database at all')
  r = run(data, 'deadend', 'a lock deadlocks', '--db', notes.replace('notes.txt', 'none.db'))
  oneLine(r, /The store is damaged: delete graph\.db in .* and run: thenwise ingest\./)
  assert.doesNotMatch(r.stderr, /none\.db/)
})

test('#75: a damaged team chat cache is named as the cache, to delete and fetch again', () => {
  const data = mkdtempSync(join(tmpdir(), 'tw-cache-'))
  writeFileSync(join(data, 'team-chats.db'), 'not a database at all')
  const r = run(data, 'ingest')
  oneLine(r, /The team chat cache .*team-chats\.db is damaged: delete it, and the next team sync fetches the chats again\./)
  assert.doesNotMatch(r.stderr, /delete graph\.db/)
})

test('#104: piped output longer than 64 KB arrives whole', () => {
  const w = new World()
  try {
    w.chat('s1', { turns: [{ prompt: `walrus ${'tusk '.repeat(40_000)}`, at: '2026-10-12T10:00:00Z' }] })
    w.archive()
    w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
    // spawnSync reads stdout through a pipe, like the agent's Bash tool, and get prints one large string, then exits.
    const r = spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'get', 'turn:s1-0'], { cwd: w.proj, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    assert.equal(r.status, 0)
    assert.ok(r.stdout.length > 200_000, `${r.stdout.length} characters arrived`)
  } finally {
    w.destroy()
  }
})
