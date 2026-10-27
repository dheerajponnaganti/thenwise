// Blind judge for the real-history answers (evaluation only; nothing in the product uses a model to retrieve).
// Exact phrase checks proved too brittle for free text (8 of 10 hand-checked "wrong" answers were scoring errors), so a model
// checks each required fact against the gold answer. It never sees which arm wrote the answer and has no tools.
// Usage: node bench/real/judge.ts <questions.jsonl.gz> <answers.jsonl> [--model sonnet] [--jobs 4]   Writes <answers>.judged.jsonl

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import { loadJsonl } from './score.ts'
import type { Answer, RealQuestion } from './score.ts'

export interface Judgement {
  id: string
  arm: string
  run: number
  facts: boolean[]
  outdated: boolean
  abstained: boolean
  correct: boolean
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? process.argv[i + 1]! : fallback
}
const [qPath, aPath] = process.argv.slice(2)
if (!qPath || !aPath) throw new Error('usage: node bench/real/judge.ts <questions> <answers.jsonl>')
const model = arg('model', 'sonnet')
const jobs = Number(arg('jobs', '4'))
const out = aPath.replace(/\.jsonl$/, '.judged.jsonl')

const prompt = (q: RealQuestion, a: Answer) => `You are grading one answer for an evaluation. Grade only against the gold answer below. Do not use outside knowledge. Do not reward length or style.

QUESTION: ${q.question}${q.as_of ? `\n(The question is about the state as of ${q.as_of}.)` : ''}
GOLD ANSWER: ${q.kind === 'negative' ? 'Nothing in the records answers this; the correct response says it is not recorded.' : q.answer}
REQUIRED FACTS (each must be stated or clearly implied, in any wording, units or rounding; a fact inside a longer explanation still counts, and extra true detail never makes a fact false):
${q.kind === 'negative' ? '(none)' : q.must.map((alts, i) => `${i + 1}. ${alts.join(' / ')}`).join('\n')}
OUTDATED OR WRONG CLAIMS (fail only if the answer asserts one as true; mentioning it as old, replaced or wrong is fine):
${q.must_not.length ? q.must_not.map(m => `- ${m}`).join('\n') : '(none)'}

ANSWER TO GRADE:
"""
${a.answer.slice(0, 6000)}
"""

Reply with one line of JSON and nothing else:
{"facts": [${q.kind === 'negative' ? '' : 'true or false for each required fact, in order'}], "outdated": true or false, "abstained": true if the answer says the records do not answer the question (fully or for the part that matters)}`

function judge(q: RealQuestion, a: Answer): Promise<Judgement> {
  return new Promise(resolve => {
    const child = spawn('claude', ['-p', prompt(q, a), '--output-format', 'json', '--model', model, '--allowedTools', '', '--disallowedTools', 'Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Agent'],
      { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', d => (stdout += d))
    let missing = false
    child.on('error', () => {
      missing = true
      setTimeout(() => resolve(judge(q, a)), 15000)
    })
    child.on('close', () => {
      if (missing) return
      if (/hit your (session|usage|weekly) limit/i.test(stdout)) {
        missing = true
        setTimeout(() => resolve(judge(q, a)), 5 * 60 * 1000)
        return
      }
      let j = { facts: [] as boolean[], outdated: false, abstained: false }
      try {
        const text = (JSON.parse(stdout) as { result: string }).result
        j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch {
        j.facts = q.must.map(() => false)
      }
      const allFacts = q.kind === 'negative' || (j.facts.length === q.must.length && j.facts.every(Boolean))
      resolve({ id: q.id, arm: a.arm, run: a.run, facts: j.facts, outdated: j.outdated, abstained: j.abstained,
        correct: q.kind === 'negative' ? j.abstained && !j.outdated : allFacts && !j.outdated })
    })
  })
}

const questions = new Map(loadJsonl<RealQuestion>(qPath).map(q => [q.id, q]))
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as Judgement).id) : [])
const todo = loadJsonl<Answer>(aPath).filter(a => questions.has(a.id) && !done.has(a.id))
let next = 0
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < todo.length) {
    const a = todo[next++]!
    appendFileSync(out, `${JSON.stringify(await judge(questions.get(a.id)!, a))}\n`)
  }
}))
console.log(`${todo.length} judged into ${out}`)
