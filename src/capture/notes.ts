// The curated notes store: ~/.memory/notes/<type>/<slug>.md. Markdown with front matter is the truth.
// Inbox, rejected and expired notes stay on disk but never enter the graph.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseFrontMatter, yamlValue } from '../core/frontmatter.ts'
import type { Scalar } from '../core/frontmatter.ts'

export const TYPES = ['decision', 'dead_end', 'finding', 'rule', 'now'] as const
export type NoteType = (typeof TYPES)[number]
export type Status = 'inbox' | 'active' | 'rejected' | 'superseded' | 'expired'
export const EXPIRY_DAYS = 14

export interface CNote {
  id: string
  type: NoteType
  title: string
  summary: string
  status: Status
  valid_from: string
  valid_to: string
  supersedes: string
  sources: string[]
  created: string
  project: string
  path: string
}

const FIELDS = ['id', 'type', 'title', 'summary', 'status', 'valid_from', 'valid_to', 'supersedes', 'sources', 'created', 'project'] as const
export const notesDir = (memDir: string) => join(memDir, 'notes')
export const makeId = (prefix: string, key: string) => `${prefix}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`

const slug = (n: CNote) => `${n.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note'}-${n.id.slice(-4)}`

export function readNotes(memDir: string): CNote[] {
  const out: CNote[] = []
  const root = notesDir(memDir)
  if (!existsSync(root)) return out
  for (const t of readdirSync(root).sort()) {
    if (!(TYPES as readonly string[]).includes(t)) continue
    for (const f of readdirSync(join(root, t)).filter((x) => x.endsWith('.md')).sort()) {
      const path = join(root, t, f)
      const d = parseFrontMatter(readFileSync(path, 'utf8')).data
      const s = (k: string) => (d[k] == null ? '' : String(d[k]))
      if (!s('id')) continue
      out.push({ id: s('id'), type: t as NoteType, title: s('title'), summary: s('summary'), status: (s('status') || 'inbox') as Status, valid_from: s('valid_from'), valid_to: s('valid_to'), supersedes: s('supersedes'), sources: Array.isArray(d.sources) ? d.sources.map(String) : [], created: s('created'), project: s('project'), path })
    }
  }
  return out
}

export function saveNote(memDir: string, n: CNote): CNote {
  if (!n.path) {
    mkdirSync(join(notesDir(memDir), n.type), { recursive: true, mode: 0o700 })
    n.path = join(notesDir(memDir), n.type, `${slug(n)}.md`)
  }
  const fm = FIELDS.map((k) => {
    const v = n[k] as Scalar | Scalar[]
    return `${k}: ${yamlValue(v === '' ? null : v)}`
  })
  writeFileSync(n.path, `---\n${fm.join('\n')}\n---\n${n.summary}\n`, { mode: 0o600 })

  return n
}

export function expireInbox(memDir: string, nowMs: number): string[] {
  const out: string[] = []
  for (const n of readNotes(memDir)) {
    if (n.status === 'inbox' && nowMs - Date.parse(n.created) > EXPIRY_DAYS * 86400000) {
      saveNote(memDir, { ...n, status: 'expired' })
      out.push(n.id)
    }
  }

  return out
}

/** Accept inbox (or expired) notes. A note that supersedes another closes it, with valid_to = the new valid_from. */
export function accept(memDir: string, pick: { ids?: string[]; type?: string }, nowIso: string): string[] {
  const all = readNotes(memDir)
  const msgs: string[] = []
  const targets = pick.type ? all.filter((n) => n.type === pick.type && n.status === 'inbox') : (pick.ids ?? []).map((id) => all.find((n) => n.id === id) ?? id)
  for (const t of targets) {
    if (typeof t === 'string') msgs.push(`${t}: no such note`)
    else if (t.status !== 'inbox' && t.status !== 'expired') msgs.push(`${t.id}: is ${t.status}, not in the inbox`)
    else {
      saveNote(memDir, { ...t, status: 'active', valid_from: nowIso })
      const old = t.supersedes ? all.find((n) => n.id === t.supersedes) : undefined
      if (old && old.status === 'active') saveNote(memDir, { ...old, status: 'superseded', valid_to: nowIso })
      msgs.push(`${t.id}: accepted${old ? `, ${old.id} superseded` : ''}`)
    }
  }

  return msgs
}

export function reject(memDir: string, ids: string[]): string[] {
  const all = readNotes(memDir)

  return ids.map((id) => {
    const n = all.find((x) => x.id === id)
    if (!n) return `${id}: no such note`
    if (n.status !== 'inbox' && n.status !== 'expired') return `${id}: is ${n.status}, not in the inbox`
    saveNote(memDir, { ...n, status: 'rejected' })

    return `${id}: rejected`
  })
}

export interface TrailerItem {
  type: 'decision' | 'dead_end'
  title: string
  summary: string
  source: string
  at: string
  project: string
}

/** `Decision:` (with the matching `Why:`) and `Dead-end:` lines in commit or PR text. */
export function parseTrailers(text: string, source: string, at: string, project: string): TrailerItem[] {
  const by: Record<string, string[]> = { decision: [], why: [], 'dead-end': [] }
  for (const m of text.matchAll(/^(Decision|Why|Dead-end):[ \t]*(.+)$/gim)) by[m[1]!.toLowerCase()]!.push(m[2]!.trim())
  const out: TrailerItem[] = by.decision!.map((d, i) => ({ type: 'decision', title: d.slice(0, 120), summary: by.why![i] ? `${d}. Why: ${by.why![i]}` : d, source, at, project }))
  for (const d of by['dead-end']!) out.push({ type: 'dead_end', title: d.slice(0, 120), summary: d, source, at, project })

  return out
}

/** Trailers wait in the inbox: anyone who lands a commit or a PR can write one, so the owner decides what becomes a note.
 * The id comes from the source and text, so a second run writes nothing, and a note the owner later rejected or edited stays as it is.
 * `created` is now: an inbox note expires by it, and a trailer in an old commit is new to the owner. */
export function syncTrailers(memDir: string, items: TrailerItem[]): number {
  const have = new Set(readNotes(memDir).map((n) => n.id))
  let wrote = 0
  for (const it of items) {
    const id = makeId('tr', `${it.source}\0${it.type}\0${it.title}`)
    if (have.has(id)) continue
    have.add(id)
    saveNote(memDir, { id, type: it.type, title: it.title, summary: it.summary, status: 'inbox', valid_from: it.at, valid_to: '', supersedes: '', sources: [it.source], created: new Date().toISOString(), project: it.project, path: '' })
    wrote++
  }

  return wrote
}
