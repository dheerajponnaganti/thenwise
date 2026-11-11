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
/** Where each line starts: at the top level, or inside a multi-line array, inline table or string. `hash` is where a
 * line's comment starts, or -1. Null when a value or string is never closed: that is not TOML, so it is not edited. */
function scan(lines: string[]): { top: boolean[]; hash: number[] } | null {
  let depth = 0
  let str = ''
  const top: boolean[] = []
  const hash: number[] = []
  for (const line of lines) {
    top.push(!depth && !str)
    let h = -1
    for (let c = 0; c < line.length && h < 0; c++) {
      const ch = line[c]!
      if (str) {
        if (ch === '\\' && str[0] === '"') c++
        else if (line.startsWith(str, c)) {
          if (str.length === 3) while (line[c + 3] === str[0]) c++ // """" ends with a quote in the string
          c += str.length - 1
          str = ''
        }
      } else if (ch === '#') h = c
      else if (ch === '"' || ch === "'") {
        str = line.startsWith(ch.repeat(3), c) ? ch.repeat(3) : ch
        c += str.length - 1
      } else if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    }
    hash.push(h)
    if (str.length === 1) return null // a one-line string ends on its line
  }

  return depth || str ? null : { top, hash }
}

/** A dotted key, bare or quoted, and the text after it. */
function keyPath(s: string): { path: string[]; rest: string } | null {
  const path: string[] = []
  for (let i = 0; ; i++) {
    while (s[i] === ' ' || s[i] === '\t') i++
    const q = s[i]
    if (q === '"' || q === "'") {
      let v = ''
      for (i++; i < s.length && s[i] !== q; i++) v += q === '"' && s[i] === '\\' ? s[++i] : s[i]
      if (i >= s.length) return null
      path.push(v)
      i++
    } else {
      const m = /^[\w-]+/.exec(s.slice(i))
      if (!m) return null
      path.push(m[0])
      i += m[0].length
    }
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] !== '.') return { path, rest: s.slice(i) }
  }
}

const headerPath = (line: string): string[] | null => {
  const t = line.trim()
  const close = t.startsWith('[[') ? ']]' : ']'
  const k = keyPath(t.slice(close.length))

  return k && k.rest.startsWith(close) ? k.path : null
}
const ours = (path: string[]) => path[0] === 'mcp_servers' && path[1] === 'thenwise'

/** The file without our entry, line by line, so each line keeps its own ending. The entry is our table and its
 * sub-tables, or a `thenwise` key (an inline table or dotted keys) in another table. Comments and blank lines at the
 * end of our table belong to what follows, so they stay. A table left empty by a removed key goes, its comment stays.
 * `tables` counts our main tables and `keys` the keys. Null when the file is not TOML this can read. */
function withoutBlock(text: string): { text: string; tables: number; keys: number } | null {
  const lines = text.split('\n')
  const s = scan(lines)
  if (!s) return null
  const head = (i: number) => s.top[i]! && lines[i]!.trimStart().startsWith('[')
  const loose = (i: number) => s.top[i]! && /^(#|$)/.test(lines[i]!.trim())
  const out: string[] = []
  let tables = 0
  let keys = 0
  // The current table: its path, its header's line and place in out, and whether it keeps a key or lost one of ours.
  let table: string[] = []
  let from = -1
  let at = -1
  let body = false
  let cut = false
  // One gap where a removed part was, not two. The blank lines before it go, so the file's last line ending stays.
  const seam = (kept: string[]) => {
    if (!kept.length || kept[0]!.trim()) return
    while (out.length && !out.at(-1)!.trim()) out.pop()
    if (!out.length) while (kept.length && !kept[0]!.trim()) kept.shift()
  }
  const close = () => {
    if (at < 0 || !cut || body) return
    const h = s.hash[from]!
    if (h >= 0) return void (out[at] = lines[from]!.match(/^\s*/)![0] + lines[from]!.slice(h))
    const rest = out.splice(at).slice(1)
    seam(rest)
    out.push(...rest)
  }
  for (let i = 0; i < lines.length; ) {
    if (head(i)) {
      close()
      table = headerPath(lines[i]!) ?? ['\0']
      if (!ours(table)) {
        from = i
        at = out.length
        body = cut = false
        out.push(lines[i++]!)
        continue
      }
      at = -1
      if (table.length === 2) tables++
      let j = i + 1
      while (j < lines.length && !head(j)) j++
      let k = j
      while (k > i + 1 && loose(k - 1)) k--
      const kept = lines.slice(k, j)
      seam(kept)
      out.push(...kept)
      i = j
      continue
    }
    const key = s.top[i] && !loose(i) ? keyPath(lines[i]!) : null
    if (key && key.rest.startsWith('=') && ours([...table, ...key.path])) {
      keys++
      cut = true
      for (i++; i < lines.length && !s.top[i]; i++);
      continue
    }
    if (s.top[i] && !loose(i)) body = true
    out.push(lines[i++]!)
  }
  close()

  return { text: out.join('\n'), tables, keys }
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
    const read = withoutBlock(before)
    if (!read) return { file, snippet, next: null, note: 'cannot read this file as TOML, so it was left alone; add the entry by hand' }
    const { text: without, tables, keys } = read
    const had = without !== before
    if (opts.remove) return { file, snippet, next: had ? without : null, note: had ? 'removed' : 'not connected' }
    // A second table (an older Thenwise appended one to CRLF files) is invalid TOML, and a thenwise key in another
    // table is the same entry written another way. Both are rewritten as one table.
    if (tables === 1 && !keys && before.includes(block)) return { file, snippet, next: null, note: 'already connected' }
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
