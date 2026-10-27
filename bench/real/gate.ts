// Go or no-go summary for the two gate arms, from judged answers only (the gold file is never read).
// Usage: node bench/real/gate.ts <plain.judged.jsonl> <plugin.judged.jsonl> <plain.jsonl> <plugin.jsonl>
// A negative (decoy) question is one judged with no required facts; it is right when the answer abstains.

import { readFileSync } from 'node:fs'

const rows = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const [pj, gj, pa, ga] = process.argv.slice(2).map(rows)
const w = (t: { in: number; cacheRead: number; cacheWrite: number; out: number }) => t.in + 0.1 * t.cacheRead + 1.25 * t.cacheWrite + 5 * t.out
const stats = (judged: any[], answers: any[]) => {
  const by = new Map(judged.map((j) => [j.id, j]))
  const decoys = judged.filter((j) => j.facts.length === 0)
  return {
    n: judged.length,
    correct: judged.filter((j) => j.correct).length,
    outdated: judged.filter((j) => j.outdated).length,
    wrong: judged.filter((j) => !j.correct && !j.abstained).length,
    abstained: judged.filter((j) => j.abstained).length,
    decoys: decoys.length,
    invented: decoys.filter((j) => !j.abstained).length,
    tokens: Math.round(answers.reduce((s, a) => s + w(a.tokens), 0) / answers.length),
    seconds: Math.round(answers.reduce((s, a) => s + a.seconds, 0) / answers.length),
    ids: by,
  }
}
const p = stats(pj!, pa!)
const g = stats(gj!, ga!)
// Paired bootstrap of the correct-rate difference over the shared question ids.
const ids = [...p.ids.keys()].filter((id) => g.ids.has(id))
const diff = (pick: string[]) => (pick.filter((id) => g.ids.get(id).correct).length - pick.filter((id) => p.ids.get(id).correct).length) / pick.length
let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31)
const boots = Array.from({ length: 5000 }, () => diff(ids.map(() => ids[Math.floor(rnd() * ids.length)]!))).sort((a, b) => a - b)
const pts = (x: number) => Math.round(x * 100)
const lead = pts(diff(ids))
const bar = [
  [`more correct by at least 15 points`, lead >= 15],
  [`outdated no higher (${g.outdated} vs ${p.outdated})`, g.outdated <= p.outdated],
  [`decoys invented no more (${g.invented} vs ${p.invented})`, g.invented <= p.invented],
  [`tokens at most 10% higher (${g.tokens} vs ${p.tokens})`, g.tokens <= p.tokens * 1.1],
] as const
for (const [name, s] of [['plain', p], ['plugin', g]] as const) console.log(`${name.padEnd(7)} correct ${s.correct}/${s.n} (${pts(s.correct / s.n)}%), wrong ${s.wrong}, abstained ${s.abstained}, outdated ${s.outdated}, decoys invented ${s.invented}/${s.decoys}, weighted tokens ${s.tokens}, ${s.seconds} s per answer`)
console.log(`lead ${lead} points, 95% interval ${pts(boots[125]!)} to ${pts(boots[4874]!)}`)
for (const [name, ok] of bar) console.log(`${ok ? 'pass' : 'FAIL'} ${name}`)
console.log(bar.every(([, ok]) => ok) ? 'GO' : 'NO-GO')
