// The memory command end to end: import a vault into Postgres, make a token, serve, and call the server.

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'

import { pgSkip } from './pg-cluster.ts'
import { pgFixture } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

const run = promisify(execFile)
const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const VAULT = new URL('../fixtures/vault-sample', import.meta.url).pathname

test('the Files commands still work', async () => {
  const { stdout } = await run('node', [CLI, 'stats', VAULT])
  assert.equal(JSON.parse(stdout).notes, 100)
  await assert.rejects(run('node', [CLI]), (e: { code?: number }) => e.code === 2)
  await assert.rejects(run('node', [CLI, 'serve', '--scope', 'project:x']), (e: { code?: number }) => e.code === 2, 'serve needs a database url')
  await assert.rejects(run('node', [CLI, 'import', VAULT, '--postgres', 'postgres://x', '--scope', 'nonsense']), (e: { code?: number }) => e.code === 2)
})

describe('memory import and serve against Postgres', { skip: pgSkip }, () => {
  let fx: PgFixture
  before(async () => {
    fx = await pgFixture()
  })
  after(() => fx?.stop())

  test('import, token, serve', async () => {
    const db = await fx.fresh()
    try {
      const c = fx.cluster.config(db.db)
      const url = `postgres://postgres@/${db.db}?host=${encodeURIComponent(String(c.host))}&port=${c.port}`
      const scope = ['--postgres', url, '--scope', 'project:cli']
      const imp = await run('node', [CLI, 'import', VAULT, ...scope])
      assert.match(imp.stdout, /100 files read, 100 notes and 500 edges loaded into project:cli \(0 links unresolved\)/)
      const again = await run('node', [CLI, 'import', VAULT, ...scope])
      assert.match(again.stdout, /100 notes/, 'importing twice updates in place')
      assert.equal(Number((await db.pool.query('select count(*) as n from nodes')).rows[0].n), 100)
      const token = (await run('node', [CLI, 'token', 'create', 'alice', ...scope])).stdout.trim()
      assert.match(token, /^mv2_/)

      const child = spawn('node', [CLI, 'serve', ...scope, '--port', '0', '--mcp'], { stdio: ['ignore', 'pipe', 'inherit'] })
      try {
        const base = await new Promise<string>((resolve, reject) => {
          let out = ''
          child.stdout.on('data', d => {
            out += d
            const m = /listening on (http:\/\/\S+)/.exec(out)
            if (m) resolve(m[1]!)
          })
          child.once('exit', code => reject(new Error(`serve exited with ${code}`)))
        })
        assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, 'binds to loopback by default')
        assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', body: '{"text":"offline queue"}' })).status, 401)
        const res = await fetch(`${base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'offline queue operations' }) })
        assert.equal(res.status, 200)
        const json = (await res.json()) as { results: { title: string }[] }
        assert.ok(json.results.length > 0)
        assert.ok(json.results.some(r => /offline queue/i.test(r.title)))
        const rpc = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
        assert.equal(((await rpc.json()) as any).result.tools.length, 3)
        await run('node', [CLI, 'token', 'revoke', token, ...scope])
        assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"text":"x"}' })).status, 401)
      } finally {
        child.kill('SIGTERM')
        await new Promise(r => child.once('exit', r))
      }
    } finally {
      await db.close()
    }
  })
})
