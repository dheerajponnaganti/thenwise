// Cursor: its agent transcripts (projects/<folder key>/agent-transcripts/<id>/<id>.jsonl, written by the CLI and the IDE's
// agent) in Claude Code's transcript shape, so one pipeline (masking, [no-memory], forget, search) serves them too. Cursor's
// own files are only ever read. The transcripts hold prompts, replies and tool calls with their inputs: no tool results,
// no exit codes and a time only on each prompt, to the minute.

import { existsSync } from 'node:fs'
import { join, parse, sep } from 'node:path'

import { listDir } from '../core/home.ts'
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

/** Turns one transcript line into Claude Code transcript lines. Each tool call gets an empty result right away, since the file
 * keeps none, so no step reads as one the chat stopped in. Replies take their prompt's time. */
export function cursorConverter(sessionId: string, cwd: string): (line: string) => string[] {
  let n = 0
  let at: string | undefined

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

    return tools.length ? [row('assistant', blocks), row('user', tools.map((t: any) => ({ type: 'tool_result', tool_use_id: t.id, content: '' })))] : [row('assistant', blocks)]
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
