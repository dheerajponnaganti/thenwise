// Decision expiry: a decision about some files, then a later commit that changes them, asks in the inbox whether the
// decision still holds. Decisions come from accepted notes (with the files `thenwise decide` recorded, or the files of the
// commit they came from) and from `Decision:` trailers in commits (the commit's files). Accepting the question closes an
// accepted decision as superseded; rejecting it keeps the decision. No model.

import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { normPath } from '../core/vault-index.ts'
import { Graph } from '../query/engine.ts'
import { makeId, readNotes, saveNote } from './notes.ts'

interface Decision { ref: string; title: string; at: string; files: Set<string>; own: Set<string>; supersedes: string; project: string }
interface Change { id: string; ms: number; title: string; sha: string }

// One file can be stored under two spellings (a symlinked folder, /var and /private/var on macOS): compare real paths.
// A deleted file has no real path, so its folder's is used.
const seen = new Map<string, string>()
const canon = (p: string): string => {
  if (!seen.has(p)) {
    let r = p
    try {
      r = realpathSync(p)
    } catch {
      try {
        r = join(realpathSync(dirname(p)), basename(p))
      } catch { /* the folder is gone too: keep the path as stored */ }
    }
    seen.set(p, normPath(r))
  }
  return seen.get(p)!
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s)
const day = (at: string) => at.slice(0, 10)

/** Writes "changed since decided" questions to the inbox; returns how many were new. `off` is the paused-folder check:
 * their decisions and commits ask nothing. */
export function proposeExpiry(memDir: string, dbPath: string, now = new Date(), off?: (folder: string) => boolean): number {
  const notes = readNotes(memDir)
  const g = new Graph(dbPath, { lazy: true }) // it swaps in a rebuilt store first
  g.off = off
  const db = g.db
  const hidden = (id: string) => {
    const n = g.nodes.get(id)
    return !!n && g.paused(n)
  }
  let decisions: Decision[] = []
  const later = new Map<string, { id: string; at: string; title: string; sha: string; files: string[] }>()
  try {
    const changed = db.prepare("SELECT dst FROM edges WHERE src = ? AND kind = 'changed' AND dst LIKE 'file:%'")
    const filesOf = (commit: string) => (changed.all(commit) as { dst: string }[]).map((r) => r.dst.slice(5))
    const commit = db.prepare("SELECT id, at, title, project, extra FROM nodes WHERE id = ? AND kind = 'commit'")
    // The commits a session's turns made: the decision's own landing, never a change to it.
    const made = db.prepare("SELECT m.dst FROM edges m JOIN edges p ON p.src = m.src AND p.kind = 'part_of' AND p.dst = ? WHERE m.kind = 'made'")
    // 1. Accepted decision notes: their own files, and the files of a commit they came from.
    for (const n of notes) {
      if (n.type !== 'decision' || n.status !== 'active') continue
      const from = n.sources.find((s) => commit.get(s))
      const files = new Set([...(n.files ?? []).map(normPath), ...(from ? filesOf(from) : [])])
      const own = new Set([from ?? '', ...n.sources.filter((s) => s.startsWith('ses:')).flatMap((s) => (made.all(s) as { dst: string }[]).map((r) => r.dst))])
      if (files.size) decisions.push({ ref: `curated:${n.id}`, title: n.title, at: n.valid_from || n.created, files, own, supersedes: n.id, project: n.project })
    }
    // 2. `Decision:` trailers in commits nobody has accepted or rejected as a note yet.
    const known = new Map(notes.map((n) => [n.id, n.status]))
    for (const r of db.prepare("SELECT id, at, title, project, extra FROM nodes WHERE kind = 'commit' AND extra LIKE '%\"trailers\"%'").all() as { id: string; at: string; project: string; extra: string }[]) {
      for (const d of (JSON.parse(r.extra).trailers?.decision as string[] | undefined) ?? []) {
        const title = d.slice(0, 120)
        const status = known.get(makeId('tr', `${r.id}\0decision\0${title}`))
        if (status === 'active' || status === 'rejected' || status === 'superseded') continue // an accepted one is above; a rejected one is no decision
        const files = new Set(filesOf(r.id))
        if (files.size) decisions.push({ ref: r.id, title, at: r.at, files, own: new Set([r.id]), supersedes: '', project: r.project })
      }
    }
    decisions = decisions.filter((d) => !hidden(d.ref))
    // The newest commit after each decision that changed one of its files. Only commits newer than the oldest decision are read.
    const oldest = decisions.map((d) => d.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] // times carry different offsets: order by time, not text
    const rows = oldest ? (db.prepare("SELECT n.id, n.at, n.title, json_extract(n.extra, '$.sha') AS sha, e.dst FROM edges e JOIN nodes n ON n.id = e.src WHERE e.kind = 'changed' AND n.kind = 'commit' AND julianday(n.at) > julianday(?) AND e.dst LIKE 'file:%'").all(oldest) as { id: string; at: string; title: string; sha: string; dst: string }[]) : []
    // Each file's later commits, read once (stash commits are no change to the code).
    const byFile = new Map<string, Change[]>()
    for (const c of rows) {
      if (/^(WIP on|index on|On) [^\s:]+:/.test(c.title) || hidden(c.id)) continue
      const f = canon(c.dst.slice(5))
      byFile.set(f, [...(byFile.get(f) ?? []), { id: c.id, ms: Date.parse(c.at), title: c.title, sha: c.sha }])
    }
    const atOf = new Map(rows.map((c) => [c.id, c.at]))
    for (const d of decisions) {
      const mine = [...new Set([...d.files].map(canon))]
      const since = Date.parse(d.at)
      let best: Change | undefined
      for (const f of mine) for (const c of byFile.get(f) ?? []) if (!d.own.has(c.id) && c.ms > since && (!best || c.ms > best.ms)) best = c
      if (best) later.set(d.ref, { id: best.id, at: atOf.get(best.id)!, title: best.title, sha: best.sha, files: mine.filter((f) => byFile.get(f)?.some((c) => c.id === best!.id)) })
    }
  } finally {
    db.close()
  }
  const have = new Set(notes.map((n) => n.id))
  // One open question per decision: while one waits in the inbox, a newer commit does not add another.
  const waiting = new Set(notes.filter((n) => n.status === 'inbox' && n.id.startsWith('exp-')).map((n) => n.sources[0]))
  let wrote = 0
  for (const d of decisions) {
    const c = later.get(d.ref)
    if (!c || waiting.has(d.ref)) continue
    const id = makeId('exp', `${d.ref}\0${c.id}`)
    if (have.has(id)) continue
    have.add(id)
    const names = c.files.map((f) => f.split('/').slice(-2).join('/'))
    const after = d.supersedes ? 'Accept if the decision no longer holds: it is closed as superseded. Reject if it still holds.' : 'Accept to record that it changed. Reject if the decision still holds.'
    saveNote(memDir, { id, type: 'finding', title: `Changed since decided: ${cut(d.title, 80)}`, summary: `"${cut(d.title, 160)}" was decided on ${day(d.at)}. Commit ${String(c.sha ?? c.id.split(':').pop()).slice(0, 7)} "${cut(c.title, 80)}" on ${day(c.at)} changed ${names.join(', ')}, which the decision is about. ${after}`, status: 'inbox', valid_from: c.at, valid_to: '', supersedes: d.supersedes, sources: [d.ref, c.id], created: now.toISOString(), project: d.project, path: '', files: c.files })
    wrote++
  }
  return wrote
}
