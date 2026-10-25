// Where Thenwise keeps its data, and `~` expansion. One place, so every path derives from the same folder.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

/** Order: THENWISE_HOME, MEMORY_HOME, ~/.thenwise if present, ~/.memory if present (older installs), else ~/.thenwise. */
export function resolveDataDir(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  const set = env.THENWISE_HOME || env.MEMORY_HOME
  if (set) return expandHome(set, home)
  const fresh = join(home, '.thenwise')
  const old = join(home, '.memory')

  return !existsSync(fresh) && existsSync(old) ? old : fresh
}

/** An older ~/.memory that still holds Thenwise data next to a ~/.thenwise: forget, uninstall and tighten cover it too. */
export function legacyDir(dataDir: string): string | null {
  const old = join(dirname(dataDir), '.memory')
  if (basename(dataDir) !== '.thenwise' || !['graph.db', 'archive', 'config.json', 'forgotten.json'].some((f) => existsSync(join(old, f)))) return null

  return old
}

const SYNCED = [/[\\/]Library[\\/]Mobile Documents[\\/]/, /[\\/]Library[\\/]CloudStorage[\\/]/, /[\\/](Dropbox|OneDrive|Google Drive)([\\/ ]|$)/i]

/** A one-line warning when the folder sits in a synced drive: sync can corrupt a live SQLite file. */
export function cloudWarning(dir: string): string | null {
  return SYNCED.some((re) => re.test(`${dir}${sep}`)) ? `warning: ${dir} is inside a synced folder (iCloud, Dropbox, OneDrive or Google Drive). Sync can corrupt the database; set THENWISE_HOME to a local folder.` : null
}

/** `~`, `~/x` and `~\x` expand to the home folder. */
export function expandHome(p: string, home: string = homedir()): string {
  return p === '~' ? home : /^~[\\/]/.test(p) ? join(home, p.slice(2)) : p
}
