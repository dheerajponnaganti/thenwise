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
const TOML_BLOCK = /^\[mcp_servers\.thenwise(\.[^\]]*)?\]\n(?:(?!\[)[^\n]*\n?)*/gm

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
    const block = tomlBlock(command, extra)
    const without = before.replace(TOML_BLOCK, '')
    const had = without !== before
    if (opts.remove) return { file, snippet: block, next: had ? without.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') : null, note: had ? 'removed' : 'not connected' }
    if (before.includes(block)) return { file, snippet: block, next: null, note: 'already connected' }
    const base = without.replace(/\s*$/, '')

    return { file, snippet: block, next: `${base ? `${base}\n\n` : ''}${block}`, note: 'connected' }
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
