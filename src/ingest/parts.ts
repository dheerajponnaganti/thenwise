// The pieces of the graph build that the full rebuild and the incremental update share. Everything here is a pure
// function of its inputs, so both paths produce the same nodes and edges.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, posix } from 'node:path'

import { parseFrontMatter } from '../core/frontmatter.ts'
import { maskSecrets } from '../core/secrets.ts'
import { normPath } from '../core/vault-index.ts'
import { parseTrailers, readNotes } from '../capture/notes.ts'
import type { TrailerItem } from '../capture/notes.ts'
import { globMatch } from './config.ts'
import type { Config } from './config.ts'
import { skipReason } from '../vault/user.ts'
import { commitDeadEnd, deadEnd } from './deadend.ts'
import { repoRoot } from './repos.ts'
import { normalizePath } from './transcript.ts'
import type { Session } from './transcript.ts'

export interface GNode {
  id: string
  kind: string
  title: string
  text: string
  at: string
  until: string
  project: string
  source: string
  extra: Record<string, unknown>
}
export interface GEdge {
  src: string
  dst: string
  kind: string
  at: string
  extra: Record<string, unknown>
}
export interface Part {
  nodes: GNode[]
  edges: GEdge[]
}

export const GENERATED = 'Memory v2/Generated/'
export const under = (p: string, root: string) => ((p, root) => p === root || p.startsWith(`${root}/`))(normPath(p), normPath(root))
export const cut = (at: string, until?: string) => !!until && !!at && Date.parse(at) > Date.parse(until)
export const iso = (ms: number) => new Date(ms).toISOString()
export const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v
export const edgeKey = (e: { src: string; dst: string; kind: string }) => `${e.src}\0${e.dst}\0${e.kind}`

// The one choke point: every record's title and text are masked before it is stored (chat text is masked already, a no-op).
export const fullNode = (n: Partial<GNode> & { id: string; kind: string }): GNode => {
  const o: GNode = { title: '', text: '', at: '', until: '', project: '', source: '', extra: {}, ...n }
  o.title = maskSecrets(o.title).text
  o.text = maskSecrets(o.text).text

  return o
}

/** A chat is a test chat when its first prompt starts or ends with a marker, or any prompt holds one alone on a line. */
export function isMarked(markers: string[], prompts: string[]): boolean {
  const first = (prompts[0] ?? '').trim()

  return markers.some((m) => first.startsWith(m) || first.endsWith(m) || prompts.some((p) => p.split('\n').some((l) => l.trim() === m)))
}
/** The same turn can appear in a resumed session; the fuller copy wins, and on a tie the first one, so order never matters. */
export const mergeNode = (old: GNode | undefined, n: GNode): GNode => (!old || n.text.length > old.text.length ? (old ? { ...n, extra: { ...old.extra, ...n.extra } } : n) : old)

export class Graph {
  nodes = new Map<string, GNode>()
  edges = new Map<string, GEdge>()
  node(n: Partial<GNode> & { id: string; kind: string }) {
    this.nodes.set(n.id, mergeNode(this.nodes.get(n.id), fullNode(n)))
  }
  edge(src: string, dst: string, kind: string, at = '', extra: Record<string, unknown> = {}) {
    const k = `${src}\0${dst}\0${kind}`
    if (!this.edges.has(k)) this.edges.set(k, { src, dst, kind, at, extra })
  }
}

// 1. Sessions ------------------------------------------------------------------------------------------------------

export type Status = 'in' | 'entry' | 'marker' | 'empty' | 'out'

/** Why a parsed chat is in or out of the memory. Test chats carry a marker in their prompts: their answers must never become memory. */
export function classify(cfg: Config, s: Session): Status {
  if (!cfg.includeEntrypoints.includes(s.entrypoint)) return 'entry'
  if (isMarked(cfg.ingestExcludeMarkers, s.turns.map((t) => t.prompt))) return 'marker'
  if (!s.start) return 'empty'

  return [s.cwd, ...s.paths].some((p) => p && cfg.roots.some((r) => under(p, r))) ? 'in' : 'out'
}

