import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { CONVERT_VERSION } from '../src/ingest/archive.ts'
import { codexConverter } from '../src/ingest/codex.ts'
import { costOf, parseSession } from '../src/ingest/transcript.ts'
import { costReport } from '../src/query/cost.ts'
import { Graph } from '../src/query/engine.ts'
import { World } from './world.ts'

const costRow = (sid: string, usd: number, input: number, opts: { unknown?: boolean; start?: number } = {}) => JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: usd, startTime: opts.start ?? 1, hasUnknownModelCost: !!opts.unknown, modelUsage: { 'claude-sonnet-5-5': { inputTokens: input, outputTokens: 10, thinkingTokens: 5, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100, costUSD: usd } } })
const user = (sid: string, at: string, text = 'hi') => JSON.stringify({ type: 'user', uuid: `${sid}-${at}`, timestamp: at, cwd: '/p', sessionId: sid, entrypoint: 'cli', message: { role: 'user', content: text } })

test('a cost row gives tokens always (thinking is inside output, not added again) and dollars only when every model was priced', () => {
  assert.deepEqual(costOf(JSON.parse(costRow('s', 1.5, 200))), { usd: 1.5, input: 300, cached: 1000, output: 10 })
  assert.equal(costOf(JSON.parse(costRow('s', 1.5, 200, { unknown: true })))!.usd, undefined, 'an unpriced model leaves dollars out')
  const out = codexConverter('cx', '/p')(JSON.stringify({ timestamp: '2026-11-05T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 15000, cached_input_tokens: 11000, output_tokens: 124 } } } }))
  assert.deepEqual(costOf(JSON.parse(out[0]!)), { input: 4000, cached: 11000, output: 124 })
})

test('the running total is kept over time, dated by the line before it; a resumed run adds to it; rows past the cutoff are left out', () => {
  const s = parseSession([user('a', '2026-11-01T10:00:00Z'), costRow('a', 0.5, 10), user('a', '2026-11-03T10:00:00Z'), costRow('a', 2.25, 40)], 'a', '/h')
  assert.equal(s.cost!.usd, 2.25)
  assert.deepEqual(s.costs!.map((p) => [p[0], p[1]]), [['2026-11-01T10:00:00Z', 0.5], ['2026-11-03T10:00:00Z', 2.25]])
  // A resume restarts Claude Code's total at a new start time: the run before it still counts.
  const r = parseSession([user('b', '2026-11-01T10:00:00Z'), costRow('b', 3, 40, { start: 1 }), user('b', '2026-11-04T10:00:00Z'), costRow('b', 0.5, 10, { start: 2 })], 'b', '/h')
  assert.equal(r.cost!.usd, 3.5)
  assert.equal(r.cost!.input, 140 + 110)
  // `ingest --until` keeps nothing spent after the cutoff.
  const u = parseSession([user('c', '2026-11-01T10:00:00Z'), costRow('c', 1, 10), user('c', '2026-11-05T10:00:00Z'), costRow('c', 9, 90)], 'c', '/h', '2026-11-02T00:00:00Z')
  assert.equal(u.cost!.usd, 1)
})

test('thenwise cost counts what each chat spent in the window, by each tool\'s own record, and says what the dollars cover', () => {
  const w = new World()
  try {
    const now = Date.now()
    const at = (h: number) => new Date(now - h * 36e5).toISOString()
    // c1 ran 10 days ago ($1) and again an hour ago (to $3): the last day holds $2 of it.
    w.chat('c1', { turns: [{ prompt: 'shard the walrus cache', at: at(240) }] })
    appendFileSync(w.chatPath('c1'), `${costRow('c1', 1, 100)}\n${user('c1', at(1), 'more walrus sharding')}\n${costRow('c1', 3, 300)}\n`)
    w.chat('c2', { turns: [{ prompt: '[dead-end] a global lock deadlocks the walrus cache', at: at(2) }] })
    appendFileSync(w.chatPath('c2'), `${costRow('c2', 1, 100)}\n`)
    w.chat('c3', { turns: [{ prompt: 'copilot work', at: at(2) }], entrypoint: 'copilot-cli' })
    w.chat('c4', { turns: [{ prompt: 'an unpriced model', at: at(2) }] })
    appendFileSync(w.chatPath('c4'), `${costRow('c4', 0, 50, { unknown: true })}\n`)
    w.archive()
    const g = new Graph(w.ingest('a.db').db)
    const day = costReport(g, now - 864e5)
    assert.match(day, /: 4 chats, counting only what they spent since then$/m)
    assert.match(day, /^- Claude Code: \$3\.00 for 2 of 3 chats, /m, 'dollars say which chats they cover')
    assert.match(day, /^- Copilot: 1 chat; no cost found in its chat files$/m)
    assert.match(day, /^in chats that hit a dead end .*: \$1\.00 of \$3\.00 priced \(33%\), 1 chat$/m)
    assert.match(costReport(g, now - 30 * 864e5), /^- Claude Code: \$4\.00 for 2 of 3 chats/m, 'a wider window holds the whole cost')
    assert.match(costReport(g, now - 864e5, 'deadlocks'), /of chats about "deadlocks": 1 chat[\s\S]*\$1\.00/)
    assert.match(costReport(g, now + 864e5), /none recorded/)
  } finally {
    w.destroy()
  }
})

test('the archive converts a Codex chat again for its token counts, never onto a shorter copy, and marks it done', () => {
  const w = new World()
  const saved = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(w.home, '.codex')
  try {
    const day = join(w.home, '.codex', 'sessions', '2026', '11', '05')
    mkdirSync(day, { recursive: true })
    const row = (type: string, payload: object, ordinal: number) => JSON.stringify({ timestamp: new Date(Date.now() - 36e5).toISOString(), ordinal, type, payload })
    writeFileSync(join(day, 'rollout-cx.jsonl'), `${[
      row('session_meta', { id: 'T-cx', cwd: w.proj, source: 'cli', thread_source: 'user' }, 0),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tune the walrus cache' }] }, 1),
      row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 15000, cached_input_tokens: 11000, output_tokens: 124 } } }, 2),
    ].join('\n')}\n`)
    w.archive()
    const manifestFile = join(w.memDir, 'archive', 'manifest.json')
    const read = () => JSON.parse(readFileSync(manifestFile, 'utf8'))
    const rel = Object.keys(read()).find((k) => k.endsWith('T-cx.jsonl'))!
    const dest = join(w.memDir, 'archive', 'sessions', `${rel}.gz`)
    const text = () => gunzipSync(readFileSync(dest)).toString()
    assert.equal(read()[rel].conv, CONVERT_VERSION)
    // As an older converter left it: no converter version. One pass converts it again.
    const old = (body: string) => {
      writeFileSync(dest, gzipSync(body))
      const m = read()
      delete m[rel].conv
      m[rel].lines = body.split('\n').length - 1
      writeFileSync(manifestFile, JSON.stringify(m))
    }
    old(text().split('\n').filter((l) => !l.includes('cost-state')).join('\n'))
    assert.ok(w.archive().remasked >= 1)
    assert.match(text(), /"type":"cost-state"/)
    const g = new Graph(w.ingest('a.db').db)
    assert.match(costReport(g, Date.now() - 864e5), /^- Codex: 4k tokens in, 11k from cache, 124 out over 1 chat \(Codex records tokens, not dollars\)$/m)
    // An archived copy longer than what the source now gives holds turns the source lost: it is kept.
    const extra = (uuid: string, content: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-11-05T09:00:00Z', cwd: w.proj, sessionId: 'T-cx', message: { role: 'user', content } })
    old(`${text()}${extra('k1', 'a turn the source lost')}\n${extra('k2', 'and another')}\n`)
    w.archive()
    assert.match(text(), /a turn the source lost/)
    assert.equal(read()[rel].conv, CONVERT_VERSION, 'marked done, so it is not tried at every sync')
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
    w.destroy()
  }
})
