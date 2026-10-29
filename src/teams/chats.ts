// Shared project chats, the sending side. Only passages of the chats of projects the member named leave the machine:
// the prompt and reply text of each turn (cut by the same `splitPassages` as the ingest), repo-relative paths, short shas
// and PR urls. Never a transcript, a tool result, thinking, a file content, an absolute path or a working folder.
// The unit is read from the masked archive, masked again, and cleaned of the member's redact list.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { MASK_VERSION, maskSecrets } from '../core/secrets.ts'
import { editDirs, isMarked, workDirs, sessionPart, under } from '../ingest/parts.ts'
import type { SessionPart } from '../ingest/parts.ts'
import { isOff } from '../ingest/config.ts'
import type { Config } from '../ingest/config.ts'
import { githubSlug, real, repoRoot, sessionRepo } from '../ingest/repos.ts'
import { parseSession } from '../ingest/transcript.ts'
import { isForgotten, loadTombs } from '../privacy/tombstones.ts'
import { splitPassages } from '../query/passages.ts'
import { call, errText, load, locked, save } from './client.ts'
import type { WireChat, WireTurn } from './chatcache.ts'

// Under the server's 60 writes a minute with the notes flush, queued deletes, the status call and a stale retry or two.
export const PUSH_PER_SYNC = 40
const MAX_PASSAGE = 1200
const MAX_PASSAGES = 2000
const MAX_BYTES = 2 * 1024 * 1024
const LABEL = 'teams preview'

export type Unit = Omit<WireChat, 'owner' | 'session' | 'rev' | 'bytes'>
export const sharesFile = (dir: string) => join(dir, 'team-shares.json')

/** The name a project has on the server: its GitHub slug, else the repo folder's name. */
const keys = new Map<string, string>()
/** The project's name: its GitHub slug, else the folder name. Read once per repo, so no git runs per chat. */
export const projectKey = (repo: string) => keys.get(repo) ?? (keys.set(repo, githubSlug(repo) ?? basename(repo)), keys.get(repo)!)
/** Whether a chat's repo is the shared project or another checkout or worktree of it (same key, not same path). */
const sameProject = (found: string | undefined, repo: string) => !!found && projectKey(found) === projectKey(repo)

