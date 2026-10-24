// Benchmark runner (spec 09 §1). Retrieval-only: no model calls, so it is free and repeatable.
// Usage: node bench/run.ts [--vault fixtures/vault-sample] [--questions fixtures/questions.jsonl] [--label phase0] [--backend files|sqlite]
// With --backend sqlite, B3 runs against a SQLite store built from the same vault (B2 still greps the files).

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { estTokens, pointerBlock, pointerLine } from '../src/core/pointer.ts'
import { queryTerms } from '../src/core/tokenize.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { importVault } from '../src/store-sqlite/import.ts'
import { SqliteStore } from '../src/store-sqlite/sqlite-store.ts'

interface Question {
  id: string
  kind: 'lookup' | 'why' | 'multi_hop' | 'temporal' | 'action' | 'negative'
  question: string
  action: { path: string } | null
  gold: string[]
  acceptable: string[]
  must_not: string[]
  as_of: string | null
  answer: string
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const vaultDir = resolve(arg('vault', 'fixtures/vault-sample'))
const questionsFile = resolve(arg('questions', 'fixtures/questions.jsonl'))
const backend = arg('backend', 'files')
const label = arg('label', backend === 'files' ? 'phase0' : `phase0-${backend}`)
const TOP = 5

const store = new FilesStore(nodeIO, vaultDir, null)
const opened = await store.open()
const idx = store.index
const questions: Question[] = (await nodeIO.readText(questionsFile))!
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Question)

// Raw text of every note, for the grep baseline and for "cost of reading a note".
const raw = new Map<string, string>()
for (const path of idx.byPath.keys()) raw.set(path, (await nodeIO.readText(`${vaultDir}/${path}`)) ?? '')
const idOfPath = (p: string) => {
  const n = idx.byPath.get(p)

  return n ? idx.idOf(n) : null
}
const pathOfId = (id: string) => idx.byId.get(id)?.path ?? id
const sqlite = backend === 'sqlite' ? new SqliteStore(':memory:') : null
if (sqlite) importVault(sqlite, Object.fromEntries(await Promise.all([...idx.byPath.keys()].map(async p => [p, (await nodeIO.readText(`${vaultDir}/${p}`)) ?? '']))))

const datasetErrors: string[] = []
for (const q of questions) for (const p of [...q.gold, ...q.acceptable, ...q.must_not]) if (!idx.byPath.has(p)) datasetErrors.push(`${q.id}: no file ${p}`)

interface Run {
  ranked: { path: string; score: number }[]
  tokensSent: number
  ms: number
}

/** B3: our lexical retrieval with status rules (search returns ids; we compare by path). */
async function b3(q: Question): Promise<Run> {
  const text = q.action ? q.action.path : q.question
  const t0 = performance.now()
  const hits = sqlite ? await sqlite.search({ text, limit: TOP, includeInbox: true }) : idx.search(text, { limit: TOP, includeInbox: true })
  const ms = performance.now() - t0
  const recs = sqlite ? await sqlite.getMany(hits.map(h => h.id)) : null
  const lines = hits.map(h => pointerLine(recs ? recs.get(h.id)! : idx.byId.get(h.id)!, h, h.id))

  return { ranked: hits.map(h => ({ path: recs ? recs.get(h.id)!.path : pathOfId(h.id), score: h.score })), tokensSent: estTokens(pointerBlock(lines, 'project')), ms }
}

/**
 * B2 proxy: what an agent's grep surfaces. Files containing more distinct query terms rank first,
 * ties by path. This stands in for "index note + Grep" without model calls (see the report's caveats).
 */
