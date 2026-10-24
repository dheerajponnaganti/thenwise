// `thenwise vault write`: curated Markdown notes in <vault>/_thenwise/ for people to read in Obsidian.
// Decisions, dead ends, a timeline and file histories per project. Short lines with source ids and dates; no chat text.
// A note is rewritten only when its text changed. A note a person edited is saved to .edited/ first. No model.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parseFrontMatter, quote } from '../core/frontmatter.ts'
import { maskSecrets } from '../core/secrets.ts'
import type { Config } from '../ingest/config.ts'
import { Graph, local } from '../query/engine.ts'
import type { Node } from '../query/engine.ts'
import { cut, repo, sessionProjects, sourceOf } from '../views/views.ts'
import { OURS, skippedNotes } from './user.ts'

export const VAULT_FORMAT = 1
export const NOTE_CAP = 300
const TOP_FILES = 30
const MAX_IDS = 200
const STATE = '.state.json'

export interface VaultResult {
  dir: string
  notes: number
  written: number
  unchanged: number
  removed: number
  /** Edited notes whose text was saved aside before the rewrite. */
  saved: string[]
  /** iCloud conflict copies and user notes with broken front matter, left alone. */
  reported: string[]
  /** Notes left out because of the cap. */
  capped: number
  /** Why nothing was written, when that is the case. */
  stopped?: string
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** A name safe on macOS, Windows and Linux, and in a wiki link. */
export function safeName(s: string): string {
  let n = s.replace(/[\x00-\x1f\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').replace(/-{2,}/g, '-').trim().replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 100).replace(/[.\s]+$/, '')
  if (!n) n = 'untitled'
  if (RESERVED.test(n.split('.')[0]!)) n = `_${n}`

  return n
}
/** A safe name nobody else has used (case-insensitive); a clash gets a short hash of its key. */
function unique(used: Set<string>, name: string, key: string): string {
  let n = safeName(name)
  if (used.has(n.toLowerCase())) n = `${n.slice(0, 90)}-${sha(key).slice(0, 6)}`
  used.add(n.toLowerCase())

  return n
}

interface Item {
  n: Node
  text: string
}
interface Draft {
  group: string
  kind: 'Decisions' | 'Dead ends' | 'Timeline' | 'File'
  name: string
  title: string
  items: Item[]
  rank: number
}

function drafts(g: Graph, projects: Config['viewProjects'], perProject: boolean): { drafts: Draft[]; groups: Map<string, string> } {
  const { projectOf, touchedBy } = sessionProjects(g, projects)
  const projOf = (n: Node) => (n.kind === 'session' ? projectOf.get(n.id) : n.kind === 'summary' ? projectOf.get(n.source) : n.kind === 'pr' || n.kind === 'commit' ? repo(n.project) : n.project) || n.project || 'general'
  const sets = new Map<string, { decisions: Item[]; dead: Item[]; time: Item[] }>()
  const of = (p: string) => sets.get(p) ?? sets.set(p, { decisions: [], dead: [], time: [] }).get(p)!
  const gname = (p: string) => (perProject ? p : '')
  for (const n of g.nodes.values()) {
    const p = gname(projOf(n))
    const t = n.extra.trailers as Record<string, string[]> | undefined
    if (n.kind === 'pr') of(p).time.push({ n, text: `PR #${n.id.split('#').pop()}: ${cut(n.title, 140)}${n.until ? ` (merged ${local(n.until).slice(0, 10)})` : ` (${String(n.extra.state ?? 'open').toLowerCase()})`}` })
    else if (n.kind === 'session') of(p).time.push({ n, text: 'session began' })
    else if (n.kind === 'summary') of(p).time.push({ n, text: 'compaction summary written' })
    if (n.kind === 'commit' && t?.decision) of(p).decisions.push({ n, text: `${cut(t.decision.join('; '), 160)}${t.why ? ` Why: ${cut(t.why.join('; '), 160)}` : ''}` })
    if (n.kind === 'commit' && t?.['dead-end']) of(p).dead.push({ n, text: cut(t['dead-end'].join('; '), 200) })
    if (n.extra.curated && n.kind === 'decision') of(p).decisions.push({ n, text: cut(n.title, 160) })
    if (n.extra.curated && n.kind === 'dead_end') of(p).dead.push({ n, text: cut(n.title, 160) })
  }
  const histories = new Map<string, Map<string, Node>>()
  const touch = (file: string, n: Node) => (histories.get(file) ?? histories.set(file, new Map()).get(file)!).set(n.id, n)
  for (const [file, ids] of touchedBy) for (const id of ids) touch(file, g.nodes.get(id)!)
  for (const n of g.nodes.values()) {
    if (!['pr', 'commit', 'note', 'summary'].includes(n.kind)) continue
    for (const e of g.adj.get(n.id) ?? []) if (e.out && g.nodes.get(e.to)?.kind === 'file' && ['touches', 'changed', 'mentions'].includes(e.kind)) touch(e.to, n)
  }
  const out: Draft[] = []
  const groups = new Map<string, string>()
  const used = new Set<string>()
  const projNames = [...sets.keys()].sort()
  for (const p of projNames) groups.set(p, p ? unique(used, p, p) : '')
  const sorted = (items: Item[]) => items.sort((a, b) => (Date.parse(a.n.at) || 0) - (Date.parse(b.n.at) || 0) || (a.n.id < b.n.id ? -1 : 1))
  for (const p of projNames) {
    const s = sets.get(p)!
    const label = p || 'all projects'
    out.push({ group: p, kind: 'Decisions', name: 'Decisions', title: `Decisions: ${label}`, items: sorted(s.decisions), rank: 0 })
    out.push({ group: p, kind: 'Dead ends', name: 'Dead ends', title: `Dead ends: ${label}`, items: sorted(s.dead), rank: 0 })
    out.push({ group: p, kind: 'Timeline', name: 'Timeline', title: `Timeline: ${label}`, items: sorted(s.time), rank: 0 })
  }
  const top = [...histories].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
  const perGroup = new Map<string, number>()
  const fileUsed = new Map<string, Set<string>>()
  for (const [file, items] of top) {
    const f = g.nodes.get(file)!
    const votes = new Map<string, number>()
    for (const n of items.values()) votes.set(gname(projOf(n)), (votes.get(gname(projOf(n))) ?? 0) + 1)
    const p = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]
    if (!groups.has(p)) continue
    if ((perGroup.get(p) ?? 0) >= TOP_FILES) continue
    perGroup.set(p, (perGroup.get(p) ?? 0) + 1)
    const name = (f.extra.aliases as string[] | undefined)?.[0] ?? file.slice(5)
    const u = fileUsed.get(p) ?? fileUsed.set(p, new Set()).get(p)!
    const lines = [...items.values()].map((n) => ({ n, text: n.kind === 'pr' || n.kind === 'commit' || n.kind === 'note' ? cut(n.title, 140) : n.kind === 'summary' ? 'compaction summary' : n.kind === 'turn' ? 'turn' : n.kind }))
    out.push({ group: p, kind: 'File', name: unique(u, name, file), title: `File: ${name}`, items: lines.sort((a, b) => (Date.parse(b.n.at) || 0) - (Date.parse(a.n.at) || 0) || (a.n.id < b.n.id ? -1 : 1)), rank: items.size })
  }

  return { drafts: out, groups }
}

const BANNER = '> Generated by Thenwise. It is rewritten on every sync. If you edit this note, your version is saved in `.edited` first.'
function render(project: string, title: string, ids: string[], body: string[]): string {
  const list = `[${[...new Set(ids)].slice(0, MAX_IDS).map(quote).join(', ')}]`
  const text = `---\nthenwise: ${VAULT_FORMAT}\nproject: ${quote(project)}\nsources: ${list}\n---\n\n${BANNER}\n\n# ${title}\n\n${body.join('\n')}\n`

  return maskSecrets(text).text
}

/** The notes to write: relative path (inside _thenwise) to text. */
export function buildNotes(g: Graph, cfg: Pick<Config, 'viewProjects'>, layout: string): { notes: Map<string, string>; capped: number } {
  const perProject = layout === 'per-project'
  const { drafts: all, groups } = drafts(g, cfg.viewProjects, perProject)
  const core = all.filter((d) => d.kind !== 'File' && (d.items.length || d.kind === 'Timeline'))
  const files = all.filter((d) => d.kind === 'File').sort((a, b) => b.rank - a.rank || (a.group + a.name < b.group + b.name ? -1 : 1))
  // shortcut: decisions, dead ends and timelines are never cut, so more than 100 projects can pass the cap; cap them then.
  const room = Math.max(0, NOTE_CAP - core.length - groups.size)
  const kept = [...core, ...files.slice(0, room)]
  const dir = (d: Draft) => (groups.get(d.group) ? `${groups.get(d.group)}/` : '')
  const path = (d: Draft) => `${dir(d)}${d.kind === 'File' ? `Files/${d.name}` : d.name}`
  const link = (d: Draft) => `[[${OURS}/${path(d)}|${d.kind === 'File' ? d.title.slice(6).replace(/[\]|[]/g, ' ') : d.kind}]]`
  const notes = new Map<string, string>()
  for (const d of kept) {
    const label = d.group || 'all'
    const body = d.items.map((x) => `- ${local(x.n.at)}  ${perProject ? '' : x.n.project ? `[${repo(x.n.project)}] ` : ''}${x.text}  (${sourceOf(x.n)}, \`${x.n.id}\`)`.replace(/\s+/g, ' '))
    notes.set(`${path(d)}.md`, render(label, d.title, d.items.map((x) => x.n.id), [`[[${OURS}/${dir(d)}Index|Index]]`, '', ...(body.length ? body : ['No entries.'])]))
  }
  for (const [p, folder] of groups) {
    const mine = kept.filter((d) => d.group === p)
    const label = p || 'all'
    const body = ['## Notes', '', ...mine.filter((d) => d.kind !== 'File').map((d) => `- ${link(d)} (${d.items.length})`)]
    const fs = mine.filter((d) => d.kind === 'File')
    if (fs.length) body.push('', '## Files with the most history', '', ...fs.map((d) => `- ${link(d)} (${d.rank})`))
    notes.set(`${folder ? `${folder}/` : ''}Index.md`, render(label, `Thenwise: ${label}`, [], body))
  }

  return { notes, capped: files.length - Math.min(files.length, room) }
}

const readState = (dir: string): { format: number; files: Record<string, string> } => {
  try {
    const s = JSON.parse(readFileSync(join(dir, STATE), 'utf8'))
    return { format: Number(s.format ?? VAULT_FORMAT), files: s.files ?? {} }
  } catch {
    return { format: VAULT_FORMAT, files: {} }
  }
}
function atomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}
const mdFiles = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true, withFileTypes: true }) as any[]).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => join(e.parentPath, e.name)) : [])

