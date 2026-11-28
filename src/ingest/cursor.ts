// Cursor: its agent transcripts (projects/<folder key>/agent-transcripts/<id>/<id>.jsonl, written by the CLI and the IDE's
// agent) in Claude Code's transcript shape, so one pipeline (masking, [no-memory], forget, search) serves them too. Cursor's
// own files are only ever read. The transcripts hold prompts, replies and tool calls with their inputs: no tool results,
// no exit codes and a time only on each prompt, to the minute. Whether a shell command failed comes from Thenwise's own
// hook, which records each run in cursor-runs/<chat id>.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, parse, sep } from 'node:path'

import { listDir } from '../core/home.ts'
import { maskSecrets } from '../core/secrets.ts'
import { projectKey } from './copilot.ts'

export const CURSOR_ENTRYPOINT = 'cursor'

export const cursorDir = (home: string) => join(home, '.cursor')

/** Cursor's own folder key: each run of other characters becomes one "-", with none at either end. Lossy, unlike Claude's. */
export const cursorKey = (path: string) => path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** The folder a Cursor key was made from, found by walking the disk and matching each directory's own key, so names with
 * dots, spaces or dashes come back exactly. '' when no folder on this machine matches (moved, deleted, another machine). */
export function folderOfKey(key: string): string {
  const walk = (dir: string, rest: string): string => {
    if (rest === '') return dir
    for (const e of listDir(dir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const k = cursorKey(e.name)
      if (!k || (rest !== k && !rest.startsWith(`${k}-`))) continue
      const found = walk(join(dir, e.name), rest.slice(k.length + 1))
      if (found) return found
    }

    return ''
  }
  // Windows keys start with the drive letter ("C-Users-..."); elsewhere they start under the root.
  const drive = sep === '\\' ? /^([A-Za-z])-(.*)$/.exec(key) : null

  return drive ? walk(`${drive[1]!.toUpperCase()}:\\`, drive[2]!) : walk(parse(process.cwd()).root, key)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The prompt's own time, from Cursor's tag such as "Saturday, Nov 28, 2026, 3:43 PM (UTC+5:30)". undefined when absent. */
export function promptTime(text: string): string | undefined {
  const m = /<timestamp>[^<]*?([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ([AP]M) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)/.exec(text)
  if (!m) return undefined
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return undefined
  const hour = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0)
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0))

  return new Date(Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60e3).toISOString()
}

/** What the person typed: the text inside <user_query>, or the text with Cursor's tags taken out. */
const typed = (text: string) => {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)

  return (q ? q[1]! : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')).trim()
}

/** A Cursor tool call as the Claude Code tool it matches. Other tools keep their name and input. */
export function cursorTool(name: string, input: unknown): { name: string; input: Record<string, unknown> } {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const file = a.path ?? a.file_path ?? a.target_file
  if (name === 'Read') return { name: 'Read', input: { file_path: file } }
  if (name === 'StrReplace' || name === 'Edit' || name === 'edit_file_v2') return { name: 'Edit', input: { file_path: file, old_string: a.old_string ?? '', new_string: a.new_string ?? '' } }
  if (name === 'Write') return { name: 'Write', input: { file_path: file, content: a.contents ?? a.content ?? '' } }
  if (name === 'Shell' || name === 'run_terminal_cmd') return { name: 'Bash', input: { command: a.command ?? '' } }

  return { name, input: a }
}

export const cursorRunsFile = (memDir: string, sessionId: string) => join(memDir, 'cursor-runs', `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`)
const commandHash = (cmd: string) => createHash('sha256').update(cmd).digest('hex').slice(0, 16)
const ERROR_MAX = 4000

/** From the post hook: one line per shell run in a Cursor chat. The command is kept only as a hash, to match its call in the
 * transcript (which has no call ids); a failure keeps its error text, masked. */
export function recordCursorRun(memDir: string, sessionId: string, run: { id?: unknown; command: string; error?: unknown }) {
  const file = cursorRunsFile(memDir, sessionId)
  mkdirSync(join(memDir, 'cursor-runs'), { recursive: true, mode: 0o700 })
  const failed = typeof run.error === 'string'
  const out = failed ? maskSecrets((run.error as string).slice(0, ERROR_MAX)).text : undefined
  appendFileSync(file, `${JSON.stringify({ id: typeof run.id === 'string' ? run.id : undefined, cmd: commandHash(run.command), failed, out })}\n`, { mode: 0o600 })
}

