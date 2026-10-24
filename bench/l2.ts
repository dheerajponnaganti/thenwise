// Phase 3 gate: the prompt map (layer 2). Tuned on odd-numbered questions, reported on even-numbered ones,
// so the reported numbers were never used for tuning. Retrieval only, no model calls.
// Usage: node bench/l2.ts [--expand typed|ppr] [--label phase3]

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { estTokens } from '../src/core/pointer.ts'
import { DEFAULT_MAP, promptMap } from '../src/core/prompt-map.ts'
import type { MapOptions } from '../src/core/prompt-map.ts'
import { queryTerms } from '../src/core/tokenize.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { expanders } from '../src/core/expand.ts'

const flag = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)

  return i > 0 ? process.argv[i + 1] : undefined
}
const expandName = flag('expand') as keyof typeof expanders | undefined
const label = flag('label') ?? (expandName ? `phase4-${expandName}` : 'phase3')
const vault = resolve('fixtures/vault-sample')
const store = new FilesStore(nodeIO, vault, null)
await store.open()
interface Q { id: string; kind: string; question: string; action: { path: string } | null; gold: string[]; acceptable: string[]; must_not: string[]; as_of: string | null }
const all: Q[] = (await nodeIO.readText(resolve('fixtures/questions.jsonl')))!.split('\n').filter(Boolean).map(l => JSON.parse(l))
const num = (q: Q) => Number(q.id.slice(1))
const tune = all.filter(q => num(q) % 2 === 1)
const testSet = all.filter(q => num(q) % 2 === 0)
const raw = new Map<string, string>()
for (const p of store.index.byPath.keys()) raw.set(p, (await nodeIO.readText(`${vault}/${p}`)) ?? '')
const pathOf = (id: string) => store.index.byId.get(id)?.path ?? id
const textOf = (q: Q) => (q.action ? `${q.question}` : q.question)

interface Run { q: Q; paths: string[]; tokens: number; silent: boolean; ms: number }

async function runMap(qs: Q[], opts: MapOptions): Promise<Run[]> {
  const out: Run[] = []
  for (const q of qs) {
    const t0 = performance.now()
    const m = await promptMap(store, textOf(q), opts)
    out.push({ q, paths: m.items.map(i => pathOf(i.id)), tokens: m.tokens, silent: m.silent, ms: performance.now() - t0 })
  }

  return out
}

/** B2 grep proxy (as in bench/run.ts): files ranked by distinct query terms contained. */
function runGrep(qs: Q[]): Run[] {
  return qs.map(q => {
    const terms = queryTerms(textOf(q))
    const scored: { path: string; n: number }[] = []
    for (const [path, body] of raw) {
      const lower = body.toLowerCase()
      const n = terms.filter(t => lower.includes(t)).length
      if (n > 0) scored.push({ path, n })
    }
    scored.sort((a, b) => b.n - a.n || a.path.localeCompare(b.path))

    return { q, paths: scored.slice(0, 5).map(s => s.path), tokens: 0, silent: scored.length === 0, ms: 0 }
  })
}

/** What the grep fallback costs for each question: used when the map misses (the agent then searches anyway). */
const grepCost = new Map<string, number>()

function score(runs: Run[]) {
  const ans = runs.filter(r => r.q.gold.length > 0)
  const neg = runs.filter(r => r.q.gold.length === 0)
  const rank = (r: Run) => r.paths.findIndex(p => r.q.gold.includes(p))
  const recall = (k: number) => ans.filter(r => rank(r) >= 0 && rank(r) < k).length / Math.max(1, ans.length)
  let sent = 0
  let wrong = 0
  for (const r of runs) for (const p of r.paths) {
    sent++
    if (!r.q.gold.includes(p) && !r.q.acceptable.includes(p)) wrong++
  }
  // Tokens to answer: the block sent, then reading notes in rank order until a gold note. A miss reads all it was
  // given and then pays the grep fallback, because the agent still has to find the answer.
  const tta = ans.map(r => {
    const i = rank(r)
    const read = r.paths.slice(0, i >= 0 ? i + 1 : r.paths.length).reduce((s, p) => s + estTokens(raw.get(p) ?? ''), 0)

    return r.tokens + read + (i >= 0 ? 0 : (grepCost.get(r.q.id) ?? 0))
  })
  const lat = runs.map(r => r.ms).sort((a, b) => a - b)

  return {
    n: runs.length,
    recall1: recall(1),
    recall3: recall(3),
    recall5: recall(5),
    silence: neg.filter(r => r.paths.length === 0).length / Math.max(1, neg.length),
    answeredSilently: ans.filter(r => r.paths.length === 0).length / Math.max(1, ans.length),
    wrongInjection: wrong / Math.max(1, sent),
    mustNot: runs.filter(r => r.q.must_not.length > 0 && r.paths.some(p => r.q.must_not.includes(p))).length / Math.max(1, runs.filter(r => r.q.must_not.length > 0).length),
    tokensToAnswer: tta.reduce((s, x) => s + x, 0) / Math.max(1, tta.length),
    blockTokensMean: runs.reduce((s, r) => s + r.tokens, 0) / Math.max(1, runs.length),
    blockTokensMax: Math.max(0, ...runs.map(r => r.tokens)),
    p95Ms: lat[Math.floor(0.95 * lat.length)] ?? 0,
  }
}