async function b2(q: Question): Promise<Run> {
  const text = q.action ? q.action.path : q.question
  const terms = queryTerms(text)
  const t0 = performance.now()
  const scored: { path: string; score: number }[] = []
  for (const [path, body] of raw) {
    const lower = body.toLowerCase()
    let n = 0
    for (const t of terms) if (lower.includes(t)) n++
    if (n > 0) scored.push({ path, score: n })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  return { ranked: scored.slice(0, TOP), tokensSent: 0, ms: performance.now() - t0 }
}

interface Row {
  q: Question
  run: Run
}

function metrics(rows: Row[], usesPointers: boolean) {
  const answerable = rows.filter(r => r.q.gold.length > 0)
  const negative = rows.filter(r => r.q.gold.length === 0)
  const rankOfGold = (r: Row) => r.run.ranked.findIndex(x => r.q.gold.includes(x.path))
  const recall = (k: number) => answerable.filter(r => {
    const i = rankOfGold(r)

    return i >= 0 && i < k
  }).length / Math.max(1, answerable.length)
  const mrr = answerable.reduce((s, r) => s + (rankOfGold(r) >= 0 ? 1 / (rankOfGold(r) + 1) : 0), 0) / Math.max(1, answerable.length)
  let sent = 0
  let wrong = 0
  for (const r of answerable) {
    for (const x of r.run.ranked) {
      sent++
      if (!r.q.gold.includes(x.path) && !r.q.acceptable.includes(x.path)) wrong++
    }
  }
  const mustNot = rows.filter(r => r.q.must_not.length > 0)
  const mustNotHit = mustNot.filter(r => r.run.ranked.some(x => r.q.must_not.includes(x.path))).length
  // Tokens to answer (proxy): pointers sent, then reading notes in rank order until the first gold note.
  const tokensToAnswer = answerable.map(r => {
    const i = rankOfGold(r)
    const readUpTo = i >= 0 ? i + 1 : r.run.ranked.length
    const read = r.run.ranked.slice(0, readUpTo).reduce((s, x) => s + estTokens(raw.get(x.path) ?? ''), 0)

    return (usesPointers ? r.run.tokensSent : 0) + read
  })
  const sorted = [...tokensToAnswer].sort((a, b) => a - b)
  const lat = rows.map(r => r.run.ms).sort((a, b) => a - b)
  const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0

  return {
    questions: rows.length,
    answerable: answerable.length,
    recall1: recall(1),
    recall3: recall(3),
    recall5: recall(5),
    mrr,
    wrongInjection: wrong / Math.max(1, sent),
    mustNotRate: mustNot.length ? mustNotHit / mustNot.length : null,
    silenceAtZero: negative.filter(r => r.run.ranked.length === 0).length / Math.max(1, negative.length),
    tokensToAnswerMean: tokensToAnswer.reduce((s, x) => s + x, 0) / Math.max(1, tokensToAnswer.length),
    tokensToAnswerP50: pct(sorted, 50),
    tokensSentMean: rows.reduce((s, r) => s + r.run.tokensSent, 0) / Math.max(1, rows.length),
    latencyP50Ms: pct(lat, 50),
    latencyP95Ms: pct(lat, 95),
  }
}

const valid = questions.filter(q => ![...q.gold, ...q.acceptable, ...q.must_not].some(p => !idx.byPath.has(p)))
const systems = { B2_grep_proxy: { fn: b2, pointers: false }, B3_lexical: { fn: b3, pointers: true } }
const kinds = ['lookup', 'why', 'multi_hop', 'temporal', 'action', 'negative'] as const
const results: Record<string, Record<string, ReturnType<typeof metrics>>> = {}
const perQuestion: Record<string, { id: string; kind: string; top: string[]; goldRank: number }[]> = {}
const runsBySystem: Record<string, Row[]> = {}
for (const [name, sys] of Object.entries(systems)) {
  const rows: Row[] = []
  for (const q of valid) rows.push({ q, run: await sys.fn(q) })
  runsBySystem[name] = rows
  results[name] = { all: metrics(rows, sys.pointers) }
  for (const k of kinds) results[name]![k] = metrics(rows.filter(r => r.q.kind === k), sys.pointers)
  perQuestion[name] = rows.map(r => ({ id: r.q.id, kind: r.q.kind, top: r.run.ranked.map(x => x.path), goldRank: r.run.ranked.findIndex(x => r.q.gold.includes(x.path)) }))
}

// Threshold sweep for B3: below tau, send nothing (spec 05 §6 step 5). Tunes Phase 3.
const b3rows = runsBySystem.B3_lexical!
const taus = [0, 1, 2, 4, 6, 8, 10, 12, 15, 20]
const sweep = taus.map(tau => {
  const kept = (r: Row) => (r.run.ranked[0]?.score ?? 0) >= tau
  const ans = b3rows.filter(r => r.q.gold.length > 0)
  const neg = b3rows.filter(r => r.q.gold.length === 0)
  const r3 = ans.filter(r => kept(r) && r.run.ranked.slice(0, 3).some(x => r.q.gold.includes(x.path))).length / Math.max(1, ans.length)
  let sent = 0
  let wrong = 0
  for (const r of b3rows) {
    if (!kept(r)) continue
    for (const x of r.run.ranked) {
      sent++
      if (!r.q.gold.includes(x.path) && !r.q.acceptable.includes(x.path)) wrong++
    }
  }

  return { tau, recall3: r3, silence: neg.filter(r => !kept(r)).length / Math.max(1, neg.length), wrongInjection: wrong / Math.max(1, sent) }
})

const report = {
  label,
  date: new Date().toISOString(),
  backend,
  vault: vaultDir,
  index: { ...opened, stats: idx.stats() },
  datasetErrors,
  questionsUsed: valid.length,
  results,
  thresholdSweepB3: sweep,
  perQuestion,
}

const outDir = resolve('bench/out')
await mkdir(outDir, { recursive: true })
await writeFile(`${outDir}/${label}.json`, JSON.stringify(report, null, 2))

const f = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3))
const lines = [
  `# Benchmark ${label}`,
  '',
  `Date ${report.date}. B3 backend: ${backend}. Vault: ${opened.files} notes, ${report.index.stats.edges} edges, ${report.index.stats.hubs} hubs. Questions used: ${valid.length} of ${questions.length}${datasetErrors.length ? ` (${datasetErrors.length} dataset errors)` : ''}.`,
  '',
  '| System | Kind | n | R@1 | R@3 | R@5 | MRR | wrong inj. | must-not | tokens to answer (mean) | sent (mean) | p95 ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
]
for (const [name, byKind] of Object.entries(results)) {
  for (const [k, m] of Object.entries(byKind)) {
    lines.push(`| ${name} | ${k} | ${m.questions} | ${f(m.recall1)} | ${f(m.recall3)} | ${f(m.recall5)} | ${f(m.mrr)} | ${f(m.wrongInjection)} | ${f(m.mustNotRate)} | ${Math.round(m.tokensToAnswerMean)} | ${Math.round(m.tokensSentMean)} | ${m.latencyP95Ms.toFixed(2)} |`)
  }
}
lines.push('', '## B3 threshold sweep (send nothing when the top score is below tau)', '', '| tau | R@3 (answerable) | silence on negatives | wrong injection |', '| --- | --- | --- | --- |')
for (const s of sweep) lines.push(`| ${s.tau} | ${f(s.recall3)} | ${f(s.silence)} | ${f(s.wrongInjection)} |`)
lines.push(
  '',
  '## Caveats',
  '',
  '- Retrieval only; no model was called. "Tokens to answer" is a proxy: pointer lines sent, plus reading notes in rank order until the first gold note.',
  '- B2 is a grep proxy (files ranked by how many distinct query terms they contain). A real agent would also read the index note and choose files with judgment, so B2 here is a floor for "index plus Grep", not its true value.',
  '- The fixture is synthetic and written by a model; results on real vaults may differ (the private set checks this).',
  '- "Wrong injection" counts every top-5 result that is neither gold nor acceptable; for B2 nothing is injected, so read it as "wrong files surfaced".',
)
if (datasetErrors.length) lines.push('', '## Dataset errors', '', ...datasetErrors.map(e => `- ${e}`))
await writeFile(`${outDir}/${label}.md`, lines.join('\n') + '\n')
console.log(lines.slice(0, 6 + Object.keys(results).length * 7).join('\n'))
console.log(`\nwrote bench/out/${label}.md and .json`)
