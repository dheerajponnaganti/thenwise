import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { STORE_FORMAT, storeFormat } from '../src/ingest/ingest.ts'

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'src/cli.ts')

function home(rows: [string, string, string][]) {
  const h = mkdtempSync(join(tmpdir(), 'tw-src-'))
  const proj = join(h, '.claude', 'projects', '-work-alpha')
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(h, 'work', 'alpha'), { recursive: true })
  const lines = rows.map(([type, content, at], i) => JSON.stringify({ type, uuid: `u${i}`, timestamp: at, cwd: join(h, 'work', 'alpha'), sessionId: 's1', entrypoint: 'cli', message: { role: type, content } }))
  const file = join(proj, 's1.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  const t = new Date('2026-10-02T12:00:00Z')
  utimesSync(file, t, t)
  const data = join(h, '.thenwise')
  const env = { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: data }
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: h })
  assert.equal(cli('setup', '--yes', '--no-sync').status, 0)
  assert.equal(cli('archive').status, 0)

  return { h, data, cli }
}

test('SRE-13: an emoji is a searchable word, and an old store rebuilds once', () => {
  const { h, data, cli } = home([['user', 'the deploy mascot is a penguin 🐧', '2026-10-02T10:00:00Z'], ['assistant', 'noted', '2026-10-02T10:01:00Z']])
  try {
    assert.equal(cli('ingest').status, 0)
    assert.match(cli('search', '🐧').stdout, /penguin/)
    // A store written before the bump (format 1) is rebuilt, not refused.
    const db = new DatabaseSync(join(data, 'graph.db'))
    db.exec("UPDATE meta SET value = '1' WHERE key = 'format'")
    db.close()
    const r = cli('ingest')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(storeFormat(join(data, 'graph.db')), STORE_FORMAT)
    assert.match(cli('search', '🐧').stdout, /penguin/)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('SRE-13: a row dated far in the future is capped to the file time and status says so', () => {
  const { h, data, cli } = home([['user', 'zanzibar pelican notes', '2099-01-01T00:00:00Z'], ['assistant', 'ok', '2026-10-02T10:01:00Z']])
  try {
    assert.equal(cli('ingest').status, 0)
    const db = new DatabaseSync(join(data, 'graph.db'), { readOnly: true })
    const at = (db.prepare("SELECT at FROM nodes WHERE kind = 'turn'").get() as { at: string }).at
    db.close()
    assert.ok(at < '2027', at)
    assert.match(cli('status').stdout, /1 row was dated after its file's change time/)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})

test('SRE-08: a rebuild with too little free disk is refused and doctor warns', () => {
  const { h, data, cli } = home([['user', 'plain notes about kestrels', '2026-10-02T10:00:00Z'], ['assistant', 'ok', '2026-10-02T10:01:00Z']])
  try {
    assert.equal(cli('ingest').status, 0)
    const before = cli('search', 'kestrels').stdout
    const env = { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: data, THENWISE_FREE_BYTES: '1000' }
    const r = spawnSync(process.execPath, [CLI, 'ingest', '--full'], { env, encoding: 'utf8', cwd: h })
    assert.notEqual(r.status, 0)
    assert.match(r.stdout + r.stderr, /not enough free disk to rebuild/)
    assert.equal(cli('search', 'kestrels').stdout, before)
    const d = spawnSync(process.execPath, [CLI, 'doctor'], { env, encoding: 'utf8', cwd: h })
    assert.match(d.stdout, /^warn disk .*free, store is/m)
    assert.match(cli('doctor').stdout, /^ok {3}disk/m)
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})