// The grep proxy's own cost per question, computed once (it never falls back).
for (const r of runGrep(all)) {
  const i = r.paths.findIndex(p => r.q.gold.includes(p))
  grepCost.set(r.q.id, r.paths.slice(0, i >= 0 ? i + 1 : r.paths.length).reduce((s, p) => s + estTokens(raw.get(p) ?? ''), 0))
}

const base: MapOptions = { ...DEFAULT_MAP, ...(expandName ? { expand: expanders[expandName] } : {}) }
const grid: { minCoverage: number; minKnown: number; relCutoff: number; m: ReturnType<typeof score> }[] = []
for (const minCoverage of [0, 0.15, 0.25, 0.34]) for (const minKnown of [0, 0.5, 0.6, 0.7, 0.8]) for (const relCutoff of [0.3, 0.5, 0.7]) grid.push({ minCoverage, minKnown, relCutoff, m: score(await runMap(tune, { ...base, minCoverage, minKnown, relCutoff })) })
// Objective, fixed before looking at the test half: answers first, then silence and clean pointers at half weight.
const utility = (m: ReturnType<typeof score>) => m.recall3 + 0.5 * m.silence - 0.5 * m.wrongInjection
const ok = grid.filter(g => g.m.silence >= 0.8)
const pick = [...grid].sort((a, b) => utility(b.m) - utility(a.m) || a.m.wrongInjection - b.m.wrongInjection)[0]!
const chosen: MapOptions = { ...base, minCoverage: pick.minCoverage, minKnown: pick.minKnown, relCutoff: pick.relCutoff }
const testRuns = await runMap(testSet, chosen)
const result = {
  label,
  expand: expandName ?? null,
  chosen: { minCoverage: pick.minCoverage, minKnown: pick.minKnown, relCutoff: pick.relCutoff, max: chosen.max, budgetTokens: chosen.budgetTokens, anySettingMetSilence80: ok.length > 0, utility: utility(pick.m) },
  tuneMetrics: pick.m,
  test: score(testRuns),
  testByKind: Object.fromEntries(['lookup', 'why', 'multi_hop', 'temporal', 'action', 'negative'].map(k => [k, score(testRuns.filter(r => r.q.kind === k))])),
  testGrep: score(runGrep(testSet)),
  grid: grid.map(g => ({ minCoverage: g.minCoverage, minKnown: g.minKnown, relCutoff: g.relCutoff, recall3: g.m.recall3, silence: g.m.silence, wrong: g.m.wrongInjection })),
}
await mkdir(resolve('bench/out'), { recursive: true })
await writeFile(resolve(`bench/out/${label}.json`), JSON.stringify(result, null, 2))
const f = (x: number) => x.toFixed(3)
console.log(`chosen on tune half: minCoverage ${pick.minCoverage}, minKnown ${pick.minKnown}, relCutoff ${pick.relCutoff} (any setting reached silence 0.8: ${ok.length > 0})`)
console.log('test half          R@1    R@3    R@5    silence  wrong  must-not  tokens-to-answer  block mean/max')
for (const [name, m] of [['prompt map', result.test], ['grep proxy', result.testGrep]] as const) console.log(`${name.padEnd(18)} ${f(m.recall1)}  ${f(m.recall3)}  ${f(m.recall5)}  ${f(m.silence)}    ${f(m.wrongInjection)}  ${f(m.mustNot)}     ${Math.round(m.tokensToAnswer)}             ${Math.round(m.blockTokensMean)}/${m.blockTokensMax}`)
for (const [k, m] of Object.entries(result.testByKind)) console.log(`  ${k.padEnd(10)} n=${m.n} R@3 ${f(m.recall3)} silence ${f(m.silence)} wrong ${f(m.wrongInjection)} silent-on-answerable ${f(m.answeredSilently)}`)
