// Speed gates for Files mode (spec 01 §5: N5, N7, N8). Generates a synthetic vault, then times
// a cold build, a warm start from the cache, single-note updates, queries and the checker.
// Usage: node bench/perf.ts [--notes 2000]

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore } from '../src/store-files/files-store.ts'

const i = process.argv.indexOf('--notes')
const N = i > 0 ? Number(process.argv[i + 1]) : 2000
const dir = resolve(`bench/out/scale-${N}`)
const cache = resolve(`bench/out/scale-${N}-cache/index.json`)

// Deterministic pseudo-random numbers, so every run builds the same vault.
let seed = 42
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!
const WORDS = 'sync budget habit streak reminder offline conflict merge server phone android ios expo postgres migration schema release beta onboarding chart export import backup restore encryption login session token cache queue retry battery widget notification calendar goal category report currency rounding locale theme accessibility latency crash analytics privacy consent pricing roadmap blog docs guide tutorial api route handler test fixture benchmark index search memory decision finding rule task'.split(' ')
const TYPES = ['decision', 'finding', 'entity', 'rule', 'task', 'note'] as const
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')

await rm(dir, { recursive: true, force: true })
await rm(resolve(`bench/out/scale-${N}-cache`), { recursive: true, force: true })
const titles: string[] = []
for (let k = 0; k < N; k++) titles.push(`${sentence(3)} ${k}`)
for (let k = 0; k < N; k++) {
  const type = pick([...TYPES])
  // Power-law-ish links: a few notes are linked very often (natural hubs).
  const links = Array.from({ length: 3 + Math.floor(rnd() * 5) }, () => titles[Math.floor(N * rnd() ** 3)]!)
  const fm = type === 'note' ? '' : `---\ntype: ${type}\ntitle: ${titles[k]}\nsummary: ${sentence(14)}\nabout: ["[[${links[0]}]]"]\n${type === 'finding' ? 'sources:\n  - "url:https://example.org/x 2026-01-01"\n' : ''}---\n`
  const body = `${fm}# ${sentence(4)}\n\n${Array.from({ length: 6 }, () => sentence(25)).join('\n\n')}\n\n${links.map(l => `[[${l}]]`).join(' ')}\n`
  const folder = type === 'note' ? 'notes' : `${type}s`
  await mkdir(`${dir}/${folder}`, { recursive: true })
  await writeFile(`${dir}/${folder}/${titles[k]}.md`, body)
}

const ms = async (f: () => Promise<unknown> | unknown) => {
  const t0 = performance.now()
  await f()

  return performance.now() - t0
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0

const cold = new FilesStore(nodeIO, dir, cache)
const coldMs = await ms(() => cold.open())
const warm = new FilesStore(nodeIO, dir, cache)
const warmMs = await ms(() => warm.open())

const updates: number[] = []
const paths = [...warm.index.byPath.keys()]
for (let k = 0; k < 30; k++) {
  const p = pick(paths)
  await writeFile(`${dir}/${p}`, `---\ntype: decision\ntitle: edited ${k} ${p}\nsummary: ${sentence(10)}\n---\n${sentence(60)} [[${pick(titles)}]]\n`)
  updates.push(await ms(() => warm.refreshPath(p)))
}

const queries: number[] = []
for (let k = 0; k < 300; k++) queries.push(await ms(() => warm.index.search(sentence(5), { limit: 5, includeInbox: false })))
const doctorMs = await ms(() => warm.doctor())
const stats = warm.index.stats()

const gates = [
  { id: 'N7', what: `full rebuild, cold, ${N} notes`, value: coldMs, limit: N <= 2000 ? 3000 : null },
  { id: 'N8', what: 'incremental update of one note (p95)', value: pct(updates, 95), limit: 20 },
  { id: 'N5', what: 'lexical query (p95), in-process', value: pct(queries, 95), limit: 50 },
]
const report = {
  notes: N,
  stats,
  coldMs,
  warmMs,
  updateP50Ms: pct(updates, 50),
  updateP95Ms: pct(updates, 95),
  queryP50Ms: pct(queries, 50),
  queryP95Ms: pct(queries, 95),
  doctorMs,
  gates: gates.map(g => ({ ...g, pass: g.limit === null ? null : g.value <= g.limit })),
  node: process.version,
  machine: `${process.platform} ${process.arch}`,
  date: new Date().toISOString(),
}
await writeFile(resolve(`bench/out/perf-${N}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
