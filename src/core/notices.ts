// What the person sees from Thenwise, by one rule: a line only when something left the machine or spent their plan,
// something broke, something waits with a deadline, or the agent got a block that changes what it does. Everything else
// stays quiet and goes to status and the log. `notices` in config.json (all, important, off) or THENWISE_NOTICES turns
// it down. Also: what was sent to the agent in each session, for /thenwise:shown.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { maskSecrets } from './secrets.ts'

/** Claude Code and Copilot load Thenwise's /thenwise: commands; Codex and Antigravity load none, so there a command is
 * named as the CLI line that runs it. The MCP server names its client at initialize; a hook knows its tool from the
 * environment (Antigravity sets its conversation id; Codex sets PLUGIN_ROOT, Copilot COPILOT_PLUGIN_ROOT). */
let clientWithoutCommands = false
export const setClient = (name: string) => (clientWithoutCommands = /codex|antigravity|jetski/i.test(name))
const loadsCommands = () => !clientWithoutCommands && !process.env.ANTIGRAVITY_CONVERSATION_ID && !(process.env.PLUGIN_ROOT && !process.env.COPILOT_PLUGIN_ROOT)
/** Text with each /thenwise:<name> as this tool can run it. */
export function forHost(text: string): string {
  if (loadsCommands() || !text.includes('/thenwise:')) return text
  const me = process.argv[1] ?? ''
  const cli = /[\\/]cli\.[jt]s$/.test(me) ? `node "${me}"` : 'thenwise'

  return text.replace(/\/thenwise:(\w+)/g, (_, c: string) => `\`${cli} ${c}\``)
}

export type NoticeLevel = 'all' | 'important' | 'off'
/** important: something left the machine, spent the person's plan, or broke. all: also deadlines and blocks the agent got. */
export type NoticeClass = 'important' | 'all'

export function noticeLevel(cfg?: { notices?: string } | null): NoticeLevel {
  const v = process.env.THENWISE_NOTICES ?? cfg?.notices ?? 'all'

  return v === 'off' || v === 'important' ? v : 'all'
}
export const shows = (level: NoticeLevel, cls: NoticeClass) => level === 'all' || (level === 'important' && cls === 'important')

const state = (dir: string) => join(dir, 'hook-state')

// The news queue: background steps leave a line; the next session start shows the unread ones, once.
export const newsFile = (dir: string) => join(state(dir), 'news.jsonl')
const toldFile = (dir: string) => join(state(dir), 'news-told')

export function addNews(dir: string, kind: string, text: string, cls: NoticeClass = 'important') {
  try {
    mkdirSync(state(dir), { recursive: true, mode: 0o700 })
    appendFileSync(newsFile(dir), `${JSON.stringify({ at: new Date().toISOString(), kind, cls, text: maskSecrets(text).text.slice(0, 200) })}\n`, { mode: 0o600 })
  } catch {} // news is a courtesy: it never fails the step that writes it
}