export interface Claim {
  node: string
  kind: 'sub' | 'sha' | 'url'
  val: string // subject, short sha or url
  at: string // when the message was written (subjects are matched to commits within 15 minutes of it)
  turnAt: string
}
export interface SessionPart extends Part {
  claims: Claim[]
}

/** Folders of the files a chat edited, for finding the repos it worked in. Bounded: 50 per chat. */
export const editDirs = (s: Session): string[] => [...new Set([...s.turns].flatMap((t) => [...t.edits].map((f) => posix.dirname(f))))].sort().slice(0, 50)
/** Those folders that lie under a root. */
export const workDirs = (cfg: Config, dirs: string[]) => dirs.filter((d) => cfg.roots.some((r) => under(d, r)))

/** What one chat file gives: its nodes (merged by id), its own edges, and the commit and PR references of its turns. */
export function sessionPart(s: Session, key: string): SessionPart {
  const nodes = new Map<string, GNode>()
  const edges = new Map<string, GEdge>()
  const claims: Claim[] = []
  const node = (n: Partial<GNode> & { id: string; kind: string }) => nodes.set(n.id, mergeNode(nodes.get(n.id), fullNode(n)))
  const edge = (src: string, dst: string, kind: string, at: string, extra: Record<string, unknown> = {}) => edges.has(`${src}\0${dst}\0${kind}`) || edges.set(`${src}\0${dst}\0${kind}`, { src, dst, kind, at, extra })
  const sid = `ses:${s.id}`
  const first = s.turns[0]?.prompt ?? ''
  // A subagent file adds turns to its parent, whose own file gives the session node.
  const dirs = editDirs(s)
  if (!s.sub) node({ id: sid, kind: 'session', title: first.split('\n')[0]!.slice(0, 200), text: first.slice(0, 2000), at: s.start, until: s.end, project: key, source: `${key}/${s.id}.jsonl`, extra: { cwd: s.cwd, ...(dirs.length ? { editDirs: dirs } : {}) } })
  for (const t of s.turns) {
    const tid = `turn:${t.id}`
    const de = deadEnd(t.reply.join('\n\n')) // the reply only: the prompt is the user's question
    node({ id: tid, kind: 'turn', title: t.prompt.split('\n')[0]!.slice(0, 200), text: [t.prompt, ...t.reply].join('\n\n'), at: t.at, project: key, source: sid, extra: { ...(s.sub ? { subagent: true } : {}), ...(de ? { deadEnd: de } : {}) } })
    edge(tid, sid, 'part_of', t.at)
    for (const [paths, kind] of [[t.reads, 'read'], [t.edits, 'edited'], [t.ran, 'ran_in']] as const) for (const p of paths) edge(tid, `file:${p}`, kind, t.at)
    for (const m of t.commitMsgs) claims.push({ node: tid, kind: 'sub', val: m.subject, at: m.at, turnAt: t.at })
    for (const short of t.commitShas) claims.push({ node: tid, kind: 'sha', val: short, at: t.at, turnAt: t.at })
    for (const u of t.prUrls) claims.push({ node: tid, kind: 'url', val: u, at: t.at, turnAt: t.at })
  }
  for (const m of s.summaries) {
    node({ id: `sum:${m.id}`, kind: 'summary', title: `Compaction summary of ${s.id}`, text: m.text, at: m.at, project: key, source: sid })
    edge(`sum:${m.id}`, sid, 'part_of', m.at)
    if (m.continuedFrom && m.continuedFrom !== s.id) edge(sid, `ses:${m.continuedFrom}`, 'continued_from', m.at, { summary: `sum:${m.id}` })
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], claims }
}

// 2. Commits -------------------------------------------------------------------------------------------------------

export const LOG_FORMAT = ['--name-only', '--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1d']

