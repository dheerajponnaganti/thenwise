// Config for archive and ingest: <data folder>/config.json merged over defaults. All paths derive from `home`
// so tests can run against a temp directory.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome, resolveDataDir } from '../core/home.ts'
import { normPath } from '../core/vault-index.ts'
import { discoverProjects } from '../setup/projects.ts'

export interface Config {
  home: string
  memDir: string
  claudeDir: string
  excludeProjects: string[]
  /** Pause switches: archive skips a project listed in offProjects, and everything when `off`. */
  off: boolean
  offProjects: string[]
  roots: string[]
  repos: string[]
  githubRepos: string[]
  vaults: string[]
  prs: boolean
  /** Keep every version of planning-with-files plans (task_plan.md, findings.md, progress.md). */
  plans: boolean
  vault: { place: string; layout: string; path: string; commit: boolean } | null
  backup: { kind: string; folders: string[]; push: boolean }
  /** `project` (default): tools answer for the session's repository plus global notes; `all`: every project. */
  scope: string
  includeEntrypoints: string[]
  ingestExcludeProjects: string[]
  /** A chat with a user prompt containing any of these is a test chat: it never enters the archive or the memory. */
  ingestExcludeMarkers: string[]
  /** Named timelines: a chat belongs to the first project whose words appear in its first prompt, or whose folders it edited. */
  viewProjects: { name: string; words: string[]; paths: string[] }[]
}

export const CONFIG_VERSION = 1

// A string is a leaf type; an object is a nested table. Unknown keys are warned, wrong types are errors.
const SCHEMA: Record<string, any> = {
  version: 'number',
  exclude_projects: 'string[]',
  off: 'boolean',
  off_projects: 'string[]',
  ingest: { roots: 'string[]', repos: 'string[]', github_repos: 'string[]', vaults: 'string[]', include_entrypoints: 'string[]', exclude_projects: 'string[]', exclude_markers: 'string[]', prs: 'boolean', plans: 'boolean' },
  vault: { place: 'string', layout: 'string', path: 'string', commit: 'boolean' },
  backup: { kind: 'string', folders: 'string[]', push: 'boolean' },
  views: { projects: 'object' },
  scope: 'string',
}
const ENUMS: Record<string, string[]> = { 'vault.place': ['central', 'project', 'obsidian'], 'vault.layout': ['shared', 'per-project'], 'backup.kind': ['none', 'git', 'folders'], scope: ['project', 'all'] }

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a table' : `${typeof v} ${JSON.stringify(v)}`)

function check(value: Record<string, unknown>, schema: Record<string, any>, at: string, errors: string[], warnings: string[]) {
  for (const [k, v] of Object.entries(value)) {
    const name = at ? `${at}.${k}` : k
    const want = schema[k]
    if (want === undefined) warnings.push(`unknown key "${name}" (ignored)`)
    else if (typeof want === 'object') plain(v) ? check(v, want, name, errors, warnings) : errors.push(`"${name}" must be a table, found ${describe(v)}`)
    else if (want === 'string[]' ? !Array.isArray(v) || v.some((x) => typeof x !== 'string') : want === 'object' ? !plain(v) : typeof v !== want) errors.push(`"${name}" must be ${want === 'string[]' ? 'a list of text' : want === 'object' ? 'a table' : `a ${want}`}, found ${describe(v)}`)
    else if (ENUMS[name] && !ENUMS[name]!.includes(v as string)) errors.push(`"${name}" must be one of ${ENUMS[name]!.join(', ')}, found "${String(v)}"`)
  }
}

export interface ConfigRead {
  /** The parsed file ({} when there is none); null when it cannot be used. */
  raw: Record<string, any> | null
  errors: string[]
  warnings: string[]
  file: string
}

// Some Node versions give no position: the first line whose prefix fails for a reason other than being unfinished.
function firstBadLine(text: string): number | null {
  const lines = text.split('\n')
  for (let n = 1; n <= lines.length; n++) {
    try {
      JSON.parse(lines.slice(0, n).join('\n'))
    } catch (e) {
      if (!/end of|unterminated|incomplete/i.test((e as Error).message)) return n
    }
  }

  return null
}

