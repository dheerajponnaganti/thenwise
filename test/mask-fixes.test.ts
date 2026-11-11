import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { MASK } from '../src/core/secrets.ts'
import { archive } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { loadPrInputs } from '../src/ingest/ingest.ts'
import { fullNode, isMarked, parseLog, prPart } from '../src/ingest/parts.ts'
import { fetchPrs } from '../src/ingest/prs.ts'

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const row = (n: string, text: string) => JSON.stringify({ type: 'user', uuid: n, timestamp: '2026-10-02T10:00:00Z', cwd: '/x', sessionId: n, entrypoint: 'cli', message: { role: 'user', content: text } })

function world() {
  const home = mkdtempSync(join(tmpdir(), 'tw-maskfix-'))
  mkdirSync(join(home, '.memory'), { recursive: true })
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: ['/x'] } }))
  const dir = join(home, '.claude/projects/-x')
  mkdirSync(dir, { recursive: true })

  return { home, dir, cfg: loadConfig(home) }
}

test('gap 1: every stored record is masked at fullNode, ids stay as they are', () => {
  const n = fullNode({ id: 'commit:abc1234', kind: 'commit', title: `fix ${KEY}`, text: `body\nAPI_TOKEN=${'x'.repeat(20)}` })
  assert.ok(n.title.includes(MASK) && n.text.includes(MASK) && !n.text.includes('xxxx'))
  assert.equal(n.id, 'commit:abc1234')
})

test('gap 1 and 41: the PR cache is rewritten masked after a mask bump', () => {
  const { cfg } = world()
  const file = join(cfg.memDir, 'prs-cache.json')
  mkdirSync(cfg.memDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ 'me/p': { fetchedAt: Date.now(), tried: Date.now(), error: '', prs: [{ number: 1, title: 'x', body: `key ${KEY}` }] } }))
  chmodSync(file, 0o600)
  assert.equal(fetchPrs({ ...cfg, prs: true }, []).lines.length, 0)
  assert.ok(!readFileSync(file, 'utf8').includes(KEY))
  assert.ok(readFileSync(file, 'utf8').includes(MASK))
})

test('gap 2: a mask bump re-reads the original so eaten words come back; gap 35: a bad file does not stop the run', () => {
  const { home, dir, cfg } = world()
  writeFileSync(join(dir, 'a.jsonl'), `${row('a', 'the token expiration is short')}\n`)
  archive(cfg)
  const gz = join(cfg.memDir, 'archive/sessions/-x/a.jsonl.gz')
  // Simulate an older mask that ate the word.
  const mf = join(cfg.memDir, 'archive/manifest.json')
  const man = JSON.parse(readFileSync(mf, 'utf8'))
  man['-x/a.jsonl'].mask = 4
  writeFileSync(mf, JSON.stringify(man))
  assert.equal(archive(cfg).remasked, 1)
  assert.ok(gunzipSync(readFileSync(gz)).toString().includes('token expiration'))
  // A directory named like a chat makes readFileSync throw: counted, the rest still archived, manifest written.
  mkdirSync(join(dir, 'bad.jsonl'))
  writeFileSync(join(dir, 'b.jsonl'), `${row('b', 'hello')}\n`)
  const r = archive(cfg)
  assert.equal(r.archived, 1)
  assert.equal(r.failed.length, 0) // directories are skipped by the walker, so force a real failure below
  chmodSync(join(dir, 'b.jsonl'), 0)
  writeFileSync(join(dir, 'c.jsonl'), `${row('c', 'hi')}\n`)
  const r2 = archive(cfg)
  chmodSync(join(dir, 'b.jsonl'), 0o600)
  assert.ok(r2.archived >= 1)
  assert.ok(JSON.parse(readFileSync(mf, 'utf8'))['-x/c.jsonl'])
  void home
})

test('gap 30: markers match the start or end of the first prompt, or a whole line, not a mention', () => {
  const m = ['[memory-eval]']
  assert.ok(isMarked(m, ['[memory-eval] what is x']))
  assert.ok(isMarked(m, ['what is x [memory-eval]']))
  assert.ok(isMarked(m, ['hi', 'text\n[memory-eval]\nmore']))
  assert.ok(!isMarked(m, ['hi', 'the flag [memory-eval] is documented in the readme']))
})

test('GHSA-84q4 item 4: commit trailers, dead ends and a --prs file are stored masked', () => {
  // Two commits as `git log` gives them to parseLog: a Decision: and Why: body, and a revert whose subject holds the key.
  const raw = `\x1e${'a1'.repeat(20)}\x1f2026-10-02T10:00:00Z\x1fSwitch the deploy key\x1fDecision: deploy with ${KEY}\nWhy: DB_PASSWORD=correcthorse9 was shared\x1d\nsrc/a.ts\n`
    + `\x1e${'b2'.repeat(20)}\x1f2026-10-03T10:00:00Z\x1fRevert "use ${KEY}"\x1f\x1d\nsrc/a.ts\n`
  const recs = parseLog(raw, '/r/proj')
  assert.ok(recs[0]!.node.extra.trailers && recs[1]!.node.extra.deadEnd)
  for (const r of recs) assert.ok(!/a1B2c3D4e5|correcthorse9/.test(JSON.stringify(r.node)), JSON.stringify(r.node.extra))
  const { cfg } = world()
  const file = join(cfg.home, 'prs.json')
  writeFileSync(file, JSON.stringify([{ number: 9, title: `use ${KEY}`, body: 'b', state: 'CLOSED', mergedAt: null, headRefName: `fix/${KEY}`, createdAt: '2026-10-04T00:00:00Z', files: [], comments: [] }]))
  const inputs = loadPrInputs(cfg, { prs: file }, [], [])
  assert.ok(!JSON.stringify(inputs).includes('a1B2c3D4e5'), JSON.stringify(inputs))
  const pr = prPart([{ full: 'me/proj', list: [{ number: 9, title: `use ${KEY}`, state: 'CLOSED', headRefName: `fix/${KEY}`, createdAt: '2026-10-04T00:00:00Z' }] }], [], { id: () => undefined, repo: () => undefined })
  assert.ok(!JSON.stringify(pr.nodes).includes('a1B2c3D4e5'), JSON.stringify(pr.nodes[0]!.extra))
})
