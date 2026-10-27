// A throwaway home folder with git repos, a vault, Claude Code chats and the archive, for the ingest tests. Everything is synthetic.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { archive } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import type { Config } from '../src/ingest/config.ts'
import { dumpHash, ingest } from '../src/ingest/ingest.ts'
import type { IngestOptions } from '../src/ingest/ingest.ts'

export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export interface TurnSpec {
  uid?: string
  prompt: string
  reply?: string
  reads?: string[]
  edits?: string[]
  commit?: { subject: string; sha: string }
  prUrl?: string
  /** A subagent's result for this turn (an Agent tool call and its tool result). */
  agent?: string
  at?: string
}
export interface ChatSpec {
  turns: TurnSpec[]
  summary?: { text: string; from: string }
  cwd?: string
  entrypoint?: string
}

let clock = Date.parse('2026-10-01T09:00:00Z')
export const tick = (minutes = 1) => new Date((clock += minutes * 60000)).toISOString()

export function chatText(id: string, spec: ChatSpec, cwd: string): string {
  const out: object[] = []
  const base = { cwd: spec.cwd ?? cwd, sessionId: id, entrypoint: spec.entrypoint ?? 'cli' }
  if (spec.summary) out.push({ type: 'user', uuid: `${id}-sum`, timestamp: tick(), ...base, isCompactSummary: true, message: { role: 'user', content: `${spec.summary.text}\nIf you need specific details, read the full transcript at: /h/.claude/projects/-p/${spec.summary.from}.jsonl` } })
  spec.turns.forEach((t, i) => {
    const uid = t.uid ?? `${id}-${i}`
    const at = t.at ?? tick()
    out.push({ type: 'user', uuid: uid, timestamp: at, ...base, message: { role: 'user', content: t.prompt } })
    const blocks: object[] = []
    if (t.reply) blocks.push({ type: 'text', text: t.reply })
    for (const p of t.reads ?? []) blocks.push({ type: 'tool_use', id: `${uid}-r${p}`, name: 'Read', input: { file_path: p } })
    for (const p of t.edits ?? []) blocks.push({ type: 'tool_use', id: `${uid}-e${p}`, name: 'Edit', input: { file_path: p } })
    if (t.commit) blocks.push({ type: 'tool_use', id: `${uid}-c`, name: 'Bash', input: { command: `git commit -m "${t.commit.subject}"` } })
    if (t.agent) blocks.push({ type: 'tool_use', id: `${uid}-ag`, name: 'Agent', input: { prompt: 'look' } })
    if (t.prUrl) blocks.push({ type: 'tool_use', id: `${uid}-p`, name: 'Bash', input: { command: 'gh pr create --title x' } })
    if (blocks.length) out.push({ type: 'assistant', uuid: `${uid}-a`, timestamp: at, ...base, message: { role: 'assistant', content: blocks } })
    const results: object[] = []
    if (t.commit) results.push({ type: 'tool_result', tool_use_id: `${uid}-c`, content: `[main ${t.commit.sha.slice(0, 7)}] ${t.commit.subject}\n 1 file changed` })
    if (t.agent) results.push({ type: 'tool_result', tool_use_id: `${uid}-ag`, content: t.agent })
    if (t.prUrl) results.push({ type: 'tool_result', tool_use_id: `${uid}-p`, content: `${t.prUrl}\n` })
    if (results.length) out.push({ type: 'user', uuid: `${uid}-res`, timestamp: at, ...base, message: { role: 'user', content: results } })
  })
  return `${out.map((o) => JSON.stringify(o)).join('\n')}\n`
}

export class World {
  home = mkdtempSync(join(tmpdir(), 'thenwise-w-'))
  proj = join(this.home, 'proj')
  other = join(this.home, 'other')
  vault = join(this.home, 'vault')
  prs = join(this.home, 'prs.json')
  key = '-home-proj'
  cfg!: Config
  chats = new Map<string, { key: string; spec: ChatSpec }>()

