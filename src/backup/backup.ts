// `thenwise backup`: the vault, to its own git repo or to listed folders. The vault is only read, except that
// the git kind makes a repo and commits in it. The archive and the store are never part of a backup.

import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import type { Config } from '../ingest/config.ts'

const DAY_MS = 864e5
const stamp = (cfg: Config) => join(cfg.memDir, 'backup.json')
// Names that hold chats or the store, wherever they sit in the vault.
const NEVER = [/^graph\.db/, /^archive$/, /^sync\.lock/, /^team\.json/, /^forgotten\.json/, /^backup\.json/, /^\.git$/]

export interface BackupResult {
  lines: string[]
  ok: boolean
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep)

/** Files of the vault that a backup may hold, as paths relative to the vault. */
function files(vault: string, memDir: string): string[] {
  const out: string[] = []
  const dataInside = memDir !== vault && inside(memDir, vault) // the data folder sits inside the vault
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name)
      if (NEVER.some((re) => re.test(e.name)) || (dataInside && inside(p, memDir))) continue
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(relative(vault, p))
    }
  }
  walk(vault)

  return out.sort()
}

function git(vault: string, args: string[]): string {
  return execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function toGit(cfg: Config, vault: string): string[] {
  const lines: string[] = []
  if (!existsSync(join(vault, '.git'))) {
    git(vault, ['init', '-q'])
    lines.push(`made a git repo in ${vault}`)
  }
  // Keeps the archive and the store out of the repo when the vault sits inside the data folder.
  const exclude = join(vault, '.git', 'info', 'exclude')
  mkdirSync(dirname(exclude), { recursive: true })
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  const data = resolve(cfg.memDir)
  const want = ['archive/', 'graph.db*', 'sync.lock*', 'team.json', 'forgotten.json', 'backup.json', ...(data !== vault && inside(data, vault) ? [`/${relative(vault, data).split(sep).join('/')}/`] : [])].filter((l) => !have.split('\n').includes(l))
  if (want.length) appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${want.join('\n')}\n`)
  let who: string[] = []
  try {
    who = git(vault, ['config', 'user.email']).trim() ? [] : ['-c', 'user.name=Thenwise', '-c', 'user.email=thenwise@localhost']
  } catch {
    who = ['-c', 'user.name=Thenwise', '-c', 'user.email=thenwise@localhost']
  }
  git(vault, ['add', '-A'])
  if (git(vault, ['status', '--porcelain']).trim() === '') lines.push('git: nothing changed since the last commit')
  else {
    git(vault, [...who, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Thenwise backup ${new Date().toISOString()}`])
    lines.push('git: committed the vault')
  }
  if (cfg.backup.push) {
    try {
      git(vault, ['remote', 'get-url', 'origin'])
    } catch {
      throw new Error('backup.push is on but the vault repo has no remote named origin. Add one with: git remote add origin <url>')
    }
    git(vault, ['push', '-q', 'origin', 'HEAD'])
    lines.push('git: pushed to origin')
  } else lines.push('git: not pushed (set backup.push to true in config.json to push)')

  return lines
}

function toFolder(vault: string, memDir: string, target: string): string {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`${target} does not exist or is not a folder`)
  try {
    accessSync(target, constants.W_OK)
  } catch {
    throw new Error(`${target} is read-only`)
  }
  const dest = join(target, basename(vault))
  const list = files(vault, memDir)
  let copied = 0
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  for (const rel of list) {
    const from = join(vault, rel)
    const to = join(dest, rel)
    const a = statSync(from)
    if (existsSync(to) && statSync(to).size === a.size && statSync(to).mtimeMs >= a.mtimeMs) continue
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    copyFileSync(from, to)
    chmodSync(to, 0o600)
    copied++
  }
  // The copy mirrors the vault: a note removed from the vault leaves the backup too.
  const keep = new Set(list)
  let removed = 0
  const sweep = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name)
      if (e.isDirectory()) {
        sweep(p)
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true })
      } else if (!keep.has(relative(dest, p))) (rmSync(p), removed++)
    }
  }
  sweep(dest)

  return `${dest}: ${copied} copied, ${removed} removed`
}

export function backup(cfg: Config, opts: { daily?: boolean } = {}): BackupResult {
  const res: BackupResult = { lines: [], ok: true }
  if (cfg.backup.kind === 'none') return { lines: opts.daily ? [] : ['backup is not set up: set backup.kind to "git" or "folders" in config.json'], ok: !!opts.daily }
  if (opts.daily && existsSync(stamp(cfg))) {
    try {
      if (Date.now() - Date.parse(JSON.parse(readFileSync(stamp(cfg), 'utf8')).last) < DAY_MS) return res
    } catch {}
  }
  const vault = cfg.vault?.path ? resolve(cfg.vault.path) : ''
  if (!vault || !existsSync(vault)) return { lines: [`no vault to back up${vault ? ` (${vault} does not exist)` : ': set vault.path in config.json'}`], ok: false }
  const memDir = resolve(cfg.memDir)
  try {
    if (cfg.backup.kind === 'git') res.lines.push(...toGit(cfg, vault))
    else {
      if (!cfg.backup.folders.length) throw new Error('backup.kind is "folders" but backup.folders is empty')
      for (const f of cfg.backup.folders) {
        try {
          res.lines.push(toFolder(vault, memDir, resolve(f)))
        } catch (e) {
          res.ok = false
          res.lines.push(`backup failed for ${f}: ${(e as Error).message}`)
        }
      }
    }
  } catch (e) {
    res.ok = false
    const err = e as Error & { stderr?: string }
    res.lines.push(`backup failed: ${(err.stderr?.trim() || err.message).split('\n')[0]}`)
  }
  if (res.ok) writeFileSync(stamp(cfg), JSON.stringify({ last: new Date().toISOString() }), { mode: 0o600 })

  return res
}