export interface CommitRec {
  node: GNode
  files: string[]
  trailers: TrailerItem[]
}
/** `main`: the shas on the default branch; each commit then says `onMain`. */
export function parseLog(raw: string, repo: string, until?: string, main?: Set<string>): CommitRec[] {
  const name = basename(repo)
  const out: CommitRec[] = []
  for (const rec of raw.split('\x1e').slice(1)) {
    const [head, rest = ''] = rec.split('\x1d')
    const [sha, date, subject, body = ''] = head!.split('\x1f')
    if (!sha || cut(date ?? '', until)) continue
    const files = rest.split('\n').map((l) => l.trim()).filter(Boolean).sort()
    const trailers: Record<string, string[]> = {}
    for (const m of body.matchAll(/^(Decision|Why|Dead-end):[ \t]*(.+)$/gim)) (trailers[m[1]!.toLowerCase()] ??= []).push(m[2]!.trim())
    const id = `commit:${name}:${sha}`
    const de = commitDeadEnd(subject ?? '', body)
    out.push({ node: fullNode({ id, kind: 'commit', title: subject ?? '', text: body.trim(), at: date ?? '', project: name, source: repo, extra: { files, sha, ...(de ? { deadEnd: de } : {}), ...(main ? { onMain: main.has(sha) } : {}), ...(Object.keys(trailers).length ? { trailers } : {}) } }), files, trailers: parseTrailers(maskSecrets(body).text, id, date ?? '', name) })
  }

  return out
}
export const commitEdges = (c: CommitRec): GEdge[] => c.files.map((f) => ({ src: c.node.id, dst: `file:${posix.join(c.node.source, f)}`, kind: 'changed', at: c.node.at, extra: {} }))

// 3. Pull requests -------------------------------------------------------------------------------------------------

export interface PrInput {
  full: string // owner/name
  list: any[]
  repo?: string // local checkout, when known
}
export interface PrPart extends Part {
  trailers: TrailerItem[]
  numbers: Map<number, string>
  ambiguous: Set<number>
  urls: Map<string, string>
}
export interface CommitLook {
  id(sha: string): string | undefined
  repo(sha: string): string | undefined
}

export function prPart(inputs: PrInput[], repos: string[], commit: CommitLook, until?: string): PrPart {
  const out: PrPart = { nodes: [], edges: [], trailers: [], numbers: new Map(), ambiguous: new Set(), urls: new Map() }
  for (const { full, list, repo: known } of inputs) {
    const name = full.split('/').pop()!
    const repo = known ?? repos.filter((r) => name.startsWith(basename(r))).sort((a, b) => basename(b).length - basename(a).length)[0]
    for (const p of [...list].sort((a, b) => a.number - b.number)) {
      if (cut(p.createdAt ?? '', until)) continue
      if (cut(p.mergedAt ?? '', until)) (p.mergedAt = null, p.mergeCommit = null, p.state = 'OPEN')
      const id = `pr:${name}#${p.number}`
      const url: string = p.url ?? `https://github.com/${full}/pull/${p.number}`
      // Review summaries (approve, request changes, comment) read like comments; inline review comments need one call per PR and are not fetched.
      const comments = [...(p.comments ?? []), ...(p.reviews ?? [])].map((c: any) => c.body ?? '').filter(Boolean)
      const mc: string | undefined = p.mergeCommit?.oid
      // Masked like the stored text, so a full build and an update derive the same trailer notes.
      out.trailers.push(...parseTrailers(maskSecrets([p.body ?? '', ...comments].join('\n')).text, id, p.createdAt ?? '', name))
      out.nodes.push(fullNode({ id, kind: 'pr', title: p.title ?? '', text: [p.body ?? '', ...comments].join('\n\n'), at: p.createdAt ?? '', until: p.mergedAt ?? '', project: name, source: url, extra: { state: p.state, head: p.headRefName, base: p.baseRefName, url, ...(repo ? { repo } : {}), ...(p.state === 'CLOSED' && !p.mergedAt ? { deadEnd: `PR closed without merging: ${p.title ?? ''}`.slice(0, 160) } : {}) } }))
      if (out.numbers.has(p.number)) out.ambiguous.add(p.number)
      out.numbers.set(p.number, id)
      out.urls.set(url, id)
      const cid = mc ? commit.id(mc) : undefined
      if (mc && cid) out.edges.push({ src: id, dst: cid, kind: 'merged_as', at: p.mergedAt ?? '', extra: {} })
      for (const f of p.files ?? []) {
        const repoPath = (mc && commit.repo(mc)) || repo
        if (!repoPath || !f.path) continue
        out.edges.push({ src: id, dst: `file:${posix.join(repoPath, f.path)}`, kind: 'touches', at: p.createdAt ?? '', extra: {} })
      }
    }
  }

  return out
}