export interface SharedProject {
  repo: string
  /** `paused` keeps what is on the server and sends nothing new; `removed` is an unshare (a config entry stays off until shared again). */
  status: 'active' | 'paused' | 'removed'
  /** Only chats that began on or after this ISO date. */
  since?: string
  lastPush?: number
  /** Set by a deliberate share: the next pushes carry `reshare` so they undo a server-side unshare. */
  reshare?: boolean
}
export interface SharedChat {
  project: string
  /** The archive entry, mask version and redact list this was built from: unchanged means nothing to rebuild. */
  src: string
  /** The unit as sent: unchanged means nothing to send. */
  sha: string
  rev: number
  bytes: number
  passages: number
  at: number
  /** The status the server refused this unit with (kept so it is not sent again until it changes). */
  refused?: number
}
export interface Shares {
  projects: Record<string, SharedProject>
  chats: Record<string, SharedChat>
  /** Sessions the member unshared by hand, with their project: never sent again unless the project is shared anew. */
  removed: Record<string, string>
  /** The part of `removed` that the server unshared (admin, Hub, retention): shown by `team shares`. */
  serverGone?: Record<string, string>
  /** The last revision of the own-tombs feed that was read. */
  tombsSince?: number
  /** Deletes the server has not confirmed yet. */
  deletes: { kind: 'chat' | 'project'; id: string; rev?: number; seq: number }[]
}
export function loadShares(dir: string): Shares {
  try {
    return { projects: {}, chats: {}, removed: {}, deletes: [], ...JSON.parse(readFileSync(sharesFile(dir), 'utf8')) }
  } catch {
    return { projects: {}, chats: {}, removed: {}, deletes: [] }
  }
}
export function saveShares(dir: string, s: Shares) {
  const tmp = `${sharesFile(dir)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, sharesFile(dir))
}
export const updateShares = (dir: string, fn: (s: Shares) => void) =>
  locked(dir, () => {
    const s = loadShares(dir)
    fn(s)
    saveShares(dir, s)
  })

// Building one unit ------------------------------------------------------------------------------------------------

/** The member's redact list: words and phrases replaced by `[redacted]`, matched without regard to case. */
export function scrubber(words: string[]): { scrub: (t: string) => string; hits: Map<string, number> } {
  const hits = new Map<string, number>()
  // Longest first, so "acme.internal" is removed whole before "acme" can cut into it.
  const res = [...words].filter(Boolean).sort((a, b) => b.length - a.length).map((w) => [w, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')] as const)

  return {
    hits,
    scrub: (t) => {
      for (const [w, re] of res) t = t.replace(re, () => (hits.set(w, (hits.get(w) ?? 0) + 1), '[redacted]'))

      return t
    },
  }
}

export interface Candidate {
  rel: string
  session: string
  path: string
  cwd: string
  sha: string
  subagents: string[]
  /** When Claude Code last wrote the chat (ms), from the manifest. */
  at: number
}
/** The archived chats (main files, with their subagent files), from the manifest. */
export function archived(cfg: Config): Candidate[] {
  const base = join(cfg.memDir, 'archive')
  let manifest: Record<string, { cwd?: string; sha256?: string; mtimeMs?: number }> = {}
  try {
    manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'))
  } catch {
    return [] // nothing archived yet
  }
  const subs = new Map<string, string[]>()
  for (const rel of Object.keys(manifest).sort()) {
    const p = rel.split('/')
    if (p.length === 4 && p[2] === 'subagents' && existsSync(join(base, 'sessions', `${rel}.gz`))) subs.set(`${p[0]}/${p[1]}`, [...(subs.get(`${p[0]}/${p[1]}`) ?? []), rel])
  }
  const out: Candidate[] = []
  for (const [rel, e] of Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const p = rel.split('/')
    const path = join(base, 'sessions', `${rel}.gz`)
    if (p.length !== 2 || !existsSync(path)) continue
    const session = p[1]!.replace(/\.jsonl$/, '')
    const sub = subs.get(`${p[0]}/${session}`) ?? []
    out.push({ rel, session, path, cwd: e.cwd ?? '', sha: [e.sha256 ?? '', ...sub.map((r) => manifest[r]?.sha256 ?? '')].join('+'), subagents: sub, at: e.mtimeMs ?? 0 })
  }

  return out
}

const worktreeTop = (cwd: string): string | undefined => {
  for (let d = cwd; d && d !== '/'; d = resolve(d, '..')) if (existsSync(join(d, '.git'))) return d

  return undefined
}

export type Skip = 'no-memory' | 'paused' | 'forgotten' | 'entry' | 'empty' | 'other' | 'since'
export interface Built {
  session: string
  unit: Unit
  sha: string
  bytes: number
  passages: number
  /** Subagent files left out of this chat. */
  subagentFiles: number
  cut: boolean
  /** Turns left out because the chat is over the limits (the oldest ones). */
  dropped: number
}

/** A folder path followed by a separator (captured) or by the end of the path token, so a sibling like `proj-other` is left alone. */
const atBoundary = (dir: string) => new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:([/\\\\])|(?![\\w-])(?!\\.\\w))`, 'g')

