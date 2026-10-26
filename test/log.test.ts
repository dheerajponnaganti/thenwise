import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { errorCode, formatEvent, logFile, logger, MAX_BYTES, readLog, recentErrors, redact, since } from '../src/core/log.ts'
import { createServer } from '../src/server/stdio.ts'
import { tempDir } from './mcp-fixture.ts'

delete process.env.THENWISE_LOG

test('log writes one masked JSON line per event, at or above the level', () => {
  const dir = tempDir()
  const log = logger('mcp', dir)
  log.info('tool_ok', { tool: 'memory_search', ms: 4 })
  log.debug('hidden')
  process.env.THENWISE_LOG = 'off'
  log.error('hidden too')
  delete process.env.THENWISE_LOG
  log.error('tool_failed', { err: 'auth failed for token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
  const evs = readLog(dir)
  assert.deepEqual(evs.map((e) => e.ev), ['tool_ok', 'tool_failed'])
  assert.equal(evs[0]!.c, 'mcp')
  assert.doesNotMatch(String(evs[1]!.err), /ghp_/)
  assert.equal(statSync(logFile(dir)).mode & 0o777, 0o600)
  process.env.THENWISE_LOG = 'debug'
  log.debug('shown')
  delete process.env.THENWISE_LOG
  assert.equal(readLog(dir).at(-1)!.ev, 'shown')
})

test('log rotates at 1 MB and keeps 3 old files', () => {
  const dir = tempDir()
  const log = logger('sync', dir)
  log.info('first')
  for (let i = 0; i < 5; i++) {
    writeFileSync(logFile(dir), `${'x'.repeat(MAX_BYTES)}\n`)
    log.info('after', { i })
  }
  assert.ok(existsSync(logFile(dir).replace('.log', '.3.log')))
  assert.ok(!existsSync(logFile(dir).replace('.log', '.4.log')))
  assert.ok(statSync(logFile(dir)).size < 1000)
})

test('a log folder that cannot be written never throws', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'logs'), 'a file where the folder should be')
  assert.doesNotThrow(() => logger('cli', dir).error('failed'))
  if (process.platform !== 'win32') {
    const ro = tempDir()
    chmodSync(ro, 0o500)
    assert.doesNotThrow(() => logger('cli', ro).error('failed'))
    chmodSync(ro, 0o700)
  }
})

test('redact, error codes, since and the readable line', () => {
  assert.equal(redact('fts5: syntax error near "exporter shards"', ['exporter shards']), 'fts5: syntax error near "…"')
  assert.doesNotMatch(redact('no such column: shards', ['why exporter shards']), /shards/)
  assert.match(errorCode('memory_search', 'boom'), /^E[0-9A-F]{3}$/)
  assert.equal(errorCode('memory_search', 'boom'), errorCode('memory_search', 'boom'))
  assert.equal(since('2h', 10_000_000), 10_000_000 - 7_200_000)
  assert.throws(() => since('soon'))
  assert.equal(formatEvent({ t: '2026-10-26T10:00:00.000Z', lvl: 'error', c: 'mcp', ev: 'tool_failed', code: 'E4F2', err: 'a b', pid: 1 }), '2026-10-26 10:00:00 ERROR mcp tool_failed code=E4F2 err="a b"')
})

test('a failing tool logs its stack and error code without the query, and Claude sees the same code', () => {
  const dir = tempDir()
  process.env.THENWISE_HOME = dir
  after(() => delete process.env.THENWISE_HOME)
  writeFileSync(join(dir, 'graph.db'), 'not a database at all')
  const s = createServer(() => join(dir, 'graph.db'))
  s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const r = s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'secret project codename' } } }) as any
  const said = r.result.content[0].text as string
  const code = /error (E[0-9A-F]{3})/.exec(said)?.[1]
  const failed = readLog(dir).find((e) => e.ev === 'tool_failed')!
  assert.ok(code)
  assert.equal(failed.code, code)
  assert.ok(failed.stack)
  assert.doesNotMatch(readFileSync(logFile(dir), 'utf8'), /codename|secret project/)
  assert.match(recentErrors(dir), /^1 error in the last 24 hours, newest: .*tool_failed/)
})