// 4. Notes, rules, memory files, curated notes ---------------------------------------------------------------------

export function walk(dir: string, match: (name: string) => boolean, out: string[], depth = 0, skip?: (dir: string) => boolean) {
  if (depth > 7 || !existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // a folder this user cannot read is skipped, never fatal
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || (e.name.startsWith('.') && e.name !== '.claude')) continue
      if (!skip?.(join(dir, e.name))) walk(join(dir, e.name), match, out, depth + 1, skip)
    } else if (e.isFile() && match(e.name)) out.push(join(dir, e.name))
  }
}

const DATED_HEADING = /^#{2,4}\s+(.*?\b(\d{4}-\d{2}-\d{2})\b.*)$/gm

/** Splits Markdown at headings that carry a date. Returns [] (with the preamble) when fewer than two such headings exist. */
export function datedSections(body: string): { heading: string; date: string; body: string }[] & { preamble: string } {
  const marks = [...body.matchAll(DATED_HEADING)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, heading: m[1]!.trim(), date: m[2]! }))
  const out = marks.map((m, i) => ({ heading: m.heading, date: m.date, body: body.slice(m.end, marks[i + 1]?.at ?? body.length).trim() })) as { heading: string; date: string; body: string }[] & { preamble: string }
  out.preamble = marks.length ? body.slice(0, marks[0]!.at) : body

  return out
}

