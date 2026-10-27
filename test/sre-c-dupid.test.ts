import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { forget } from '../src/privacy/forget.ts'
import { loadConfigSafe } from '../src/ingest/config.ts'

const CLI = join(new URL('..', import.meta.url).pathname, 'src/cli.ts')

// Two project folders, one session id (same uuids too, as a copied folder has).
function world() {
  const h = mkdtempSync(join(tmpdir(), 'tw-dup-'))
  mkdirSync(join(h, 'work', 'x'), { recursive: true })
  for (const [folder, at, word] of [['p5', '2026-10-02T10:00:00Z', 'one'], ['p6', '2026-10-03T10:00:00Z', 'two']] as const) {
    const d = join(h, '.claude', 'projects', folder)
    mkdirSync(d, { recursive: true })
    const row = (type: string, content: unknown) => JSON.stringify({ type, uuid: `s9-${type}`, timestamp: at, cwd: join(h, 'work', 'x'), sessionId: 's9', entrypoint: 'cli', message: { role: type, content } })
    writeFileSync(join(d, 's9.jsonl'), `${row('user', `dup session ${word} crane`)}\n${row('assistant', 'ok noted')}\n`)
  }
  const data = join(h, '.thenwise')
  const env = { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: data }
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: h })
  assert.equal(cli('setup', '--yes', '--no-sync').status, 0)
  assert.equal(cli('archive').status, 0)

  return { h, data, cli }
}

test('SRE-06: two chats with one session id are both found, named in ingest and status, and forget takes a folder', async () => {
  const { h, data, cli } = world()
  const prev = { HOME: process.env.HOME, THENWISE_HOME: process.env.THENWISE_HOME }
  try {
    const r = cli('ingest')
    assert.match(r.stdout + r.stderr, /2 chats share the session id s9/)
    assert.match(cli('search', 'two', '--all').stdout, /dup session \*\*two\*\*/)
    assert.match(cli('search', 'one', '--all').stdout, /dup session \*\*one\*\*/)
    const db = new DatabaseSync(join(data, 'graph.db'), { readOnly: true })
    const ids = (db.prepare("SELECT id FROM nodes WHERE kind = 'session' ORDER BY id").all() as { id: string }[]).map((x) => x.id)
    db.close()
    assert.deepEqual(ids, ['ses:s9', 'ses:s9@p6'])
    assert.match(cli('status').stdout, /1 chat shares a session id/)
    assert.match(cli('get', 'ses:s9@p6').stdout, /dup session two crane/)
    assert.match(cli('trace', 'ses:s9@p6').stdout, /s9@p6|two/)

    // The bare id is ambiguous.
    process.env.HOME = h
    process.env.THENWISE_HOME = data
    const cfg = loadConfigSafe(h).config!
    const lines: string[] = []
    assert.equal(await forget(cfg, 's9', { yes: true, print: (l) => lines.push(l), rewriteVault: () => {} }), 1)
    assert.match(lines.join('\n'), /s9@p5, s9@p6/)
    assert.ok(existsSync(join(data, 'archive/sessions/p5/s9.jsonl.gz')))
    // One folder picked: the other chat stays, now and after the next sync.
    assert.equal(await forget(cfg, 's9@p6', { yes: true, print: () => {}, rewriteVault: () => {} }), 0)
    assert.ok(!existsSync(join(data, 'archive/sessions/p6/s9.jsonl.gz')))
    assert.equal(cli('archive').status, 0)
    assert.equal(cli('ingest').status, 0)
    assert.ok(!existsSync(join(data, 'archive/sessions/p6/s9.jsonl.gz')))
    assert.match(cli('search', 'one', '--all').stdout, /dup session \*\*one\*\*/)
    assert.doesNotMatch(cli('search', 'two', '--all').stdout, /dup session \*\*two\*\*/)
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    rmSync(h, { recursive: true, force: true })
  }
})
