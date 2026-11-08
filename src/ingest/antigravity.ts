// Google Antigravity: its chats (brain/<id>/.system_generated/logs/transcript_full.jsonl) in Claude Code's transcript shape,
// so one pipeline (masking, [no-memory], forget, search) serves them too. Antigravity's own files are only ever read.

import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { asClaudeTool, projectKey } from './copilot.ts'

export const ANTIGRAVITY_ENTRYPOINT = 'antigravity'

/** The app, the CLI and the IDE each keep their chats in their own folder, under one parent. */
export const antigravityDirs = (home: string) => ['antigravity', 'antigravity-cli', 'antigravity-ide'].map((d) => join(home, '.gemini', d))

/** The person's words: Antigravity wraps them in <USER_REQUEST> and adds its own metadata after. */
const typed = (content: string): string => {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)

  return m ? m[1]! : content.trimStart().startsWith('<') ? '' : content
}

/** Turns one transcript line into Claude Code transcript lines. Hook-injected steps, system text and the model's thinking
 * are left out. Tool calls carry no ids, so each gets one from its step, and a result answers the calls of the step before it.
 * shortcut: lines stay in file order, a late CHECKPOINT line lands late; sort by step_index if that ever misorders turns. */
export function antigravityConverter(sessionId: string, cwd: string): (line: string) => string[] {
  let open: string[] = []

  return (line) => {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      return [line] // kept as masked plain text, like any unreadable line
    }
    const uuid = `${sessionId}:${d?.step_index}`
    const row = (type: string, content: unknown, more = {}) => JSON.stringify({ type, uuid, timestamp: d.created_at, cwd, sessionId, entrypoint: ANTIGRAVITY_ENTRYPOINT, ...more, message: { role: type, content } })
    const content = typeof d?.content === 'string' ? d.content : ''

    if (d?.type === 'USER_INPUT') {
      open = []
      const text = typed(content)

      // A slash command such as /compact is an instruction to Antigravity, not a question. A path like /Users/x is not one.
      return text && !/^\/[a-z][\w-]*(\s|$)/.test(text) ? [row('user', text)] : []
    }
    if (d?.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(d.tool_calls) ? d.tool_calls : []
      const all = calls.flatMap((c: any, i: number) => asClaudeTool(String(c?.name), c?.args).map((t, j) => ({ type: 'tool_use', id: `${uuid}#${i}.${j}`, ...t })))
      open = all.map((u: { id: string }) => u.id)
      // Reading Antigravity's own tool definitions is how it finds an MCP tool, and says nothing about the project.
      const uses = all.filter((u: { name: string; input: Record<string, unknown> }) => !(u.name === 'Read' && /[\\/]\.gemini[\\/]/.test(String(u.input.file_path))))
      const blocks = [...(content ? [{ type: 'text', text: content }] : []), ...uses]

      return blocks.length ? [row('assistant', blocks)] : []
    }
    if (d?.type === 'GENERIC' && open.length) {
      const id = open.shift()!

      // A command that ran is DONE whatever it did; its own result is the line "Command exited with code N.".
      const failed = d.status === 'ERROR' || /^Command exited with code [1-9]\d*\./m.test(content)

      return [row('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: failed }])]
    }
    if (d?.type === 'CHECKPOINT' && content) return [row('user', content, { isCompactSummary: true })]

    return []
  }
}

/** Opened workspaces by chat, from Antigravity's own index. A chat with no workspace has an empty entry. */
function workspaces(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  let db: DatabaseSync | undefined
  // A copy: even a read-only open of a WAL database can leave -wal and -shm files in Antigravity's folder.
  const tmp = mkdtempSync(join(tmpdir(), 'tw-agy-index-'))
  try {
    for (const f of ['conversation_summaries.db', 'conversation_summaries.db-wal']) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(tmp, f))
    db = new DatabaseSync(join(tmp, 'conversation_summaries.db'), { readOnly: true })
    for (const r of db.prepare('SELECT conversation_id AS id, workspace_uris AS uris FROM conversation_summaries').all() as { id: string; uris: string }[]) {
      try {
        const first = JSON.parse(r.uris)[0]
        if (typeof first === 'string' && first.startsWith('file:')) out.set(r.id, fileURLToPath(first))
      } catch {} // an empty or odd entry: the chat's own paths decide below
    }
  } catch {} // no index yet, or being written: the chat's own paths decide below
  db?.close()
  rmSync(tmp, { recursive: true, force: true })

  return out
}

/** The git root above a path, else its folder. */
function repoOf(path: string): string {
  let d = dirname(path)
  for (let up = d; ; up = dirname(up)) {
    if (existsSync(join(up, '.git'))) return up
    if (dirname(up) === up) return d
  }
}

/** A chat opened with no workspace still names its files: the first one outside Antigravity's own folders gives the project.
 * shortcut: if that repo is deleted later the chat's folder can change at the next rebuild; store the folder once if that matters. */
function folderFromPaths(file: string, home: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    for (const line of text.split('\n')) {
      let d: any
      try {
        d = JSON.parse(line)
      } catch {
        continue // the last line may be cut, or being written
      }
      for (const c of Array.isArray(d?.tool_calls) ? d.tool_calls : []) {
        const p = c?.args?.Path ?? c?.args?.AbsolutePath ?? c?.args?.TargetFile
        if (typeof p === 'string' && isAbsolute(p) && !p.startsWith(join(home, '.gemini') + sep)) return repoOf(p)
      }
    }
  } finally {
    closeSync(fd)
  }

  return home
}

/** Antigravity chats as archive sources: rel is `<project key>/<conversation id>.jsonl`, in the same project as other tools' chats. */
export function antigravitySources(home: string = homedir()): { rel: string; path: string; id: string; cwd: string }[] {
  return antigravityDirs(home).flatMap((dir) => {
    const brain = join(dir, 'brain')
    if (!existsSync(brain)) return []
    const opened = workspaces(dir)

    return readdirSync(brain, { withFileTypes: true }).flatMap((e) => {
      const path = join(brain, e.name, '.system_generated', 'logs', 'transcript_full.jsonl')
      if (!e.isDirectory() || !existsSync(path) || !statSync(path).size) return []
      const cwd = opened.get(e.name) ?? folderFromPaths(path, home)

      return [{ rel: `${projectKey(cwd)}/${e.name}.jsonl`, path, id: e.name, cwd }]
    })
  })
}