/** No front-matter date: the file's last commit when it sits in a git repo, else its mtime. */
function fileDate(f: string): string {
  if (repoRoot(dirname(f))) {
    try {
      const out = execFileSync('git', ['-C', dirname(f), 'log', '-1', '--format=%aI', '--', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
      if (out && !Number.isNaN(Date.parse(out))) return iso(Date.parse(out))
    } catch {} // git missing or slow: the file's mtime below is the date
  }

  return iso(statSync(f).mtimeMs)
}

export function notesPart(cfg: Config, until?: string): Part {
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const noteIds: { id: string; rel: string; lower: string; title: string; links: string[] }[] = []
  for (const vault of cfg.vaults) {
    const files: string[] = []
    walk(vault, (n) => n.endsWith('.md'), files)
    for (const f of files) {
      const rel = f.slice(vault.length + 1)
      if (rel.startsWith(GENERATED)) continue // `memory views` output: the memory never reads its own output
      const raw = readFileSync(f, 'utf8')
      if (skipReason(f, rel, raw)) continue // the vault writer's output, conflict copies, broken front matter
      const fm = parseFrontMatter(raw)
      const h1 = /^# (.+)$/m.exec(fm.body)?.[1]
      const title = String(fm.data.title ?? h1 ?? basename(f, '.md'))
      const date = fm.data.date ?? fm.data.created
      // Template placeholders such as {{date}} are not dates.
      const edited = fileDate(f)
      const at = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date) ? date : edited
      if (cut(at, until)) continue
      const id = `note:${cfg.vaults.length > 1 ? `${basename(vault)}/` : ''}${rel}`
      const links = [...fm.body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!.trim())
      // A note kept as a dated log (Build Log: "## 2026-10-13" sections) becomes one dated section node per heading, so
      // asof can tell what each day's entry said. The note keeps only the text before its first dated heading.
      const sections = datedSections(fm.body)
      // Paraphrase keys: `answers:` (questions the note answers) and `aliases:` are indexed like the title.
      const keys = Object.fromEntries((['answers', 'aliases'] as const).map((k) => [k, ([] as unknown[]).concat(fm.data[k] ?? []).filter((v): v is string => typeof v === 'string' && !!v)]).filter(([, v]) => (v as string[]).length))
      nodes.push(fullNode({ id, kind: 'note', title, text: (sections.length >= 2 ? sections.preamble : fm.body).trim(), at, until: typeof fm.data.valid_to === 'string' ? fm.data.valid_to : '', project: basename(vault), source: f, extra: { ...keys, edited } }))
      if (sections.length >= 2) {
        sections.forEach((sec, k) => {
          if (cut(sec.date, until)) return
          const sid = `${id}#${sec.date}-${k}`
          nodes.push(fullNode({ id: sid, kind: 'section', title: `${title}: ${sec.heading}`, text: `${sec.heading}\n\n${sec.body}`.trim(), at: sec.date, project: basename(vault), source: f }))
          edges.push({ src: sid, dst: id, kind: 'part_of', at: sec.date, extra: {} })
        })
      }
      noteIds.push({ id, rel: rel.replace(/\.md$/, '').toLowerCase(), lower: basename(f, '.md').toLowerCase(), title: title.toLowerCase(), links })
    }
  }
  const byName = new Map<string, string[]>()
  const byTitle = new Map<string, string>()
  for (const n of noteIds) {
    byName.set(n.lower, [...(byName.get(n.lower) ?? []), n.id])
    if (!byTitle.has(n.title)) byTitle.set(n.title, n.id)
  }
  const seen = new Set<string>()
  for (const n of noteIds) {
    for (const l of n.links) {
      const t = l.toLowerCase()
      const hits = byName.get(posix.basename(t)) ?? []
      // Name first (shortest path wins, as in Obsidian), then a path ending, then the title.
      const dst = (t.includes('/') ? noteIds.find((x) => x.rel === t || x.rel.endsWith(`/${t}`))?.id : [...hits].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0]) ?? byTitle.get(t)
      if (dst && dst !== n.id && !seen.has(`${n.id}\0${dst}`)) (seen.add(`${n.id}\0${dst}`), edges.push({ src: n.id, dst, kind: 'links_to', at: '', extra: { target: l } }))
    }
  }

  return { nodes, edges }
}

/** Owner-written curated notes. Inbox, rejected and expired notes stay out; a superseded note stays in, closed by its valid_to. */
export function curatedPart(cfg: Config, until?: string): Part {
  const out: Part = { nodes: [], edges: [] }
  for (const n of readNotes(cfg.memDir)) {
    if (n.status !== 'active' && n.status !== 'superseded') continue
    const at = n.valid_from || n.created
    if (cut(at, until)) continue
    const cid = `curated:${n.id}`
    out.nodes.push(fullNode({ id: cid, kind: n.type, title: n.title, text: n.summary, at, until: n.valid_to, project: n.project, source: n.path, extra: { curated: true, status: n.status, supersedes: n.supersedes } }))
    const seen = new Set<string>()
    for (const src of n.sources) seen.has(src) || (seen.add(src), out.edges.push({ src: cid, dst: src, kind: 'derived_from', at, extra: {} }))
    if (n.supersedes) out.edges.push({ src: cid, dst: `curated:${n.supersedes}`, kind: 'supersedes', at, extra: {} })
  }

  return out
}