/** What one archived chat gives as a unit, or why it stays home. `repo` is the shared project's checkout. */
export function buildChat(cfg: Config, repo: string, c: Candidate, scrub: (t: string) => string, opts: { since?: string; tombs?: ReturnType<typeof loadTombs> } = {}): Built | { skip: Skip } {
  const read = (path: string, sub = false) => {
    const s = parseSession(gunzipSync(readFileSync(path)).toString('utf8'), c.session, cfg.home, '', sub)
    for (const t of s.turns) t.reply = t.reply.filter((r) => !t.agentReports.includes(r)) // tool output never travels

    return s
  }
  const s = read(c.path)
  if (!s.start || !s.turns.length) return { skip: 'empty' }
  if (isForgotten(opts.tombs ?? loadTombs(cfg.memDir), c.rel, s.cwd)) return { skip: 'forgotten' }
  if (isMarked(cfg.ingestExcludeMarkers, s.turns.map((t) => t.prompt))) return { skip: 'no-memory' }
  if (isOff(cfg, s.cwd)) return { skip: 'paused' }
  if (!cfg.includeEntrypoints.includes(s.entrypoint)) return { skip: 'entry' }
  const wd = workDirs(cfg, editDirs(s))
  if (!sameProject(sessionRepo(s.cwd, wd), repo)) return { skip: 'other' }
  if (opts.since && Date.parse(s.start) < Date.parse(opts.since)) return { skip: 'since' }

  const parts: SessionPart[] = [sessionPart(s, 'x')]
  if (cfg.shareSubagents) for (const rel of c.subagents) parts.push(sessionPart(read(join(cfg.memDir, 'archive', 'sessions', `${rel}.gz`), true), 'x'))
  const tops = [s.cwd, ...wd].map(worktreeTop).filter((t) => !t || sameProject(t, repo))
  const roots = [...new Set([repo, real(repo), ...tops, ...tops.map((t) => t && real(t))].filter((r): r is string => !!r))]
  const alias = (abs: string) => {
    const root = roots.find((r) => under(abs, r) && abs !== r)

    return root ? abs.slice(root.length + 1) : undefined
  }
  const paths = new Map<string, Set<string>>()
  const shas = new Map<string, Set<string>>()
  const prs = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, v: string | undefined) => v && m.set(k, (m.get(k) ?? new Set()).add(v))
  for (const p of parts) {
    for (const e of p.edges) if (['read', 'edited', 'ran_in'].includes(e.kind) && e.dst.startsWith('file:')) add(paths, e.src, alias(e.dst.slice(5)))
    for (const cl of p.claims) add(cl.kind === 'sha' ? shas : prs, cl.node, cl.kind === 'sha' ? cl.val.toLowerCase() : cl.val)
  }
  // Prose names files too: a shared root becomes repo-relative and the home folder becomes ~ (longest first).
  const prose = (t: string) => {
    for (const r of [...roots].sort((a, b) => b.length - a.length)) t = t.replace(atBoundary(r), (_, sep) => (sep ? '' : '.'))
    for (const h of [...new Set([cfg.home, real(cfg.home)])].sort((a, b) => b.length - a.length)) t = t.replace(atBoundary(h), (_, sep) => `~${sep ?? ''}`)

    return t
  }
  const clean = (t: string) => scrub(prose(maskSecrets(t).text))
  const nodes = parts.flatMap((p) => p.nodes).filter((n) => n.kind === 'turn' || n.kind === 'summary').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
  const turns: WireTurn[] = []
  let count = 0
  let bytes = 0
  let cut = false
  const seen = new Set<string>()
  let dropped = 0
  for (const n of nodes.reverse()) { // newest first: a long chat keeps its end, where the outcome is
    const id = n.id.replace(/^(turn|sum):/, '')
    if (seen.has(id)) continue
    seen.add(id)
    const passages = splitPassages(n.text).map((p) => clean(p).slice(0, MAX_PASSAGE)).filter((p) => p.trim())
    const size = passages.reduce((a, p) => a + Buffer.byteLength(p), 0)
    if (!passages.length || id.length > 120) continue
    if (count + passages.length > MAX_PASSAGES || bytes + size > MAX_BYTES) {
      cut = true
      dropped = nodes.length - nodes.indexOf(n)
      break
    }
    count += passages.length
    bytes += size
    turns.unshift({
      id,
      at: Date.parse(n.at) || 0,
      line: clean(n.title).slice(0, 300),
      kind: n.kind === 'summary' ? 'summary' : 'turn',
      passages,
      paths: [...(paths.get(n.id) ?? [])].sort().slice(0, 200).map((p) => scrub(p)).filter((p) => p.length <= 500),
      shas: [...(shas.get(n.id) ?? [])].filter((x) => /^[0-9a-f]{4,40}$/.test(x)).sort().slice(0, 20),
      prs: [...(prs.get(n.id) ?? [])].filter((x) => x.length <= 300).sort().slice(0, 20),
      dead_end: !!n.extra.deadEnd,
      dead_kind: n.extra.deadEnd ? String(n.extra.deadEndKind ?? 'phrase') : '',
      dead_text: n.extra.deadEnd ? scrub(maskSecrets(String(n.extra.deadEnd)).text).slice(0, 160) : '',
    })
  }
  if (!turns.length) return { skip: 'empty' }
  const unit: Unit = { project: projectKey(repo), head: clean(s.turns[0]!.prompt.split('\n')[0]!).slice(0, 200), started_at: Date.parse(s.start) || 0, ended_at: Date.parse(s.end) || 0, mask: MASK_VERSION, turns }

  return { session: c.session, unit, sha: createHash('sha256').update(JSON.stringify(unit)).digest('hex'), bytes, passages: count, subagentFiles: cfg.shareSubagents ? 0 : c.subagents.length, cut, dropped }
}

