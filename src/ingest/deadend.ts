// Dead ends found at ingest by fixed phrase rules, no model: a sentence that records a path being given up.
// The flag is automatic (extra.deadEnd), apart from curated dead_end notes, which only come from accepted proposals.

const STRONG = /\b(?:reverted|rolled back|gave up|did not work|didn'?t work|does not work anymore|made it worse|too slow|abandoned|not wanted)\b/i
// Common in plain design talk ("use X instead of Y"), so they count only next to a past-attempt cue.
const WEAK = /\b(?:broke|dropped|went back to|replaced by|instead of)\b/i
const CUE = /\b(?:originally|previously|at first|first attempt|first try|turned out|tried)\b/i

/** Text with code, quotes and tables taken out: a phrase inside them does not record a decision. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*(?:>|\|)/.test(l))
    .join('\n')
}

/** The first sentence of `text` that records a dropped approach, or undefined. */
export function deadEnd(text: string): string | undefined {
  for (const raw of prose(text).split(/(?<=[.!])\s+|\n+/)) {
    const s = raw.replace(/^[\s*#>-]+/, '').replace(/\s+/g, ' ').trim()
    if (s.length < 15 || s.length > 400 || s.endsWith('?')) continue
    if (/^(?:if|when|whether|should|do not|don'?t|never|to|in case)\b/i.test(s)) continue // advice and conditions, not events
    if (/\b(?:can|could|may|might|will|would|should|to|be) (?:be )?(?:reverted|rolled back)\b/i.test(s)) continue // a future option, not an event
    if (STRONG.test(s) || (WEAK.test(s) && CUE.test(s))) return s.length > 160 ? `${s.slice(0, 157)}...` : s
  }
  return undefined
}

/** A commit: `Revert "..."` in the subject, else a phrase in the body. */
export const commitDeadEnd = (subject: string, body: string): string | undefined => (/^Revert\b/.test(subject) ? subject : deadEnd(body))

export type DeadEndKind = 'undone' | 'failed-test' | 'marked' | 'phrase'
export interface Structural {
  text: string
  kind: DeadEndKind
  file?: string
}

const alias = (p: string) => p.split('/').slice(-2).join('/')
const short = (id: string) => id.slice(0, 8)

/**
 * Dead ends from what happened in one session, not from what was said: an edit that a later edit puts back (the new
 * text hashes to an earlier old text), and a failed test run followed by work on another file. Keyed by the later
 * turn. Sessions do not cross: an undo next week is a new decision, not this attempt failing.
 */
export function structural(turns: { id: string; changes?: { file: string; oldHash: string; newHash: string; at: string }[]; tests?: { at: string; failed: boolean }[] }[]): Map<string, Structural> {
  const out = new Map<string, Structural>()
  const seen = new Map<string, { hash: string; turn: string }[]>() // file -> earlier old texts
  let lastEdited: string | undefined
  let failedAfter: string | undefined // the file edited before a failed run
  for (const t of turns) {
    const events = [...(t.changes ?? []).map((c) => ({ at: c.at, c })), ...(t.tests ?? []).map((x) => ({ at: x.at, x }))].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    for (const e of events) {
      if ('x' in e) {
        if (e.x!.failed && lastEdited) failedAfter = lastEdited
        else if (!e.x!.failed) failedAfter = undefined
        continue
      }
      const c = e.c!
      const before = seen.get(c.file) ?? []
      const back = c.newHash ? before.find((b) => b.hash === c.newHash && b.turn !== t.id) : undefined
      if (back && !out.has(t.id)) out.set(t.id, { text: `undone edit to ${alias(c.file)} (made in turn ${short(back.turn)}, put back in turn ${short(t.id)})`, kind: 'undone', file: c.file })
      if (c.oldHash) seen.set(c.file, [...before, { hash: c.oldHash, turn: t.id }])
      if (failedAfter && c.file !== failedAfter && !out.has(t.id)) out.set(t.id, { text: `tests failed after editing ${alias(failedAfter)}; moved on to ${alias(c.file)}`, kind: 'failed-test', file: failedAfter })
      if (failedAfter && c.file !== failedAfter) failedAfter = undefined
      lastEdited = c.file
    }
  }

  return out
}

/** A prompt line `[dead-end] text`: the person says this attempt failed. */
export const markedDeadEnd = (prompt: string): string | undefined => /^\s*\[dead-end\]\s*(\S.*)$/im.exec(prompt)?.[1]?.trim().slice(0, 300)
