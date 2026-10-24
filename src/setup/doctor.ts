// `thenwise doctor` with no argument: checks the install and gives one fix line per failure. Read only.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDataDir } from '../core/home.ts'
import { readConfigFile } from '../ingest/config.ts'

export interface Check {
  name: string
  ok: boolean
  /** What passed, or the one line on what to fix. */
  detail: string
}

export function ghSignedIn(): boolean {
  try {
    return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 }).status === 0
  } catch {
    return false
  }
}

const NODE_FLOOR = [22, 16]

async function sqliteFts5(): Promise<boolean> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')

    return true
  } catch {
    return false
  }
}

/** The MCP server starts and lists its tools, run from this same build (cli.ts from source, cli.js from dist). */
function mcpStarts(home: string): boolean {
  const cli = fileURLToPath(new URL(`../cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url))
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } } }
  const r = spawnSync(process.execPath, [cli, 'mcp'], { input: `${JSON.stringify(init)}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`, encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home } })

  return /"memory_search"/.test(r.stdout ?? '')
}

function pluginRegistered(home: string): boolean {
  const names = (file: string, pick: (j: any) => unknown) => {
    try {
      return Object.keys((pick(JSON.parse(readFileSync(file, 'utf8'))) ?? {}) as object)
    } catch {
      return []
    }
  }
  const claude = join(home, '.claude')

  return [...names(join(claude, 'plugins', 'installed_plugins.json'), (j) => j.plugins), ...names(join(claude, 'settings.json'), (j) => j.enabledPlugins)].some((k) => /thenwise/i.test(k))
}

export async function runDoctor(home: string = homedir(), opts: { nodeVersion?: string; gh?: () => boolean; mcp?: () => boolean } = {}): Promise<Check[]> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, good: string, fix: string) => checks.push({ name, ok, detail: ok ? good : fix })
  const memDir = resolveDataDir(home)

  const v = (opts.nodeVersion ?? process.versions.node).split('.').map(Number)
  const oldNode = v[0]! < NODE_FLOOR[0]! || (v[0] === NODE_FLOOR[0] && v[1]! < NODE_FLOOR[1]!)
  add('node', !oldNode && (await sqliteFts5()), `Node ${opts.nodeVersion ?? process.versions.node} with SQLite FTS5`, `Thenwise needs Node ${NODE_FLOOR.join('.')} or later with built-in SQLite; you have ${opts.nodeVersion ?? process.versions.node}. Install a newer Node.`)

  let writable = false
  try {
    accessSync(memDir, constants.W_OK)
    writable = true
  } catch {
    // reported below
  }
  add('data folder', writable, memDir, existsSync(memDir) ? `${memDir} is not writable. Fix it with: chmod u+w ${memDir}` : `${memDir} does not exist. Run: thenwise setup`)

  const cfg = readConfigFile(memDir)
  add('config', cfg.errors.length === 0, existsSync(cfg.file) ? cfg.file : 'no config file yet (defaults in use)', `${cfg.errors[0]}`)

  add('archive', existsSync(join(memDir, 'archive', 'manifest.json')), 'chats archived', 'No archive yet. Run: thenwise archive')

  let store = existsSync(join(memDir, 'graph.db'))
  let storeFix = 'No store yet. Run: thenwise ingest'
  if (store) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(join(memDir, 'graph.db'), { readOnly: true })
      store = db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok'
      db.close()
    } catch {
      store = false
    }
    storeFix = `The store at ${join(memDir, 'graph.db')} will not open. Delete it and run: thenwise ingest`
  }
  add('store', store, 'graph.db opens', storeFix)

  add('plugin', pluginRegistered(home), 'registered with Claude Code', 'The Thenwise plugin is not registered. In Claude Code run: /plugin install thenwise')
  add('mcp', (opts.mcp ?? (() => mcpStarts(home)))(), 'the memory tools server starts', 'The memory tools server did not start. Run `thenwise mcp` in a terminal to see the error.')
  add('gh', (opts.gh ?? ghSignedIn)(), 'signed in', 'gh is not signed in (only needed for PRs). Run: gh auth login')

  return checks
}

export async function doctorCommand(home: string = homedir()): Promise<number> {
  const checks = await runDoctor(home)
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(12)} ${c.detail}`)

  return checks.every((c) => c.ok) ? 0 : 1
}
