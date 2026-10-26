import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openTeamDb, SCHEMA_VERSION } from '../src/teams/schema.ts'
import { backupTeam, createTeamServer, invite, listMembers, restoreTeam } from '../src/teams/server.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw16-${p}-`))

test('T16-H2: a backup restored in another folder holds the same members, notes and schema', async () => {
  const a = tmp('a')
  const app = createTeamServer({ dir: a })
  const base = `http://127.0.0.1:${(await app.listen()).port}`
  const db = openTeamDb(a)
  const token = invite(db, 'alice')
  invite(db, 'bob')
  db.close()
  await fetch(`${base}/v1/notes/n1`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': '*' }, body: JSON.stringify({ title: 'Plan', text: 'eight shards', project: 'p' }) })
  const file = join(tmp('bk'), 'team.db')
  try {
    backupTeam(a, file) // while the server runs
  } finally {
    await app.close()
  }
  // A server in another live process holds the folder: the test runner's parent stands in for it.
  writeFileSync(join(a, 'server.pid'), String(process.ppid))
  assert.throws(() => restoreTeam(a, file), /stop it first/)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const b = tmp('b')
  assert.equal(restoreTeam(b, file), SCHEMA_VERSION)
  const r = openTeamDb(b)
  assert.deepEqual(listMembers(r).map((m) => m.name), ['alice', 'bob'])
  assert.equal((r.prepare("SELECT text FROM notes WHERE id = 'n1'").get() as { text: string }).text, 'eight shards')
  assert.equal((r.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION)
  r.close()
})

test('T16-B3: a backup from a newer Thenwise is refused and nothing is written', () => {
  const file = join(tmp('new'), 'team.db')
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  const dir = tmp('dst')
  assert.throws(() => restoreTeam(dir, file), /newer Thenwise/)
  assert.throws(() => statSync(join(dir, 'team.db')))
})

test('T16-B1: a host beyond this machine is refused without TLS in front or an explicit plain-http flag', () => {
  assert.throws(() => createTeamServer({ dir: tmp('h'), host: '0.0.0.0' }), /tls-behind-proxy/)
})