  constructor(opts: { roots?: string[]; repos?: string[]; github?: string[] } = {}) {
    for (const r of [this.proj, this.other]) {
      mkdirSync(join(r, 'src'), { recursive: true })
      git(r, 'init', '-q', '-b', 'main')
      writeFileSync(join(r, 'src/a.ts'), 'a\n')
      git(r, 'add', '.')
      git(r, 'commit', '-q', '-m', 'Add a', '-m', 'Decision: keep a tiny\nWhy: fewer moving parts')
    }
    mkdirSync(this.vault, { recursive: true })
    writeFileSync(join(this.vault, 'Plan.md'), '---\ndate: 2026-10-01\n---\n# The plan\nSee [[Details]]. Mentions src/a.ts.\n')
    writeFileSync(join(this.vault, 'Details.md'), 'Details about the plan.\n')
    writeFileSync(this.prs, '[]')
    mkdirSync(join(this.home, '.thenwise'), { recursive: true })
    writeFileSync(join(this.home, '.thenwise/config.json'), JSON.stringify({ ingest: { roots: opts.roots ?? [this.proj, this.other, this.vault], repos: opts.repos ?? [this.proj], github_repos: opts.github ?? ['me/proj'], vaults: [this.vault], exclude_projects: ['*-eval-ws*'] } }))
    this.cfg = loadConfig(this.home)
    this.cfg.prs = true
  }
  destroy() {
    rmSync(this.home, { recursive: true, force: true })
  }
  get memDir() {
    return this.cfg.memDir
  }
  chatPath(id: string, key = this.key) {
    return join(this.home, '.claude/projects', key, `${id}.jsonl`)
  }
  /** Writes (or rewrites) a chat file in Claude Code's folder. */
  chat(id: string, spec: ChatSpec, key = this.key) {
    this.chats.set(id, { key, spec })
    mkdirSync(dirname(this.chatPath(id, key)), { recursive: true })
    writeFileSync(this.chatPath(id, key), chatText(id, spec, key === this.key ? this.proj : this.other))
  }
  grow(id: string, turns: TurnSpec[]) {
    const c = this.chats.get(id)!
    const text = chatText(id, { turns: turns.map((t, i) => ({ ...t, uid: t.uid ?? `${id}-g${c.spec.turns.length + i}` })) }, c.key === this.key ? this.proj : this.other)
    c.spec = { ...c.spec, turns: [...c.spec.turns, ...turns] }
    appendFileSync(this.chatPath(id, c.key), text)
  }
  commit(repo: string, file: string, message: string, body = '', date?: string): string {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), `${message}\n${Math.random()}\n`)
    git(repo, 'add', '.')
    if (date) {
      process.env.GIT_AUTHOR_DATE = date
      process.env.GIT_COMMITTER_DATE = date
    }
    try {
      git(repo, 'commit', '-q', '-m', message, ...(body ? ['-m', body] : []))
    } finally {
      delete process.env.GIT_AUTHOR_DATE
      delete process.env.GIT_COMMITTER_DATE
    }
    return git(repo, 'rev-parse', 'HEAD')
  }
  note(name: string, text: string) {
    writeFileSync(join(this.vault, name), text)
  }
  archive() {
    return archive(this.cfg)
  }
  ingest(db: string, opts: IngestOptions = {}) {
    return ingest(this.cfg, { prs: this.prs, db: join(this.home, db), ...opts })
  }
  full(db: string, opts: IngestOptions = {}) {
    return this.ingest(db, { ...opts, full: true })
  }
  path(db: string) {
    return join(this.home, db)
  }
  /** Updates `inc.db` and rebuilds `full.db`; returns both hashes and the update's result. */
  both(opts: IngestOptions = {}) {
    const r = this.ingest('inc.db', opts)
    this.full('full.db', opts)
    return { r, a: dumpHash(this.path('inc.db')), b: dumpHash(this.path('full.db')) }
  }
}

/** The first rows that differ between two stores, for a readable failure. */
export function diffStores(a: string, b: string): string {
  const A = new DatabaseSync(a, { readOnly: true })
  const B = new DatabaseSync(b, { readOnly: true })
  const out: string[] = []
  for (const [t, order] of [['nodes', 'id'], ['edges', 'src, dst, kind'], ['meta', 'key'], ['passages', 'pid'], ['synonyms', 'word, syn'], ['vocab', 'word']] as const) {
    const ra = (A.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as any[]).map((r) => JSON.stringify(r))
    const rb = (B.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as any[]).map((r) => JSON.stringify(r))
    const sa = new Set(ra)
    const sb = new Set(rb)
    for (const r of ra) if (!sb.has(r)) out.push(`${t} only in update: ${r.slice(0, 300)}`)
    for (const r of rb) if (!sa.has(r)) out.push(`${t} only in full: ${r.slice(0, 300)}`)
  }
  A.close()
  B.close()
  return out.slice(0, 12).join('\n')
}

export { existsSync, utimesSync }
