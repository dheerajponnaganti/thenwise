// What each chat did, from the store and with no model: the first prompt, files edited, commits and PRs made, dead ends.
// `thenwise digest` prints it for a time window; the vault writer keeps a Digest note of the last 7 days per project.

import { basename, relative } from 'node:path'
import { Graph, local } from './engine.ts'
import type { Node } from './engine.ts'

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s)
const list = (xs: string[], max: number) => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` (+${xs.length - max} more)` : ''}`

export interface SessionFacts {
  prompt: string
  edited: string[]
  commits: Node[]
  prs: Node[]
  deadEnds: string[]
}

/** The facts of one chat, read from its turns and their edges. A caller with many chats passes each one's turns. */
export function sessionFacts(g: Graph, ses: Node, own = g.bySource(ses.id)): SessionFacts {
  const cwd = String(ses.extra?.cwd ?? '')
  const turns = own.filter((t) => t.kind === 'turn').sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const edited = new Set<string>()
  const commits = new Map<string, Node>()
  const prs = new Map<string, Node>()
  for (const t of turns) {
    for (const e of g.adj.get(t.id) ?? []) {
      if (!e.out) continue
      const n = g.nodes.get(e.to)
      if (e.kind === 'edited') {
        const p = e.to.slice(5)
        const rel = cwd ? relative(cwd, p).replace(/\\/g, '/') : ''
        edited.add(rel && !rel.startsWith('..') ? rel : basename(p))
      } else if (e.kind === 'made' && n) commits.set(n.id, n)
      else if (e.kind === 'opened' && n) prs.set(n.id, n)
    }
  }
  return {
    prompt: flat(turns[0]?.title ?? ses.title),
    edited: [...edited],
    commits: [...commits.values()],
    prs: [...prs.values()],
    deadEnds: turns.filter((t) => t.extra?.deadEnd).map((t) => flat(String(t.extra.deadEnd))),
  }
}

/** One line per fact, for a digest entry. */
export function factLines(f: SessionFacts): string[] {
  const out = [`asked: "${cut(f.prompt, 140)}"`]
  if (f.edited.length) out.push(`edited ${f.edited.length} file${f.edited.length === 1 ? '' : 's'}: ${list(f.edited, 6)}`)
  if (f.commits.length) out.push(`commits: ${list(f.commits.map((n) => `${String(n.extra?.sha ?? n.id.split(':').pop()).slice(0, 7)} "${cut(n.title, 60)}"`), 4)}`)
  if (f.prs.length) out.push(`PRs: ${list(f.prs.map((n) => `#${n.id.split('#').pop()} "${cut(n.title, 60)}"`), 4)}`)
  if (f.deadEnds.length) out.push(`dead ends: ${list(f.deadEnds.map((d) => cut(d, 100)), 3)}`)
  return out
}

/** Own chats (not a teammate's) in scope that were active after `since`, newest first. */
export function recentSessions(g: Graph, since: number): Node[] {
  return g.ofKind('session').filter((s) => g.inScope(s) && !s.extra?.team && Date.parse(s.until || s.at) >= since).sort((a, b) => Date.parse(b.until || b.at) - Date.parse(a.until || a.at))
}

export function digest(g: Graph, since: number, max = 30): string {
  const ses = recentSessions(g, since)
  const head = `digest since ${local(new Date(since).toISOString())}: ${ses.length ? `${ses.length} chat${ses.length === 1 ? '' : 's'}, newest first; read one with \`thenwise get <id>\`` : 'no chats recorded'}`
  const blocks = ses.slice(0, max).map((s) => {
    const lines = factLines(sessionFacts(g, s))
    return [`- ${local(s.at)} to ${local(s.until || s.at).slice(11)} · ${s.extra?.tool ?? 'Claude Code'} · ${basename(g.rootOf(s) || String(s.extra?.cwd ?? '')) || s.project} · ${s.id}`, ...lines.map((l) => `   ${l}`)].join('\n')
  })
  if (ses.length > max) blocks.push(`(${ses.length - max} older chats left out; narrow with --since)`)
  return [head, ...blocks].join('\n')
}