/** The recorded runs of one chat, in order, per command. A run two installs both recorded counts once. */
function runsOf(memDir: string, sessionId: string): Map<string, { failed: boolean; out?: string }[]> {
  const byCmd = new Map<string, { failed: boolean; out?: string }[]>()
  let text = ''
  try {
    text = readFileSync(cursorRunsFile(memDir, sessionId), 'utf8')
  } catch {
    return byCmd // no hook ran: every result stays empty
  }
  const ids = new Set<string>()
  for (const line of text.split('\n')) {
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue // an empty or torn last line
    }
    if (typeof r?.cmd !== 'string' || (r.id && ids.has(r.id))) continue
    if (r.id) ids.add(r.id)
    byCmd.set(r.cmd, [...(byCmd.get(r.cmd) ?? []), { failed: r.failed === true, out: typeof r.out === 'string' ? r.out : undefined }])
  }

  return byCmd
}

/** Turns one transcript line into Claude Code transcript lines. Each tool call gets a result right away, since the file keeps
 * none, so no step reads as one the chat stopped in: empty, or a shell command's error when the hook recorded it failing.
 * The nth run of a command is matched to the nth recorded run of it. Replies take their prompt's time.
 * shortcut: a chat read from its tail only (the live brief of a very long chat) can match runs to the wrong calls; fine while
 * that brief only names the last steps. */
export function cursorConverter(sessionId: string, cwd: string, memDir = ''): (line: string) => string[] {
  let n = 0
  let at: string | undefined
  const runs = memDir ? runsOf(memDir, sessionId) : new Map<string, { failed: boolean; out?: string }[]>()
  const result = (t: any) => {
    const run = t.name === 'Bash' && typeof t.input.command === 'string' ? runs.get(commandHash(t.input.command))?.shift() : undefined

    return run?.failed ? { type: 'tool_result', tool_use_id: t.id, content: run.out ?? '', is_error: true } : { type: 'tool_result', tool_use_id: t.id, content: '' }
  }

  return (line) => {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      return [line] // kept as masked plain text, like any unreadable line
    }
    n++
    const content = Array.isArray(d?.message?.content) ? d.message.content : []
    const row = (type: string, body: unknown) => JSON.stringify({ type, uuid: `${sessionId}:${n}`, timestamp: at, cwd, sessionId, entrypoint: CURSOR_ENTRYPOINT, message: { role: type, content: body } })
    if (d?.role === 'user') {
      const raw = content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text as string).join('\n')
      at = promptTime(raw) ?? at
      const text = typed(raw)

      return text ? [row('user', text)] : []
    }
    if (d?.role !== 'assistant') return [] // turn_ended and anything newer
    const blocks = content.flatMap((c: any, j: number) => {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) return [{ type: 'text', text: c.text }]
      if (c?.type === 'tool_use' && typeof c.name === 'string') return [{ type: 'tool_use', id: `${sessionId}:${n}#${j}`, ...cursorTool(c.name, c.input) }]

      return []
    })
    if (!blocks.length) return []
    const tools = blocks.filter((b: any) => b.type === 'tool_use')

    return tools.length ? [row('assistant', blocks), row('user', tools.map(result))] : [row('assistant', blocks)]
  }
}

/** A key whose folder is gone, spelled back as a path: "C-Users-x" is C:\\Users\\x on Windows, "Users-x" is /Users/x elsewhere. */
export const spelledBack = (key: string) => (sep === '\\' ? key.replace(/^([A-Za-z])-/, '$1:\\').replace(/-/g, '\\') : `/${key.replace(/-/g, '/')}`)

/** Cursor chats as archive sources: rel is `<project key>/<chat id>.jsonl`, in the same project as Claude Code's chats of that
 * folder. A chat opened with no folder joins the home folder.
 * shortcut: a key whose folder no longer exists on this machine is spelled back with "/" for each "-", which can name the wrong
 * folder; read the IDE's workspace.json for those once the state.vscdb reader lands. */
export function cursorSources(home: string): { rel: string; path: string; id: string; cwd: string }[] {
  const out: { rel: string; path: string; id: string; cwd: string }[] = []
  const root = join(cursorDir(home), 'projects')
  for (const p of listDir(root)) {
    if (!p.isDirectory()) continue
    const dir = join(root, p.name, 'agent-transcripts')
    if (!existsSync(dir)) continue
    const cwd = p.name === 'empty-window' ? home : folderOfKey(p.name) || spelledBack(p.name)
    for (const c of listDir(dir)) {
      if (!c.isDirectory() || !/^[0-9a-f-]{8,}$/i.test(c.name)) continue
      const path = join(dir, c.name, `${c.name}.jsonl`)
      if (existsSync(path)) out.push({ rel: `${projectKey(cwd)}/${c.name}.jsonl`, path, id: c.name, cwd })
    }
  }

  return out
}
