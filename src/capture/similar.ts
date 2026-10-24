// Write-time duplicate and contradiction candidates: BM25 over note text plus trigram similarity of titles.

import { tokenize } from '../core/tokenize.ts'
import type { CNote } from './notes.ts'

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const grams = (s: string) => {
  const t = ` ${norm(s)} `
  const g = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3))

  return g
}
export function trigramSim(a: string, b: string): number {
  const x = grams(a)
  const y = grams(b)
  let both = 0
  for (const g of x) if (y.has(g)) both++

  return both / (x.size + y.size - both || 1)
}

const text = (n: { title: string; summary: string }) => `${n.title} ${n.summary}`

/** BM25 score of each note for the query, with the share of query terms (by idf) the note contains. */
function bm25(query: string, docs: CNote[]) {
  const toks = docs.map((d) => tokenize(text(d)))
  const avg = toks.reduce((a, t) => a + t.length, 0) / (docs.length || 1) || 1
  const q = [...new Set(tokenize(query))]
  const idf = new Map(q.map((t) => {
    const df = toks.filter((d) => d.includes(t)).length
    return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))] as const
  }))
  const wsum = [...idf.values()].reduce((a, b) => a + b, 0) || 1

  return docs.map((d, i) => {
    let score = 0
    let seen = 0
    for (const t of q) {
      const tf = toks[i]!.filter((x) => x === t).length
      if (!tf) continue
      score += idf.get(t)! * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (toks[i]!.length / avg))))
      seen += idf.get(t)!
    }
    return { note: d, score, cov: seen / wsum }
  })
}

export const DUP = 0.6
export const CANDIDATE = 0.3

/** A near duplicate among `pool` (same type), and the strongest contradiction candidate among `active`. */
export function related(p: { type: string; title: string; summary: string }, pool: CNote[], active: CNote[]) {
  const same = pool.filter((n) => n.type === p.type)
  const dup = same.find((n) => trigramSim(n.title, p.title) >= DUP || norm(n.summary) === norm(p.summary))
  if (dup) return { dup }
  const cands = bm25(text(p), active.filter((n) => n.type === p.type))
    .filter((r) => trigramSim(r.note.title, p.title) >= CANDIDATE || r.cov >= 0.5)
    .sort((a, b) => b.score - a.score)

  return { candidate: cands[0]?.note }
}
