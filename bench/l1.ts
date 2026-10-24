// Phase 2 gate: layer 1 (exact match) on the fixture's action questions. Retrieval only, no model calls.
// Usage: node bench/l1.ts [--max 2]

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { exactMatch } from '../src/core/retrieve.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'

const i = process.argv.indexOf('--max')
const MAX = i > 0 ? Number(process.argv[i + 1]) : 2
const vault = resolve('fixtures/vault-sample')
const store = new FilesStore(nodeIO, vault, null)
await store.open()
const qs = (await nodeIO.readText(resolve('fixtures/questions.jsonl')))!.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(q => q.kind === 'action')
let hit = 0
let sent = 0
let wrong = 0
let mustNot = 0
const lat: number[] = []
const rows: string[] = []
for (const q of qs) {
  const t0 = performance.now()
  const shown = await exactMatch(store, { path: q.action.path }, { max: MAX })
  lat.push(performance.now() - t0)
  const paths = shown.map(s => s.node.path)
  if (paths.some(p => q.gold.includes(p))) hit++
  for (const p of paths) {
    sent++
    if (!q.gold.includes(p) && !q.acceptable.includes(p)) wrong++
  }
  if (paths.some(p => q.must_not.includes(p))) mustNot++
  rows.push(`| ${q.id} | ${q.action.path} | ${paths.join('<br>') || '(nothing)'} | ${paths.filter(p => q.gold.includes(p)).length}/${q.gold.length} |`)
}
lat.sort((a, b) => a - b)
const result = { questions: qs.length, max: MAX, recallAtMax: hit / qs.length, wrongInjection: wrong / Math.max(1, sent), sentPerQuestion: sent / qs.length, mustNotRate: mustNot / qs.length, p95Ms: lat[Math.floor(0.95 * lat.length)] ?? 0 }
await mkdir(resolve('bench/out'), { recursive: true })
await writeFile(resolve('bench/out/phase2-l1.json'), JSON.stringify(result, null, 2))
await writeFile(resolve('bench/out/phase2-l1.md'), `# Layer 1 on action questions (max ${MAX})\n\n${JSON.stringify(result, null, 2)}\n\n| q | path | shown | gold hit |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`)
console.log(JSON.stringify(result, null, 2))