// The preview ------------------------------------------------------------------------------------------------------

export interface Preview {
  project: string
  repo: string
  chats: number
  passages: number
  bytes: number
  oldest: string
  newest: string
  samples: string[]
  /** Chats left out, by reason. */
  left: Partial<Record<Skip, number>>
  subagentFiles: number
  redacted: Record<string, number>
  truncated: number
  /** Oldest turns left home in cut chats. */
  droppedTurns: number
}

/** What sharing a project would send. `pick` chooses which of n passages are shown (random by default; a test passes its own). */
export function previewShare(cfg: Config, repoPath: string, opts: { since?: string; pick?: (n: number) => number } = {}): Preview {
  const root = repoRoot(resolve(repoPath))
  if (!root) throw new Error(`${repoPath} is not inside a git repository`)
  const repo = real(root)
  const sc = scrubber(cfg.redact)
  const tombs = loadTombs(cfg.memDir)
  const pv: Preview = { project: projectKey(repo), repo, chats: 0, passages: 0, bytes: 0, oldest: '', newest: '', samples: [], left: {}, subagentFiles: 0, redacted: {}, truncated: 0, droppedTurns: 0 }
  const all: string[] = []
  const inRepo = new Map<string, string | undefined>()
  for (const c of archived(cfg)) {
    if (c.cwd && !inRepo.has(c.cwd)) inRepo.set(c.cwd, sessionRepo(c.cwd))
    if (c.cwd && inRepo.get(c.cwd) !== undefined && !sameProject(inRepo.get(c.cwd), repo)) continue // a quick no: its folder is another repo
    const b = buildChat(cfg, repo, c, sc.scrub, { ...(opts.since ? { since: opts.since } : {}), tombs })
    if ('skip' in b) {
      if (b.skip !== 'other' && b.skip !== 'empty') pv.left[b.skip] = (pv.left[b.skip] ?? 0) + 1
      continue
    }
    pv.chats++
    pv.passages += b.passages
    pv.bytes += b.bytes
    pv.subagentFiles += b.subagentFiles
    if (b.cut) (pv.truncated++, (pv.droppedTurns += b.dropped))
    const from = new Date(b.unit.started_at).toISOString().slice(0, 10)
    const to = new Date(b.unit.ended_at).toISOString().slice(0, 10)
    if (!pv.oldest || from < pv.oldest) pv.oldest = from
    if (to > pv.newest) pv.newest = to
    for (const t of b.unit.turns) all.push(...t.passages)
  }
  const pick = opts.pick ?? ((n: number) => Math.floor(Math.random() * n))
  for (let i = 0; i < 3 && all.length; i++) pv.samples.push(all.splice(pick(all.length), 1)[0]!)
  pv.redacted = Object.fromEntries(sc.hits)

  return pv
}

const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)
export function formatPreview(p: Preview, redactList: string[]): string {
  const left = Object.entries(p.left).map(([k, n]) => `${n} ${k === 'no-memory' ? '[no-memory]' : k === 'paused' ? 'of a paused project' : k}`)
  const out = [
    `${LABEL}: this sends the prompts and replies of your chats in ${p.project} to the team server`,
    `  chats: ${p.chats}, passages: ${p.passages}, size: ${kb(p.bytes)}, from ${p.oldest || '-'} to ${p.newest || '-'}`,
    '  to send fewer, add --since <date>',
    `  never sent: transcripts, tool output, thinking, file contents, absolute paths, subagent turns${p.subagentFiles ? ` (${p.subagentFiles} subagent files stay home)` : ''}`,
    `  left out: ${left.length ? left.join(', ') : 'nothing else found'}`,
    `  redact list (${redactList.length}): ${redactList.length ? redactList.map((w) => `${w} (${p.redacted[w] ?? 0} removed)`).join(', ') : 'empty; add words under "team" > "redact" in config.json'}`,
  ]
  if (p.truncated) out.push(`  ${p.truncated} very long chat${p.truncated === 1 ? '' : 's'} are over 2,000 passages or 2 MB: the newest turns are sent and the oldest ${p.droppedTurns} stay home`)
  p.samples.forEach((s, i) => out.push(`  sample ${i + 1}:\n${s.slice(0, 600).split('\n').map((l) => `    | ${l}`).join('\n')}`))

  return out.join('\n')
}

