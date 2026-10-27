// The retrieval benchmark: ranks every gold question with the engine the plugin uses and reports where the gold records land.
// No model, no network; a run takes seconds. See bench/gold/README.md for the gold format.
// Usage: node bench/gold/run.ts [--gold <gold.jsonl.gz>] [--stores <folder>] [--label <name>] [--compare <label>] [--out <folder>] [--chars]
// --stores reads each line's store from another folder (stores rebuilt by other code), default the gold folder.
// --chars also formats each answer to report its size, which doubles the run time. --expand turns on synonym expansion.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import * as c from '../../src/query/commands.ts'
import { Graph } from '../../src/query/engine.ts'

export interface GoldLine { id: string; set?: string; store?: string; db?: string; kind: string; cmd: c.RankCmd; query: string; date?: string; gold: string[]; acceptable?: string[]; must_not?: string[] }
export interface Row { id: string; cmd: string; kind: string; rank: number | null; mustNotTop3: boolean; chars: number }
export interface Stats { n: number; r1: number; r3: number; r10: number; mrr: number; mustNot: number; chars: number }

const TEXT: Record<c.RankCmd, (g: Graph, l: GoldLine) => string> = {
  search: (g, l) => c.search(g, l.query),
  why: (g, l) => c.why(g, l.query),
  tried: (g, l) => c.tried(g, l.query),
  current: (g, l) => c.current(g, l.query),
  asof: (g, l) => c.asof(g, l.date ?? '', l.query),
}

/** Where the first gold (or acceptable) record lands among the ranked records, 1-based; null when it is not there. */
export function score(g: Graph, l: GoldLine, chars = false): Row {
  const seen: string[] = []
  for (const x of c.rank(g, l.cmd, l.query, { date: l.date }).items) if (!seen.includes(x.h.node.id)) seen.push(x.h.node.id)
  const ok = new Set([...l.gold, ...(l.acceptable ?? [])])
  const at = seen.findIndex((id) => ok.has(id))

  return { id: l.id, cmd: l.cmd, kind: l.kind, rank: at < 0 ? null : at + 1, mustNotTop3: seen.slice(0, 3).some((id) => l.must_not?.includes(id)), chars: chars ? TEXT[l.cmd](g, l).length : 0 }
}

export function summarize(rows: Row[]): Stats {
  const n = rows.length || 1
  const within = (k: number) => rows.filter((r) => r.rank !== null && r.rank <= k).length / n

  return { n: rows.length, r1: within(1), r3: within(3), r10: within(10), mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n, mustNot: rows.filter((r) => r.mustNotTop3).length, chars: Math.round(rows.reduce((s, r) => s + r.chars, 0) / n) }
}

/** Questions whose rank moved between two runs, old rank to new rank. */
export function compare(before: Row[], after: Row[]): string[] {
  const old = new Map(before.map((r) => [r.id, r.rank]))
  const fmt = (r: number | null | undefined) => (r == null ? '-' : String(r))

  return after.filter((r) => old.has(r.id) && old.get(r.id) !== r.rank).map((r) => `${r.id} (${r.cmd}): ${fmt(old.get(r.id))} -> ${fmt(r.rank)}`)
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5)
const table = (title: string, groups: Map<string, Row[]>) => [
  `${title.padEnd(10)}     n   R@1   R@3  R@10   MRR  must-not  chars`,
  ...[...groups].map(([k, rs]) => {
    const s = summarize(rs)

    return `${k.padEnd(10)} ${String(s.n).padStart(5)} ${pct(s.r1)} ${pct(s.r3)} ${pct(s.r10)}  ${s.mrr.toFixed(2)}  ${String(s.mustNot).padStart(8)}  ${String(s.chars).padStart(5)}`
  }),
].join('\n')
const by = (rows: Row[], key: (r: Row) => string) => {
  const m = new Map<string, Row[]>([['all', rows]])
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])

  return m
}

if (import.meta.main) {
  const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined)
  const goldFile = arg('gold') ?? join(homedir(), '.memory', 'eval', 'gold', 'gold.jsonl.gz')
  // Results name private records, so they stay beside the gold set, outside the repo.
  const outDir = arg('out') ?? join(dirname(goldFile), 'out')
  const label = arg('label') ?? 'dev'
  const raw = readFileSync(goldFile)
  const lines: GoldLine[] = (goldFile.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const t0 = Date.now()
  const graphs = new Map<string, Graph>()
  const rows: Row[] = []
  const missing: string[] = []
  for (const l of lines) {
    const db = l.db ?? join(arg('stores') ?? dirname(goldFile), l.store ?? 'gate', 'graph.db')
    // Loaded whole: the ranks are the same as the server's lazy load, and a run is faster.
    if (!graphs.has(db)) graphs.set(db, Object.assign(new Graph(db), { expand: process.argv.includes('--expand') }))
    const g = graphs.get(db)!
    for (const id of l.gold) if (!g.nodes.has(id)) missing.push(`${l.id}: ${id}`)
    rows.push(score(g, l, process.argv.includes('--chars')))
  }
  const ms = Date.now() - t0
  console.log(table('command', by(rows, (r) => r.cmd)))
  console.log(`\n${table('kind', by(rows, (r) => r.kind))}`)
  console.log(`\n${rows.length} questions in ${(ms / 1000).toFixed(1)} s${missing.length ? `; ${missing.length} gold ids not in their store:\n  ${missing.join('\n  ')}` : ''}`)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const file = join(outDir, `gold-${label}.json`)
  writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), gold: goldFile, ms, summary: summarize(rows), rows }, null, 1), { mode: 0o600 })
  console.log(`saved ${file}`)
  const other = arg('compare')
  if (other) {
    const f = join(outDir, `gold-${other}.json`)
    if (!existsSync(f)) throw new Error(`no run named ${other} in ${outDir}`)
    const moved = compare(JSON.parse(readFileSync(f, 'utf8')).rows, rows)
    console.log(`\nagainst ${other}: ${moved.length} moved${moved.length ? `\n  ${moved.join('\n  ')}` : ''}`)
  }
  for (const g of graphs.values()) g.db.close()
}