/** The unread news, newest line per kind, as one line of at most 300 characters; '' when none. Marks it read. */
export function takeNews(dir: string, level: NoticeLevel, now = Date.now()): string {
  if (level === 'off' || !existsSync(newsFile(dir))) return ''
  let told = 0
  try {
    told = Date.parse(readFileSync(toldFile(dir), 'utf8'))
  } catch {} // never told
  const latest = new Map<string, string>()
  for (const l of readFileSync(newsFile(dir), 'utf8').split('\n')) {
    try {
      const n = JSON.parse(l) as { at: string; kind: string; cls: NoticeClass; text: string }
      if (Date.parse(n.at) > (told || 0) && shows(level, n.cls)) latest.set(n.kind, n.text)
    } catch {} // a half-written line
  }
  if (!latest.size) return ''
  writeFileSync(toldFile(dir), new Date(now).toISOString(), { mode: 0o600 })
  const line = [...latest.values()].join('; ')

  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

// What went to the agent this session: one line per block, in <session>.sent.jsonl (forget and the weekly sweep remove it).
const TAGS = ['memory-handoff', 'memory-brief', 'memory-resume', 'memory-pointers', 'memory-history', 'memory-team', 'memory-first-run'] as const
const KIND: Record<(typeof TAGS)[number], string> = { 'memory-handoff': 'handoff', 'memory-brief': 'brief', 'memory-resume': 'resume', 'memory-pointers': 'pointers', 'memory-history': 'file hint', 'memory-team': 'teammate chat', 'memory-first-run': 'first run' }
export const sentFile = (dir: string, session: string) => join(state(dir), `${session.replace(/[^\w-]/g, '_')}.sent.jsonl`)

/** Records each Thenwise block in a context text that went to the agent. */
export function recordSent(dir: string, session: string, event: string, context: string) {
  if (!session || (!context && !event.endsWith(' compact'))) return
  try {
    const lines: string[] = []
    for (const t of TAGS) {
      for (const m of context.matchAll(new RegExp(`<${t}[\\s\\S]*?</${t}>`, 'g'))) lines.push(JSON.stringify({ at: new Date().toISOString(), event, kind: KIND[t], tokens: Math.ceil(m[0].length / 4), text: m[0] }))
    }
    // A compaction takes earlier blocks out of the agent's context, so it is recorded even when it sent none.
    if (event.endsWith(' compact')) lines.push(JSON.stringify({ at: new Date().toISOString(), event, kind: 'compaction', tokens: 0, text: '' }))
    if (!lines.length) return
    mkdirSync(state(dir), { recursive: true, mode: 0o700 })
    appendFileSync(sentFile(dir, session), `${lines.join('\n')}\n`, { mode: 0o600 })
  } catch {} // a record of what was sent never fails the hook that sent it
}

export interface Sent {
  at: string
  event: string
  kind: string
  tokens: number
  text: string
}
/** What was sent in one session (by default the newest that has a record), oldest first. */
export function readSent(dir: string, session?: string): { session: string; sent: Sent[] } | null {
  let file = session ? sentFile(dir, session) : ''
  if (!session) {
    const files = existsSync(state(dir)) ? readdirSync(state(dir)).filter((n) => n.endsWith('.sent.jsonl')) : []
    const newest = files.map((n) => ({ n, t: statSync(join(state(dir), n)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
    if (!newest) return null
    file = join(state(dir), newest.n)
  }
  if (!existsSync(file)) return null
  const sent = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as Sent]
    } catch {
      return []
    }
  })

  return { session: file.split(/[\\/]/).pop()!.replace(/\.sent\.jsonl$/, ''), sent }
}

/** The chat (`ses:xxxx`) of the handoff this session's agent still holds: the last one sent, with no compaction after it. */
export function heldHandoff(dir: string, session: string): string | undefined {
  const sent = readSent(dir, session)?.sent ?? []
  const i = sent.findLastIndex((s) => s.kind === 'handoff')
  if (i < 0 || sent.slice(i + 1).some((s) => s.kind === 'compaction')) return undefined

  return /^<memory-handoff [^>]*chat="(ses:[^"]+)"/.exec(sent[i]!.text)?.[1]
}

/** The one line for the person about what a session start gave the agent; '' when it gave nothing worth naming. */
export function addedLine(context: string): string {
  const handoff = /<memory-handoff tool="([^"]+)" chat="(ses:[^"]+)"[^>]*>\nstate: [^\n]*?\(([^)]*ago)\)/.exec(context)
  const parts: string[] = []
  if (handoff) parts.push(`where a ${handoff[1]} session stopped ${handoff[3]} (${handoff[2]})`)
  if (/<memory-resume /.test(context)) parts.push('a resume brief of this session')
  if (/<memory-brief /.test(context)) parts.push("this project's recent history")
  if (!parts.length || (!handoff && !/<memory-resume /.test(context))) return '' // a brief alone is routine: it stays quiet

  return `Thenwise added: ${parts.join(', and ')}. /thenwise:shown lists it.`
}