// Which projects are shared -----------------------------------------------------------------------------------------

export interface Active {
  name: string
  repo: string
  since?: string
}
/** The projects to send: those named in config.json and those shared from the command line, minus paused and removed ones. */
export function activeProjects(cfg: Config, sh: Shares): Active[] {
  const out = new Map<string, Active>()
  const stop = new Set(Object.values(sh.projects).filter((p) => p.status !== 'active').map((p) => real(p.repo)))
  for (const r of cfg.shareChats) {
    const root = repoRoot(r)
    if (root && !stop.has(real(root))) out.set(real(root), { name: projectKey(root), repo: real(root) })
  }
  for (const p of Object.values(sh.projects)) if (p.status === 'active' && existsSync(p.repo)) out.set(real(p.repo), { name: projectKey(p.repo), repo: real(p.repo), ...(p.since ? { since: p.since } : {}) })

  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

// Sending ----------------------------------------------------------------------------------------------------------

const srcOf = (cfg: Config, c: Candidate) => createHash('sha256').update(`${c.sha}|${MASK_VERSION}|${JSON.stringify(cfg.redact)}|${cfg.shareSubagents}`).digest('hex')
const tag = (m: string) => `${m} (${LABEL})`

/** Sends new and changed chats of the shared projects: at most `limit` per run, each with the revision it was made on
 * (If-Match), newest chats first. Resumable: what was sent is recorded after each chat. '' when not on a team or nothing is shared. */
export async function pushShared(cfg: Config, opts: { limit?: number } = {}): Promise<string> {
  const dir = cfg.memDir
  if (!existsSync(join(dir, 'team.json'))) return ''
  const projects = activeProjects(cfg, loadShares(dir))
  if (!projects.length && !loadShares(dir).deletes.length) return ''
  if (load(dir).refused) return tag('the server refused your token; ask for a new invite')
  const limit = opts.limit ?? PUSH_PER_SYNC
  const out: string[] = []
  const reached = await sendDeletes(dir)
  if (reached) out.push(reached)
  const lost = await readOwnTombs(dir, projects)
  if (lost) out.push(lost)
  // A shared chat the archive no longer keeps (a [no-memory] marker added later drops it) leaves the team too.
  const kept = new Set(archived(cfg).map((c) => c.session))
  const dropped = await unshareForgotten(cfg, Object.keys(loadShares(dir).chats).filter((s) => !kept.has(s)))
  if (dropped) out.push(`${dropped} chat${dropped === 1 ? '' : 's'} no longer kept, unshared`)
  const tombs = loadTombs(dir)
  const sc = scrubber(cfg.redact)
  const quick = new Map<string, string | undefined>()
  let sent = 0
  let waiting = 0
  let fail = ''
  for (const p of projects) {
    const sh = loadShares(dir)
    const todo: Candidate[] = []
    for (const c of archived(cfg)) {
      if (c.session in sh.removed) continue
      if (c.cwd && !quick.has(c.cwd)) quick.set(c.cwd, sessionRepo(c.cwd))
      if (c.cwd && quick.get(c.cwd) !== undefined && !sameProject(quick.get(c.cwd), p.repo)) continue
      const have = sh.chats[c.session]
      if (have && have.src === srcOf(cfg, c) && have.project === p.name) continue
      todo.push(c)
    }
    todo.sort((a, b) => b.at - a.at || (a.rel < b.rel ? 1 : -1))
    for (const c of todo) {
      if (fail) break
      const b = buildChat(cfg, p.repo, c, sc.scrub, { ...(p.since ? { since: p.since } : {}), tombs })
      if ('skip' in b) {
        if (b.skip === 'no-memory' && loadShares(dir).chats[c.session]) await unshareChats(cfg, c.session) // marked after it was shared
        continue
      }
      const have = loadShares(dir).chats[c.session]
      if (have && have.sha === b.sha && have.project === p.name) {
        updateShares(dir, (s) => void (s.chats[c.session] = { ...have, src: srcOf(cfg, c) }))
        continue
      }
      if (have?.refused && have.sha === b.sha) continue
      if (sent >= limit) {
        waiting++
        continue
      }
      const r = await put(dir, c.session, b, have, !!loadShares(dir).projects[p.name]?.reshare)
      if (r.status === 'sent') {
        sent++
        updateShares(dir, (s) => {
          s.chats[c.session] = { project: p.name, src: srcOf(cfg, c), sha: b.sha, rev: r.rev, bytes: b.bytes, passages: b.passages, at: Date.now() }
          if (s.projects[p.name]) s.projects[p.name]!.lastPush = Date.now()
        })
      } else if (r.status === 'refused') {
        out.push(`${c.session} refused (${r.code}${r.text ? ` ${r.text}` : ''})`)
        updateShares(dir, (s) => void (s.chats[c.session] = { project: p.name, src: srcOf(cfg, c), sha: b.sha, rev: have?.rev ?? 0, bytes: b.bytes, passages: b.passages, at: Date.now(), refused: r.code }))
      } else if (r.status === 'gone') {
        updateShares(dir, (s) => void ((s.removed[c.session] = p.name), delete s.chats[c.session]))
      } else fail = r.text
    }
  }
  if (!waiting && !fail) updateShares(dir, (s) => void projects.forEach((p) => s.projects[p.name]?.reshare && delete s.projects[p.name]!.reshare))
  out.unshift(`${sent} chat${sent === 1 ? '' : 's'} pushed${waiting ? `, ${waiting} more at the next sync` : ''}${fail ? `; stopped: ${fail}` : ''}`)

  return tag(out.join('; '))
}

/** Chats the server unshared behind the owner's back (admin, Hub, retention, a removed member) are marked removed here, so
 * they are not pushed again and `team shares` tells the truth. A project the server no longer lists is marked removed too. */
async function readOwnTombs(dir: string, projects: Active[]): Promise<string> {
  let n = 0
  const hit = new Set<string>()
  try {
    for (;;) {
      const r = await call(load(dir), 'GET', `/chat-tombs?mine=only&limit=500&since=${loadShares(dir).tombsSince ?? 0}`)
      if (r.status !== 200) break
      const rows = r.json.tombs as { session: string; rev: number }[]
      if (!rows.length) break
      updateShares(dir, (s) => {
        for (const t of rows) {
          const c = s.chats[t.session]
          if (!c || c.rev >= t.rev || s.projects[c.project]?.reshare) continue
          s.removed[t.session] = c.project
          s.serverGone = { ...s.serverGone, [t.session]: c.project }
          delete s.chats[t.session]
          hit.add(c.project)
          n++
        }
        s.tombsSince = rows.at(-1)!.rev
      })
      if (rows.length < 500) break
    }
    if (hit.size) {
      const list = ((await call(load(dir), 'GET', '/shared-projects')).json?.projects ?? []) as { owner: string; project: string }[]
      const mine = await me(dir)
      updateShares(dir, (s) => {
        for (const name of hit) {
          const repo = s.projects[name]?.repo ?? projects.find((a) => a.name === name)?.repo
          if (repo && !list.some((x) => x.owner === mine && x.project === name)) s.projects[name] = { ...s.projects[name], repo, status: 'removed' }
        }
      })
    }
  } catch {
    // the server is not reachable: the next sync reads them
  }

  return n ? `${n} chat${n === 1 ? ' was' : 's were'} unshared on the server` : ''
}

/** Tells the server a project is paused or active again (the Hub shows it). A server that cannot be reached keeps its old value. */
export async function setServerStatus(dir: string, project: string, status: 'active' | 'paused'): Promise<void> {
  try {
    await call(load(dir), 'PATCH', `/shared-projects/${encodeURIComponent(await me(dir))}/${encodeURIComponent(project)}`, { status })
  } catch {
    // best effort
  }
}

type Put = { status: 'sent'; rev: number } | { status: 'refused'; code: number; text: string } | { status: 'gone' } | { status: 'stop'; text: string }
async function put(dir: string, session: string, b: Built, have: SharedChat | undefined, reshare = false): Promise<Put> {
  let rev = have?.rev ?? 0
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: { status: number; json: any }
    try {
      r = await call(load(dir), 'PUT', `/chats/${encodeURIComponent(session)}`, { ...b.unit, seq: Date.now(), ...(reshare ? { reshare: true } : {}) }, { 'if-match': rev > 0 ? String(rev) : '*' }, 60000)
    } catch {
      return { status: 'stop', text: 'server not reachable, the rest waits' }
    }
    if (r.status === 200) return { status: 'sent', rev: r.json.rev }
    if (r.status === 409 && r.json?.error?.code === 'unshared') return { status: 'gone' }
    // The team holds another revision of this chat (a push whose answer was lost, or another machine): replace it.
    if (r.status === 409 && r.json?.error?.code === 'stale' && attempt === 0) {
      rev = Number(r.json.rev ?? 0)
      continue
    }
    if (r.status === 401) {
      locked(dir, () => save(dir, { ...load(dir), refused: new Date().toISOString() }))

      return { status: 'stop', text: 'the server refused your token' }
    }
    if (r.status >= 500 || r.status === 429) return { status: 'stop', text: `the server answered ${r.status}` }

    return { status: 'refused', code: r.status, text: errText(r.json) }
  }

  return { status: 'stop', text: 'the team copy keeps changing' }
}