/** Reads and validates <data folder>/config.json. Never throws and never writes. */
export function readConfigFile(memDir: string): ConfigRead {
  const file = join(memDir, 'config.json')
  const res: ConfigRead = { raw: {}, errors: [], warnings: [], file }
  if (!existsSync(file)) return res
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return { ...res, raw: null, errors: [`${file}: cannot be read (${(e as Error).message})`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const msg = (e as Error).message
    const pos = /position (\d+)/.exec(msg)
    const line = /line (\d+)/.exec(msg)?.[1] ?? (pos ? text.slice(0, Number(pos[1])).split('\n').length : firstBadLine(text))

    return { ...res, raw: null, errors: [`${file}: broken JSON${line ? ` at line ${line}` : ''} (${msg}). Fix the file by hand; Thenwise will not overwrite it.`] }
  }
  if (!plain(parsed)) return { ...res, raw: null, errors: [`${file}: the top level must be a table, found ${describe(parsed)}`] }
  check(parsed, SCHEMA, '', res.errors, res.warnings)
  if (typeof parsed.version === 'number' && parsed.version > CONFIG_VERSION) res.errors.unshift(`${file}: version ${parsed.version} is newer than this Thenwise understands (${CONFIG_VERSION}). Update Thenwise.`)
  res.raw = parsed

  return res
}

/** Writes the whole file through a temp file and a rename, so a crash leaves the old file or none. */
export function saveConfig(memDir: string, raw: Record<string, unknown>) {
  mkdirSync(memDir, { recursive: true, mode: 0o700 })
  const file = join(memDir, 'config.json')
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...raw, version: CONFIG_VERSION }, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

/** The Config with defaults filled in, or the problems found. Safe for hooks and servers: it never exits. */
export function loadConfigSafe(home: string = homedir()): { config: Config | null; errors: string[]; warnings: string[] } {
  const memDir = resolveDataDir(home)
  const read = readConfigFile(memDir)
  if (!read.raw || read.errors.length) return { config: null, errors: read.errors, warnings: read.warnings }
  const user = read.raw
  const ing = user.ingest ?? {}
  const claudeDir = join(home, '.claude')
  const expand = (p: string) => expandHome(p, home)
  const list = (v: unknown, dflt: string[]) => (Array.isArray(v) ? (v as string[]) : dflt).map(expand)
  const excludeProjects: string[] = user.exclude_projects ?? ['-private-tmp*', '*-claude-mem-observer-sessions']
  // A fresh install ingests the projects found in its own history.
  const found = ing.roots === undefined || ing.repos === undefined ? discoverProjects(claudeDir).filter((p) => p.folder && !excludeProjects.some((g) => globMatch(g, p.key))).map((p) => p.folder!) : []
  const config: Config = {
    home,
    memDir,
    claudeDir,
    excludeProjects,
    off: user.off ?? false,
    offProjects: list(user.off_projects, []),
    roots: list(ing.roots, found),
    repos: list(ing.repos, found.filter((p) => existsSync(join(p, '.git')))),
    githubRepos: ing.github_repos ?? [],
    vaults: list(ing.vaults, []),
    prs: ing.prs ?? false,
    plans: ing.plans ?? true,
    vault: user.vault ? { place: 'central', layout: 'shared', commit: false, ...user.vault, path: expand(user.vault.path ?? '') } : null,
    backup: { kind: 'none', push: false, ...user.backup, folders: list(user.backup?.folders, []) },
    scope: user.scope ?? 'project',
    includeEntrypoints: ing.include_entrypoints ?? ['cli', 'claude-vscode', 'claude-desktop'],
    ingestExcludeProjects: ing.exclude_projects ?? ['*-eval-ws*'],
    ingestExcludeMarkers: ing.exclude_markers ?? ['[memory-eval]'],
    viewProjects: Object.entries((user.views?.projects ?? {}) as Record<string, { words?: string[]; paths?: string[] }>).map(([name, p]) => ({ name, words: (p.words ?? []).map((w) => w.toLowerCase()), paths: list(p.paths, []) })),
  }

  return { config, errors: [], warnings: read.warnings }
}

/** For commands: prints problems and exits 2 instead of throwing. */
export function loadConfig(home: string = homedir()): Config {
  const r = loadConfigSafe(home)
  for (const w of r.warnings) console.error(`warning: ${w}`)
  if (!r.config) {
    for (const e of r.errors) console.error(`error: ${e}`)
    process.exit(2)
  }

  return r.config
}

/** True when Thenwise is paused everywhere, or for this folder or a folder inside a paused one. */
export function isOff(cfg: Pick<Config, 'off' | 'offProjects'>, projectPath?: string): boolean {
  if (cfg.off) return true
  if (!projectPath) return false
  const p = normPath(projectPath)

  return cfg.offProjects.some((o) => p === normPath(o) || p.startsWith(`${normPath(o)}/`))
}

/** Glob with `*` only, matched against a whole project key. */
export function globMatch(pattern: string, text: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(text)
}