export function writeVault(cfg: Config, opts: { db?: string; now?: Date } = {}): VaultResult {
  const none: VaultResult = { dir: '', notes: 0, written: 0, unchanged: 0, removed: 0, saved: [], reported: [], capped: 0 }
  if (!cfg.vault) return { ...none, stopped: 'no vault is set up, so nothing was written' }
  const root = resolve(cfg.vault.path)
  const dir = join(root, OURS)
  const res = { ...none, dir }
  // Never create the vault itself: a missing folder or an unmounted drive must not leave a new vault behind.
  if (!cfg.vault.path || !existsSync(root) || !statSync(root).isDirectory()) return { ...res, stopped: `the vault folder ${root} was not found (moved, deleted or not mounted); nothing was written` }
  const dbPath = opts.db ?? join(cfg.memDir, 'graph.db')
  if (!existsSync(dbPath)) return { ...res, stopped: `no graph at ${dbPath}: run \`thenwise ingest\`` }
  const state = readState(dir)
  const newer = state.format > VAULT_FORMAT || mdFiles(dir).some((f) => Number(parseFrontMatter(readFileSync(f, 'utf8')).data.thenwise ?? 0) > VAULT_FORMAT)
  if (newer) return { ...res, stopped: `${dir} was written by a newer Thenwise (note format above ${VAULT_FORMAT}). Update Thenwise; nothing was written.` }

  const g = new Graph(dbPath)
  const { notes, capped } = buildNotes(g, cfg, cfg.vault.layout)
  g.db.close()

  const day = (opts.now ?? new Date()).toISOString().slice(0, 10)
  const aside = (rel: string, old: string) => {
    const flat = rel.replace(/\.md$/, '').replace(/\//g, ' - ')
    let p = join(dir, '.edited', `${flat} ${day}.md`)
    for (let i = 2; existsSync(p); i++) p = join(dir, '.edited', `${flat} ${day}-${i}.md`)
    atomic(p, old)
    res.saved.push(`${rel} was edited; your version is in ${p}`)
  }
  const files: Record<string, string> = {}
  for (const [rel, text] of notes) {
    const p = join(dir, rel)
    const want = sha(text)
    files[rel] = want
    const old = existsSync(p) ? readFileSync(p, 'utf8') : undefined
    if (old === text) {
      res.unchanged++
      continue
    }
    if (old !== undefined && sha(old) !== state.files[rel]) aside(rel, old)
    atomic(p, text)
    res.written++
  }
  for (const [rel, h] of Object.entries(state.files)) {
    if (notes.has(rel)) continue
    const p = join(dir, rel)
    if (!existsSync(p)) continue
    const old = readFileSync(p, 'utf8')
    if (sha(old) !== h) aside(rel, old)
    rmSync(p)
    res.removed++
    for (let d = dirname(p); d !== dir && !readdirSync(d).length; d = dirname(d)) rmdirSync(d)
  }
  atomic(join(dir, STATE), `${JSON.stringify({ format: VAULT_FORMAT, files }, null, 2)}\n`)

  // Conflict copies of our notes ("Decisions 2.md") are left alone and reported. So are user notes ingest skips.
  const COPY = /^(.+) \d+\.md$/
  for (const f of mdFiles(dir)) if (COPY.test(f.slice(dir.length + 1)) && !f.includes('/.edited/') && !notes.has(f.slice(dir.length + 1))) res.reported.push(`conflict copy: ${f}`)
  res.reported.push(...skippedNotes([...cfg.vaults, root]))

  return { ...res, notes: notes.size, capped }
}