/** Deletes the server has not confirmed yet (a server that was down at the time). */
async function sendDeletes(dir: string): Promise<string> {
  let done = 0
  for (const d of loadShares(dir).deletes) {
    const ok = d.kind === 'project' ? await delProject(dir, d.id) : await delChat(dir, d.id, d.rev ?? 0, d.seq)
    if (!ok) break
    done++
    updateShares(dir, (s) => void (s.deletes = s.deletes.filter((x) => !(x.kind === d.kind && x.id === d.id))))
  }

  return done ? `${done} unshare${done === 1 ? '' : 's'} reached the server` : ''
}
async function me(dir: string): Promise<string> {
  const s = load(dir)

  return s.me ?? (await call(s, 'GET', '/me')).json?.name
}
/** True when the server no longer holds it (deleted now, or never there); false when it could not be reached. */
async function delProject(dir: string, project: string): Promise<boolean> {
  try {
    const r = await call(load(dir), 'DELETE', `/shared-projects/${encodeURIComponent(await me(dir))}/${encodeURIComponent(project)}`)

    return !(r.status >= 500 || r.status === 429 || r.status === 401)
  } catch {
    return false
  }
}
async function delChat(dir: string, session: string, rev: number, seq: number): Promise<boolean> {
  try {
    let match = rev
    for (let i = 0; i < 2; i++) {
      const res = await call(load(dir), 'DELETE', `/chats/${encodeURIComponent(session)}?seq=${seq}`, undefined, { 'if-match': match > 0 ? String(match) : '*' })
      if (res.status === 409 && res.json?.error?.code === 'stale') {
        match = Number(res.json.rev ?? 0)
        continue
      }

      return !(res.status >= 500 || res.status === 429 || res.status === 401)
    }
  } catch {
    return false
  }

  return false
}