/** CLAUDE.md rules. Worktrees and clones carry identical files: one per content, the shortest path (the main checkout). */
export function docsPart(cfg: Config): Part {
  const out: Part = { nodes: [], edges: [] }
  const claudeFiles: string[] = []
  // The home folder or the disk root as a root would walk everything: read only their own CLAUDE.md files.
  for (const r of cfg.roots) {
    if (normPath(r) === normPath(cfg.home) || /^([a-z]:)?\/?$/i.test(normPath(r))) claudeFiles.push(...[join(r, 'CLAUDE.md'), join(r, '.claude', 'CLAUDE.md')].filter((f) => existsSync(f)))
    // A clone below a root has its own rules for its own project: not global ones, unless it is a configured repo.
    else walk(r, (n) => n === 'CLAUDE.md', claudeFiles, 0, (d) => existsSync(join(d, '.git')) && ![...cfg.repos, ...cfg.roots].some((x) => normPath(x) === normPath(d)))
  }
  if (existsSync(join(cfg.claudeDir, 'CLAUDE.md'))) claudeFiles.push(join(cfg.claudeDir, 'CLAUDE.md'))
  const seenDocs = new Set<string>()
  for (const f of [...new Set(claudeFiles)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    const content = readFileSync(f, 'utf8')
    if (seenDocs.has(content)) continue
    seenDocs.add(content)
    const lines = content.split('\n')
    const at = iso(statSync(f).mtimeMs)
    out.nodes.push(fullNode({ id: `doc:${f}`, kind: 'doc', title: f, at, source: f }))
    let fence = false
    let fm = lines[0] === '---'
    lines.forEach((raw, i) => {
      const l = raw.trim()
      if (fm) {
        if (i > 0 && l === '---') fm = false
        return
      }
      if (l.startsWith('```')) fence = !fence
      if (fence || l.startsWith('```') || !l || /^(#|\||---|<!--)/.test(l)) return
      const text = l.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      if (text.length < 8) return
      out.nodes.push(fullNode({ id: `rule:${f}:${i + 1}`, kind: 'rule', title: text.slice(0, 100), text, at, source: f }))
      out.edges.push({ src: `rule:${f}:${i + 1}`, dst: `doc:${f}`, kind: 'part_of', at, extra: {} })
    })
  }

  return out
}

/** Claude Code's auto-memory files of the projects that have sessions in the memory. */
export function memoryPart(cfg: Config, keys: string[], memoryFrom?: string): Part {
  const out: Part = { nodes: [], edges: [] }
  const base = memoryFrom ?? join(cfg.claudeDir, 'projects')
  // Projects with no chat in the memory still have auto-memory; only excluded projects stay out.
  const all = existsSync(base) ? readdirSync(base).filter((k) => !cfg.excludeProjects.concat(cfg.ingestExcludeProjects).some((g) => globMatch(g, k))) : []
  for (const key of [...new Set([...keys, ...all])].sort()) {
    const dir = join(base, key, 'memory')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const raw = readFileSync(join(dir, f), 'utf8')
      const fm = parseFrontMatter(raw)
      out.nodes.push(fullNode({ id: `mem:${key}/${f}`, kind: 'memory', title: String(fm.data.name ?? basename(f, '.md')), text: fm.body.trim(), at: iso(statSync(join(dir, f)).mtimeMs), project: key, source: join(dir, f) }))
    }
  }

  return out
}

// 5. Files and derived links ---------------------------------------------------------------------------------------

/** A file node exists while an edge points at it. Its source is the first layer that named it: git, then chats. */
export function fileNode(id: string, kinds: Set<string>, aliasRoots: string[]): GNode {
  const abs = id.slice(5)
  const aliases = aliasRoots.filter((r) => under(abs, r) && abs !== r).map((r) => abs.slice(r.length + 1)).sort()

  return fullNode({ id, kind: 'file', title: basename(abs), source: kinds.has('changed') || !['read', 'edited', 'ran_in'].some((k) => kinds.has(k)) ? 'git' : 'transcript', extra: aliases.length ? { aliases } : {} })
}
export const aliasesOf = (n: { extra: Record<string, unknown> }): string[] => (n.extra.aliases as string[] | undefined) ?? []

export interface Look {
  pr(n: number): string | undefined
  sha(prefix: string): string | undefined // commit node id of the one commit that starts with it
  file(id: string): boolean
  alias(a: string): string[]
  edge(src: string, dst: string, kind: string): boolean
  bySubject(subject: string): { id: string; ms: number }[]
  prUrl(url: string): string | undefined
}

/** Commit and PR links the chats state: a matching subject within 15 minutes, a printed short sha, a printed PR url. */
export function resolveClaims(claims: Claim[], look: Look): GEdge[] {
  const out = new Map<string, GEdge>()
  const add = (e: GEdge) => out.has(edgeKey(e)) || out.set(edgeKey(e), e)
  for (const c of claims.filter((x) => x.kind !== 'url')) {
    if (c.kind === 'sub') {
      const ms = Date.parse(c.at)
      for (const m of look.bySubject(c.val)) if (m.ms >= ms && m.ms - ms <= 15 * 60000) add({ src: c.node, dst: m.id, kind: 'made', at: c.turnAt, extra: { why: 'subject match' } })
    } else {
      const id = look.sha(c.val)
      if (id) add({ src: c.node, dst: id, kind: 'made', at: c.turnAt, extra: { sha: c.val } })
    }
  }
  for (const c of claims.filter((x) => x.kind === 'url')) {
    const id = look.prUrl(c.val)
    if (id) add({ src: c.node, dst: id, kind: 'opened', at: c.turnAt, extra: { url: c.val } })
  }

  return [...out.values()]
}

export interface Ref {
  type: 'pr' | 'sha' | 'abs' | 'rel'
  val: string
  match: string
}
export const MENTION_KINDS = new Set(['turn', 'summary', 'note', 'commit', 'pr'])

/** PR numbers, shas and file paths a text names, in the order they are tried. Whether they point at anything is decided later. */
export function extractRefs(kind: string, title: string, text: string, home: string): Ref[] {
  if (!MENTION_KINDS.has(kind)) return []
  const all = `${title}\n${text}`
  const out = new Map<string, Ref>()
  const add = (r: Ref) => out.has(`${r.type}\0${r.val}`) || out.set(`${r.type}\0${r.val}`, r)
  const prRe = kind === 'commit' || kind === 'pr' ? /(?<![\w/&])(?:(?:PR|pull request|pull)s?\s*)?#(\d{1,5})\b/gi : /\b(?:PR|pull request|pull)s?\s*#(\d{1,5})\b/gi
  for (const m of all.matchAll(prRe)) add({ type: 'pr', val: m[1]!, match: m[0] })
  for (const m of all.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) add({ type: 'sha', val: m[0], match: m[0] })
  for (const m of all.matchAll(/(?<![\w./~-])((?:~|\/Users)\/[^\s"'`),;:<>]+|(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6})(?![\w/])/g)) {
    const raw = m[1]!.replace(/[.,]+$/, '')
    add(/^(~|\/)/.test(raw) ? { type: 'abs', val: normalizePath(raw, home), match: raw } : { type: 'rel', val: raw, match: raw })
  }

  return [...out.values()]
}

/** The mention edges of one node: each ref that points at exactly one thing, first reference wins per target. */
export function resolveRefs(id: string, at: string, refs: Ref[], look: Look): GEdge[] {
  const out = new Map<string, GEdge>()
  for (const r of refs) {
    const dst = r.type === 'pr' ? look.pr(Number(r.val)) : r.type === 'sha' ? look.sha(r.val) : r.type === 'abs' ? (look.file(`file:${r.val}`) ? `file:${r.val}` : undefined) : look.alias(r.val).length === 1 ? look.alias(r.val)[0] : undefined
    if (dst && dst !== id && !look.edge(id, dst, 'changed') && !out.has(dst)) out.set(dst, { src: id, dst, kind: 'mentions', at, extra: { why: r.type === 'pr' ? 'pr-ref' : r.type === 'sha' ? 'sha' : 'path', match: r.match } })
  }

  return [...out.values()]
}
