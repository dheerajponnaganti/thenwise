// Helpers for the vault writer: the project of each chat, source lines and cuts. The `views` command that also used
// them is gone; the vault writer replaced it.

import { basename } from 'node:path'

import { Graph } from '../query/engine.ts'
import type { Node } from '../query/engine.ts'


const flat = (s: string) => s.replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim()
export const cut = (s: string, n: number) => (flat(s).length > n ? `${flat(s).slice(0, n).trimEnd()}...` : flat(s))
const short = (id: string) => id.replace(/^(ses|turn|sum):(.{8}).*$/, '$1:$2')
// A private mirror repo named "<name>-private" shares its timeline with the repo it mirrors.
export const repo = (p: string) => p.replace(/-private$/, '')


export function sourceOf(n: Node): string {
  if (n.kind === 'pr') return `[PR #${n.id.split('#').pop()}](${n.extra.url ?? n.source})`
  if (n.kind === 'commit') return `commit ${n.id.split(':').pop()!.slice(0, 7)} in ${n.project}`
  if (n.kind === 'summary') return `summary of ${short(n.source)}`
  if (n.kind === 'session') return `session ${short(n.id)}`
  if (n.kind === 'note' || n.kind === 'section') return `note ${basename(n.source, '.md')}`
  return n.id
}

/** The project folder a file sits in: the first folder under the home folder, with worktrees counted as their repo. */
export function folderOf(fileId: string): string | undefined {
  const m = /^file:\/(?:Users|home)\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(fileId)
  if (!m || m[1]!.startsWith('.')) return undefined
  return m[1]
}

/** The project of each session, and the sessions that touched each file. */
export function sessionProjects(g: Graph, projects: { name: string; words: string[]; paths: string[] }[] = []) {
  // A session belongs to the repo whose commits and PRs its turns made or opened; failing that, to the top folder its
  // turns worked in most (a chat run from the home folder about ~/my-project is that project's); failing that, its cwd.
  const sessions = [...g.nodes.values()].filter((n) => n.kind === 'session')
  const projectOf = new Map<string, string>()
  const touchedBy = new Map<string, Set<string>>() // file id -> sessions/PRs/commits/notes that touched it
  for (const s of sessions) {
    const votes = new Map<string, number>()
    const folders = new Map<string, number>()
    const named = new Set<string>()
    for (const e of g.adj.get(s.id) ?? []) {
      if (e.kind !== 'part_of' || e.out) continue
      for (const t of g.adj.get(e.to) ?? []) {
        const x = g.nodes.get(t.to)
        if (t.out && (t.kind === 'made' || t.kind === 'opened') && x) votes.set(repo(x.project), (votes.get(repo(x.project)) ?? 0) + 1)
        if (t.out && x?.kind === 'file' && (t.kind === 'edited' || t.kind === 'ran_in'))
          for (const p of projects ?? []) if (p.paths.some((r) => x.id.slice(5) === r || x.id.slice(5).startsWith(`${r}/`))) named.add(p.name)
        if (t.out && x?.kind === 'file' && t.kind !== 'mentions') {
          ;(touchedBy.get(x.id) ?? touchedBy.set(x.id, new Set()).get(x.id)!).add(s.id)
          const f = folderOf(x.id)
          // Where a chat wrote and ran things says more about its project than what it read.
          if (f) folders.set(f, (folders.get(f) ?? 0) + (t.kind === 'edited' || t.kind === 'ran_in' ? 3 : 1))
        }
      }
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]
    const folder = [...folders].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0]
    // A named project the owner configured wins: its words in the chat's first prompt, or its folders edited.
    const first = `${s.title} ${g.fullText(s.id)}`.toLowerCase()
    const chosen = (projects ?? []).find((p) => named.has(p.name) || p.words.some((w) => first.includes(w)))?.name
    projectOf.set(s.id, chosen ?? best ?? folder ?? (basename(String(s.extra.cwd ?? '')) || s.project))
  }

  return { projectOf, touchedBy }
}
