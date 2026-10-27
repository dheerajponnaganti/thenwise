// Scores answers to the real-history questions (Full Build Plan, Phase A). Exact checks only, no model judge.
// Usage: node bench/real/score.ts <questions.jsonl[.gz]> <answers.jsonl>...   Prints a table per arm and writes <answers>.scored.json.

import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

// Read rules for every test session: chat logs (live and archived) now hold the question set; Claude Code's own
// memory files stay readable.
export const NO_PEEKING = ['Read(~/.claude/projects/**/*.jsonl)', 'Read(~/.memory/archive/**)', 'Read(~/.memory/eval/*.gz)', 'Read(/private/tmp/**)']

export interface RealQuestion {
  id: string
  kind: 'why' | 'tried' | 'when' | 'current' | 'state_at' | 'connect' | 'negative'
  question: string
  as_of: string | null
  answer: string
  must: string[][]
  must_not: string[]
  sources: { type: string; ref: string }[]
  only_in: string
  difficulty: number
}

export interface Answer {
  id: string
  arm: string
  run: number
  answer: string
  tokens?: { in: number; cacheRead: number; cacheWrite: number; out: number }
  costUsd?: number
  turns?: number
  seconds?: number
}

export interface Scored {
  id: string
  arm: string
  run: number
  facts: number
  correct: boolean
  outdated: boolean
  abstained: boolean
  cited: boolean
}

// Keeps the characters of versions, paths and ids (v0.13.0, #74, a/b.ts); drops sentence punctuation.
export const norm = (s: string) => ` ${s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}#.%'/:@-]+/gu, ' ').replace(/[.:']+(?=\s|$)/g, '').replace(/\s+/g, ' ').trim()} `

// An answer that names an old fact only to say it was replaced is not outdated.
const PAST = /\b(used to|previously|was|were|earlier|old|older|before|replaced|superseded|no longer|instead of|dropped|abandoned|moved (away )?from|not|first|initially|originally|then|next|later|after|until)\b[^.]{0,60}$/

const ABSTAIN = /\b(not recorded|no record|isn'?t recorded|no (note|source|mention|evidence)|(could not|couldn'?t|can'?t|cannot|did not|didn'?t) find|nothing (in|about)|not (mentioned|documented|stated|covered)|no (decision|information) (was|is) recorded|doesn'?t say|do not say|don'?t say|never (discussed|decided|mentioned))\b/

// "v0.9.2" should match "0.9.2", and "squash-merged" should match "squash".
const splitVersions = (s: string) => s.replace(/(?<![\p{L}\p{N}])v(?=\d)/gu, 'v ')
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Finds a key phrase in normalised text: whole words, with up to three other words allowed between its words. */
export function findPhrase(text: string, phrase: string): number {
  const words = splitVersions(norm(phrase)).trim().split(' ').filter(Boolean)
  if (!words.length) return -1
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escape).join('(?:\\s+\\S+){0,3}?\\s+')}(?![\\p{L}\\p{N}])`, 'u')
  const m = re.exec(splitVersions(text))

  return m ? m.index : -1
}

export function scoreOne(q: RealQuestion, a: Answer): Scored {
  const text = norm(a.answer)
  const hit = (p: string) => findPhrase(text, p) >= 0
  const facts = q.must.length ? q.must.filter(alts => alts.some(hit)).length / q.must.length : 0
  const outdated = q.must_not.some(p => {
    const i = findPhrase(text, p)

    return i >= 0 && !PAST.test(splitVersions(text).slice(Math.max(0, i - 80), i))
  })
  const abstained = ABSTAIN.test(text)
  // A cited source is any PR number, vault note name or session prefix from the gold sources.
  const cited = q.sources.some(s => {
    const ref = s.ref.split('@')[0]!.trim()
    const key = s.type === 'vault' ? ref.split('/').pop()!.replace(/\.md$/, '') : ref

    return key.length >= 2 && findPhrase(text, key) >= 0
  })
  const correct = q.kind === 'negative' ? abstained : facts === 1 && !outdated

  return { id: q.id, arm: a.arm, run: a.run, facts, correct, outdated, abstained: q.kind !== 'negative' && abstained && facts < 1, cited }
}

export function loadJsonl<T>(path: string): T[] {
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8')

  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T)
}

function pct(xs: boolean[]): string {
  return xs.length ? `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}%` : 'n/a'
}

if (import.meta.main) {
  const [qPath, ...answerPaths] = process.argv.slice(2)
  if (!qPath || answerPaths.length === 0) throw new Error('usage: node bench/real/score.ts <questions.jsonl[.gz]> <answers.jsonl>...')
  const questions = new Map(loadJsonl<RealQuestion>(qPath).map(q => [q.id, q]))
  for (const p of answerPaths) {
    const answers = loadJsonl<Answer>(p).filter(a => questions.has(a.id))
    const scored = answers.map(a => scoreOne(questions.get(a.id)!, a))
    writeFileSync(p.replace(/\.jsonl$/, '.scored.json'), JSON.stringify(scored, null, 1))
    const by = (f: (q: RealQuestion) => string) => {
      const groups = new Map<string, Scored[]>()
      for (const s of scored) {
        const k = f(questions.get(s.id)!)
        groups.set(k, [...(groups.get(k) ?? []), s])
      }

      return [...groups].sort().map(([k, ss]) => `${k} ${pct(ss.map(s => s.correct))} (${ss.length})`).join(' · ')
    }
    const tok = answers.reduce((t, a) => t + (a.tokens ? a.tokens.in + 0.1 * a.tokens.cacheRead + 1.25 * a.tokens.cacheWrite + 5 * a.tokens.out : 0), 0)
    console.log(`\n${p}`)
    console.log(`correct ${pct(scored.map(s => s.correct))} of ${scored.length} · outdated ${pct(scored.map(s => s.outdated))} · gave up ("not recorded") with facts missing ${pct(scored.map(s => s.abstained))} · cited a gold source ${pct(scored.map(s => s.cited))} · weighted tokens per answer ${answers.length ? Math.round(tok / answers.length) : 0}`)
    console.log(`by kind: ${by(q => q.kind)}`)
    console.log(`by where the answer lives: ${by(q => q.only_in)}`)
    console.log(`by difficulty: ${by(q => String(q.difficulty))}`)
  }
}
