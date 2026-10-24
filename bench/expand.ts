// Phase 4 gate: does graph expansion improve ranking? Fixed settings (no tuning, no silence), all 120 questions,
// so the only difference between rows is the expansion. Usage: node bench/expand.ts

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expanders } from '../src/core/expand.ts'
import { DEFAULT_MAP, promptMap } from '../src/core/prompt-map.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'

const store = new FilesStore(nodeIO, resolve('fixtures/vault-sample'), null)
await store.open()
const qs = (await nodeIO.readText(resolve('fixtures/questions.jsonl')))!.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((q: { gold: string[] }) => q.gold.length > 0)
const pathOf = (id: string) => store.index.byId.get(id)?.path ?? id
const fixed = { ...DEFAULT_MAP, minCoverage: 0, minKnown: 0, relCutoff: 0, budgetTokens: 10_000, max: 5 }
const out: Record<string, Record<string, { n: number; recall1: number; recall3: number; recall5: number; wrong: number }>> = {}
for (const [name, expand] of [['none', undefined], ['typed', expanders.typed], ['ppr', expanders.ppr]] as const) {
  const byKind = new Map<string, { n: number; r1: number; r3: number; r5: number; sent: number; wrong: number }>()
  for (const q of qs) {
    const m = await promptMap(store, q.question, { ...fixed, ...(expand ? { expand } : {}) })
    const paths = m.items.map(i => pathOf(i.id))
    const rank = paths.findIndex(p => q.gold.includes(p))
    for (const k of [q.kind, 'all']) {
      const s = byKind.get(k) ?? { n: 0, r1: 0, r3: 0, r5: 0, sent: 0, wrong: 0 }
      s.n++
      if (rank === 0) s.r1++
      if (rank >= 0 && rank < 3) s.r3++
      if (rank >= 0 && rank < 5) s.r5++
      s.sent += paths.length
      s.wrong += paths.filter(p => !q.gold.includes(p) && !q.acceptable.includes(p)).length
      byKind.set(k, s)
    }
  }
  out[name] = Object.fromEntries([...byKind].map(([k, s]) => [k, { n: s.n, recall1: s.r1 / s.n, recall3: s.r3 / s.n, recall5: s.r5 / s.n, wrong: s.wrong / Math.max(1, s.sent) }]))
}
await mkdir(resolve('bench/out'), { recursive: true })
await writeFile(resolve('bench/out/phase4-expand.json'), JSON.stringify(out, null, 2))
for (const kind of ['all', 'multi_hop', 'lookup', 'why', 'temporal', 'action']) {
  console.log(kind)
  for (const [name, byKind] of Object.entries(out)) {
    const m = byKind[kind]!
    console.log(`  ${name.padEnd(6)} R@1 ${m.recall1.toFixed(2)}  R@3 ${m.recall3.toFixed(2)}  R@5 ${m.recall5.toFixed(2)}  wrong ${m.wrong.toFixed(2)}`)
  }
}
