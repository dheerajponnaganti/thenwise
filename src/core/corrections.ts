// Phase 8, repeated corrections (spec 06 §5): when the user gives the same correction again and again,
// propose it as a rule (in the inbox, never active on its own). Off by default. Pure: hosts pass the prompts in.

export interface PromptEvent {
  text: string
  at: number
  sessionId: string
  project: string
}

export interface Proposal {
  /** The most recent wording. */
  text: string
  count: number
  sessions: number
  firstAt: number
  lastAt: number
  examples: string[]
}

/** Claude Code's ~/.claude/history.jsonl: one JSON object per prompt with display, timestamp, project, sessionId. */
export function parseClaudeHistory(text: string): PromptEvent[] {
  const out: PromptEvent[] = []
  for (const line of text.split('\n')) {
    try {
      const d = JSON.parse(line) as { display?: unknown; timestamp?: unknown; sessionId?: unknown; project?: unknown }
      const t = String(d.display ?? '').trim()
      // Slash commands are not corrections.
      if (t && !t.startsWith('/')) out.push({ text: t, at: Number(d.timestamp ?? 0), sessionId: String(d.sessionId ?? ''), project: String(d.project ?? '') })
    } catch {
      // A half-written or blank line.
    }
  }

  return out
}

// Words that mark a correction of the agent's behaviour [hypothesis; precision measured on the owner's history].
const MARKER = /\b(don'?t|do not|stop|never|no more|not like that|i said|i told you|you forgot|you keep|keep forgetting|again\b|instead of|always use|always)\b/i
const MAX_CHARS = 300
const MIN_WORDS = 4

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
function overlap(a: Set<string>, b: Set<string>): number {
  let both = 0
  for (const w of a) if (b.has(w)) both++

  return both / Math.max(1, a.size + b.size - both)
}

export function correctionProposals(events: PromptEvent[], opts: { minCount: number; minSessions: number; same: number; project?: string } = { minCount: 3, minSessions: 2, same: 0.25 }): Proposal[] {
  const groups: { set: Set<string>; items: PromptEvent[] }[] = []
  for (const e of events) {
    if (opts.project && e.project !== opts.project) continue
    // One- to three-word prompts ("stop", "no") interrupt a turn; they are not standing rules.
    if (e.text.length > MAX_CHARS || !MARKER.test(e.text) || (e.text.match(/[\p{L}\p{N}']+/gu) ?? []).length < MIN_WORDS) continue
    const set = words(e.text)
    const g = groups.find(x => overlap(x.set, set) >= opts.same)
    if (g) g.items.push(e)
    else groups.push({ set, items: [e] })
  }

  return groups
    .map(g => {
      const sorted = [...g.items].sort((a, b) => a.at - b.at)

      return { text: sorted[sorted.length - 1]!.text, count: sorted.length, sessions: new Set(sorted.map(i => i.sessionId)).size, firstAt: sorted[0]!.at, lastAt: sorted[sorted.length - 1]!.at, examples: sorted.slice(-3).map(i => i.text) }
    })
    .filter(p => p.count >= opts.minCount && p.sessions >= opts.minSessions)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
}
