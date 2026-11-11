// `thenwise connect <tool>`: adds the memory tools to another coding tool through its MCP config, so that tool can read
// this memory and whatever a team shared into it. Codex and Antigravity chats are read by their own readers; connect adds
// only the memory tools.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TOOLS = ['antigravity', 'codex', 'cursor', 'gemini', 'opencode'] as const
export type Tool = (typeof TOOLS)[number]

export interface Plan {
  file: string
  /** What the entry looks like, for a dry run or for adding it by hand. */
  snippet: string
  /** The file after the change, or null when it is already that way or cannot be changed safely. */
  next: string | null
  note: string
}

/** Full paths, because a desktop app's PATH often has no node. The server command: this Node and this package. */
export function serverCommand(node = process.execPath, cli = realpathSync(process.argv[1]!)): [string, string[]] {
  return [node, [cli, 'mcp']]
}

const fileOf = (tool: Tool, home: string, env: NodeJS.ProcessEnv): string =>
  tool === 'codex' ? join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
    : tool === 'antigravity' ? join(home, '.gemini', 'config', 'mcp_config.json')
      : tool === 'cursor' ? join(home, '.cursor', 'mcp.json')
      : tool === 'gemini' ? join(home, '.gemini', 'settings.json')
        : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json')

/** The entry in each tool's own JSON shape. Cursor starts servers outside the project, so it is told the folder. */
function jsonEntry(tool: Tool, [command, args]: [string, string[]], extra: Record<string, string>): [string, unknown] {
  if (tool === 'opencode') return ['mcp', { type: 'local', command: [command, ...args], ...(Object.keys(extra).length ? { environment: extra } : {}) }]
  const env = tool === 'cursor' ? { ...extra, THENWISE_PROJECT: '${workspaceFolder}' } : extra

  return ['mcpServers', { command, args, ...(Object.keys(env).length ? { env } : {}) }]
}

const tomlString = (s: string) => JSON.stringify(s)
// Our table or one of its sub-tables, on a trimmed line. TOML allows spaces and quotes in a header.
const OURS = /^\[\s*mcp_servers\s*\.\s*(?:thenwise|"thenwise"|'thenwise')\s*(\.[^\]]*)?\]\s*(?:#.*)?$/
// Any table header, indented or not.
// shortcut: a nested array in our table whose line starts with [ reads as a header; Thenwise writes args on one line, upgrade to a TOML parser if users hand-edit it.
const isHead = (line: string) => line.trimStart().startsWith('[')
const loose = (line: string) => /^(#|$)/.test(line.trim())

/** The file without our table and its sub-tables, line by line, so each line keeps its own ending. Comments and blank
 * lines at the end of our table belong to what follows, so they stay. `tables` counts our main tables. */
function withoutBlock(text: string): { text: string; tables: number } {
  const lines = text.split('\n')
  const out: string[] = []
  let tables = 0
  for (let i = 0; i < lines.length; ) {
    const m = OURS.exec(lines[i]!.trim())
    if (!m) {
      out.push(lines[i++]!)
      continue
    }
    if (!m[1]) tables++
    let j = i + 1
    while (j < lines.length && !isHead(lines[j]!)) j++
    let k = j
    while (k > i + 1 && loose(lines[k - 1]!)) k--
    const kept = lines.slice(k, j)
    // One gap where the table was, not two. The blank lines before it go, so the file's last line ending stays.
    if (kept.length && !kept[0]!.trim()) {
      while (out.length && !out.at(-1)!.trim()) out.pop()
      if (!out.length) while (kept.length && !kept[0]!.trim()) kept.shift()
    }
    out.push(...kept)
    i = j
  }

  return { text: out.join('\n'), tables }
}

function tomlBlock([command, args]: [string, string[]], extra: Record<string, string>): string {
  const env = Object.entries(extra).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')

  return `[mcp_servers.thenwise]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n${env ? `env = { ${env} }\n` : ''}`
}

/** What connecting (or with remove, disconnecting) would do. Writes nothing. */
export function plan(tool: Tool, opts: { home?: string; env?: NodeJS.ProcessEnv; command?: [string, string[]]; remove?: boolean } = {}): Plan {
  const env = opts.env ?? process.env
  const file = fileOf(tool, opts.home ?? homedir(), env)
  const command = opts.command ?? serverCommand()
  const extra: Record<string, string> = env.THENWISE_HOME ? { THENWISE_HOME: env.THENWISE_HOME } : {}
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''

  if (tool === 'codex') {
    const snippet = tomlBlock(command, extra)
    const eol = before.includes('\r\n') ? '\r\n' : '\n'
    const block = snippet.replaceAll('\n', eol)
    const { text: without, tables } = withoutBlock(before)
    const had = without !== before
    if (opts.remove) return { file, snippet, next: had ? without : null, note: had ? 'removed' : 'not connected' }
    // A second table (an older Thenwise appended one to CRLF files) is invalid TOML, so it is rewritten as one.
    if (tables === 1 && before.includes(block)) return { file, snippet, next: null, note: 'already connected' }
    const base = without.replace(/\s*$/, '')

    return { file, snippet, next: `${base ? `${base}${eol}${eol}` : ''}${block}`, note: 'connected' }
  }

  const [key, entry] = jsonEntry(tool, command, extra)
  const snippet = JSON.stringify({ [key]: { thenwise: entry } }, null, 2)
  let config: Record<string, any>
  try {
    config = before.trim() ? JSON.parse(before) : {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object')
  } catch {
    // Comments or a mistake in the file: rewriting it would lose them, so it stays the user's to edit.
    return { file, snippet, next: null, note: 'cannot read this file as plain JSON, so it was left alone; add the entry by hand' }
  }
  const servers = config[key] && typeof config[key] === 'object' ? config[key] : {}
  if (opts.remove) {
    if (!servers.thenwise) return { file, snippet, next: null, note: 'not connected' }
    delete servers.thenwise

    return { file, snippet, next: `${JSON.stringify({ ...config, [key]: servers }, null, 2)}\n`, note: 'removed' }
  }
  if (JSON.stringify(servers.thenwise) === JSON.stringify(entry)) return { file, snippet, next: null, note: 'already connected' }

  return { file, snippet, next: `${JSON.stringify({ ...config, [key]: { ...servers, thenwise: entry } }, null, 2)}\n`, note: 'connected' }
}

export function apply(p: Plan): void {
  if (p.next === null) return
  mkdirSync(dirname(p.file), { recursive: true })
  const tmp = `${p.file}.thenwise-tmp`
  writeFileSync(tmp, p.next, { mode: 0o600 })
  renameSync(tmp, p.file)
}
