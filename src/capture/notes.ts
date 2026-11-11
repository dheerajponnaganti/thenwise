// The curated notes store: ~/.memory/notes/<type>/<slug>.md. Markdown with front matter is the truth.
// Inbox, rejected and expired notes stay on disk but never enter the graph.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseFrontMatter, yamlValue } from '../core/frontmatter.ts'
import type { Scalar } from '../core/frontmatter.ts'
import { maskSecrets } from '../core/secrets.ts'
import { type Config, offCheck } from '../ingest/config.ts'
import { Graph } from '../query/engine.ts'

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
  /** Files the note is about, as absolute paths: a decision about them, a dead end hit there. Empty for most notes. */
  files?: string[]
}

const FIELDS = ['id', 'type', 'title', 'summary', 'status', 'valid_from', 'valid_to', 'supersedes', 'sources', 'created', 'project', 'files'] as const
export const notesDir = (memDir: string) => join(memDir, 'notes')
export const makeId = (prefix: string, key: string) => `${prefix}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`

const slug = (n: CNote) => `${n.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note'}-${n.id.slice(-4)}`

const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ').trim()
/** Front matter holds the summary on one line; the body below it keeps its line breaks. The body is used when it is the
 * same text, so a list keeps its lines; when the two differ (one was edited by hand), the front matter wins. */
const withLines = (summary: string, body: string) => (body.trim() && flat(body) === flat(summary) ? body.trim() : summary)

export function readNotes(memDir: string): CNote[] {
  const out: CNote[] = []
  const root = notesDir(memDir)
  if (!existsSync(root)) return out
  for (const t of readdirSync(root).sort()) {
    if (!(TYPES as readonly string[]).includes(t)) continue
    for (const f of readdirSync(join(root, t)).filter((x) => x.endsWith('.md')).sort()) {
      const path = join(root, t, f)
      const fm = parseFrontMatter(readFileSync(path, 'utf8'))
      const d = fm.data
      const s = (k: string) => (d[k] == null ? '' : String(d[k]))
      if (!s('id')) continue
      out.push({ id: s('id'), type: t as NoteType, title: s('title'), summary: withLines(s('summary'), fm.body), status: (s('status') || 'inbox') as Status, valid_from: s('valid_from'), valid_to: s('valid_to'), supersedes: s('supersedes'), sources: Array.isArray(d.sources) ? d.sources.map(String) : [], created: s('created'), project: s('project'), path, files: Array.isArray(d.files) ? d.files.map(String) : [] })
    }
  }
  return out
}

export function saveNote(memDir: string, n: CNote): CNote {
  // Masked before the file name is made from the title, so no part of a secret lands in the path either.
  n.title = maskSecrets(n.title).text
  n.summary = maskSecrets(n.summary).text
  if (!n.path) {
    mkdirSync(join(notesDir(memDir), n.type), { recursive: true, mode: 0o700 })
    n.path = join(notesDir(memDir), n.type, `${slug(n)}.md`)
  }
  // `files` is written only when there are some, so notes without files keep their old form.
  const fm = FIELDS.filter((k) => k !== 'files' || n.files?.length).map((k) => {
    const v = n[k] as Scalar | Scalar[]
    return `${k}: ${yamlValue(v === '' ? null : v)}`
  })
  writeFileSync(n.path, `---\n${fm.join('\n')}\n---\n${n.summary}\n`, { mode: 0o600 })

  return n
}

/** An unreviewed proposal older than EXPIRY_DAYS. Every place that shows the inbox expires these first, or leaves them out. */
export const overdue = (n: CNote, nowMs: number) => n.status === 'inbox' && nowMs - Date.parse(n.created) > EXPIRY_DAYS * 86400000

export function expireInbox(memDir: string, nowMs: number): string[] {
  const out: string[] = []
  for (const n of readNotes(memDir)) {
    if (overdue(n, nowMs)) {
      saveNote(memDir, { ...n, status: 'expired' })
      out.push(n.id)
    }
  }

  return out
}

/** The ids of these notes that `thenwise off` holds back: off for everything, a source in the store from a paused folder
 * (a chat, a commit, a PR), or a file in one. They are kept as they are and come back with `thenwise on`. */
export function pausedNotes(notes: CNote[], cfg: Pick<Config, 'off' | 'offProjects' | 'memDir'>, dbPath = join(cfg.memDir, 'graph.db')): Set<string> {
  const off = offCheck(cfg)
  if (!off || !notes.length) return new Set()
  if (cfg.off) return new Set(notes.map((n) => n.id))
  let g: Graph | undefined
  try {
    if (existsSync(dbPath)) (g = new Graph(dbPath, { lazy: true })).off = off
  } catch {} // no readable store: the files still say where a note is from
  const held = (id: string) => {
    const x = g?.nodes.get(id)
    return !!x && g!.paused(x)
  }
  try {
    return new Set(notes.filter((n) => (n.files ?? []).some(off) || n.sources.some(held)).map((n) => n.id))
  } finally {
    g?.db.close()
  }
}

/** Accept inbox (or expired) notes. A note keeps the date its evidence gives (a commit's `Decision:` line, a mined rule);
 * one with no date holds from now. A note that supersedes another closes it, with valid_to = the new valid_from. */
export function accept(memDir: string, pick: { ids?: string[]; type?: string }, nowIso: string): string[] {
  const all = readNotes(memDir)
  const msgs: string[] = []
  const targets = pick.type ? all.filter((n) => n.type === pick.type && n.status === 'inbox') : (pick.ids ?? []).map((id) => all.find((n) => n.id === id) ?? id)
  for (const t of targets) {
    if (typeof t === 'string') msgs.push(`${t}: no such note`)
    else if (t.status !== 'inbox' && t.status !== 'expired') msgs.push(`${t.id}: is ${t.status}, not in the inbox`)
    else {
      const from = t.valid_from || nowIso
      saveNote(memDir, { ...t, status: 'active', valid_from: from })
      const old = t.supersedes ? all.find((n) => n.id === t.supersedes) : undefined
      if (old && old.status === 'active') saveNote(memDir, { ...old, status: 'superseded', valid_to: from })
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