/** Takes chats back from the team. A session id removes one chat; a project (its name, repo path or folder name)
 * removes all its chats and stops sending, or with `pause` only stops sending. A server that cannot be reached is
 * asked again at the next sync. */
export async function unshareChats(cfg: Config, target: string, opts: { pause?: boolean } = {}): Promise<string> {
  const dir = cfg.memDir
  const sh = loadShares(dir)
  const session = Object.keys(sh.chats).find((s) => s === target || (target.length >= 8 && s.startsWith(target)))
  if (session) {
    const have = sh.chats[session]!
    updateShares(dir, (s) => {
      delete s.chats[session]
      s.removed[session] = have.project
      s.deletes.push({ kind: 'chat', id: session, rev: have.rev, seq: Date.now() })
    })

    return tag((await sendDeletes(dir)) ? `chat ${session} unshared` : `chat ${session} unshare queued, the server could not be reached`)
  }
  const repos = new Map<string, string>() // project name -> repo
  for (const [k, p] of Object.entries(sh.projects)) repos.set(k, p.repo)
  for (const r of cfg.shareChats) if (repoRoot(r)) repos.set(projectKey(repoRoot(r)!), real(repoRoot(r)!))
  const asPath = repoRoot(resolve(target))
  const name = [...repos.keys()].find((k) => k === target || basename(k) === target || (!!asPath && real(asPath) === real(repos.get(k)!))) ?? (asPath ? projectKey(asPath) : undefined)
  if (!name || (!repos.has(name) && !Object.values(sh.chats).some((c) => c.project === name))) throw new Error(`${target}: not a shared project or a shared chat. \`thenwise team shares\` lists them.`)
  const repo = repos.get(name) ?? (asPath ? real(asPath) : '')
  const n = Object.values(sh.chats).filter((c) => c.project === name).length
  if (opts.pause) {
    updateShares(dir, (s) => void (s.projects[name] = { ...(s.projects[name] ?? {}), repo, status: 'paused' }))

    await setServerStatus(dir, name, 'paused')

    return tag(`${name} paused: its ${n} chat${n === 1 ? '' : 's'} stay on the team server, nothing new is sent`)
  }
  updateShares(dir, (s) => {
    s.projects[name] = { ...(s.projects[name] ?? {}), repo, status: 'removed' }
    for (const [id, c] of Object.entries(s.chats)) if (c.project === name) (delete s.chats[id], (s.removed[id] = name))
    s.deletes.push({ kind: 'project', id: name, seq: Date.now() })
  })

  return tag((await sendDeletes(dir)) ? `${name} unshared: ${n} chat${n === 1 ? '' : 's'} removed from the team server` : `${name} unshare queued, the server could not be reached; it is asked again at the next sync`)
}

/** Removes forgotten chats from the team: those of `ids` this machine shared. Returns how many. */
export async function unshareForgotten(cfg: Config, ids: string[]): Promise<number> {
  if (!existsSync(sharesFile(cfg.memDir)) || !existsSync(join(cfg.memDir, 'team.json'))) return 0
  const mine = ids.filter((i) => loadShares(cfg.memDir).chats[i])
  for (const id of mine) await unshareChats(cfg, id)

  return mine.length
}

/** For `thenwise team shares` and `thenwise status`: what is shared, how much, when last pushed, how many wait. */
export function sharesStatus(cfg: Config): { lines: string[]; summary: string } {
  const sh = loadShares(cfg.memDir)
  const active = activeProjects(cfg, sh)
  const lines: string[] = []
  const names = new Set<string>([...Object.keys(sh.projects), ...active.map((a) => a.name)])
  let chats = 0
  let bytes = 0
  let waiting = 0
  const mine = archived(cfg)
  const sc = scrubber(cfg.redact)
  const tombs = loadTombs(cfg.memDir)
  for (const k of [...names].sort()) {
    const own = Object.values(sh.chats).filter((c) => c.project === k)
    const p = sh.projects[k]
    const a = active.find((x) => x.name === k)
    const wait = a ? mine.filter((c) => {
      if (c.session in sh.removed || sh.chats[c.session]?.src === srcOf(cfg, c)) return false
      const q = c.cwd ? sessionRepo(c.cwd) : undefined

      return (q === undefined || sameProject(q, a.repo)) && !('skip' in buildChat(cfg, a.repo, c, sc.scrub, { ...(a.since ? { since: a.since } : {}), tombs }))
    }).length : 0
    const gone = Object.values(sh.serverGone ?? {}).filter((x) => x === k).length
    const size = own.reduce((x, c) => x + c.bytes, 0)
    chats += own.length
    bytes += size
    waiting += wait
    lines.push(`${k}  ${a ? 'sharing' : p?.status === 'paused' ? 'paused' : 'not shared'}  ${own.length} chats, ${kb(size)}${p?.lastPush ? `, last pushed ${new Date(p.lastPush).toISOString().slice(0, 16).replace('T', ' ')}` : ''}${wait ? `, ${wait} waiting to push` : ''}${gone ? `, ${gone} unshared on the server` : ''}`)
  }
  const n = active.length

  return { lines, summary: n || chats ? `team: sharing chats of ${n} project${n === 1 ? '' : 's'} (${chats} chats, ${kb(bytes)})${waiting ? `, ${waiting} waiting to push` : ''} (${LABEL})` : '' }
}
