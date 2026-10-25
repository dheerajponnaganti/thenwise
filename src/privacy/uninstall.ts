// `thenwise uninstall`: stops the background sync and prints what to delete by hand. It deletes nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { legacyDir, resolveDataDir } from '../core/home.ts'
import { loadConfigSafe } from '../ingest/config.ts'

export function uninstall(home: string = homedir(), print: (l: string) => void = console.log): number {
  const memDir = resolveDataDir(home)
  const cfg = loadConfigSafe(home).config
  const lock = join(memDir, 'sync.lock')
  let stopped = false
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    try {
      // A recycled pid must not get our signal: it has to be a live process whose command line names Thenwise.
      const cmd = pid > 0 && Date.now() - statSync(lock).mtimeMs < 6 * 3600e3 ? execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : ''
      if (/thenwise|memory-v2/i.test(cmd)) (process.kill(pid, 'SIGTERM'), (stopped = true))
    } catch {}
  }
  print(stopped ? 'Stopped the background sync.' : 'No background sync is running.')
  print('Delete these by hand. Thenwise removes nothing itself.')
  print(`  1. The data folder, with the archive, the store, the config and the hook log: ${memDir}`)
  if (cfg?.vault?.path) print(`  2. The folder _thenwise/ inside your vault: ${join(resolve(cfg.vault.path), '_thenwise')}`)
  else print('  2. The folder _thenwise/ inside your vault, if you set one up.')
  const where = cfg?.backup.kind === 'folders' ? cfg.backup.folders.map((f) => `copies in ${f}`).join(', ') : cfg?.backup.kind === 'git' ? `the git repo in your vault (${cfg.vault?.path ?? 'vault folder'}/.git) and any remote it was pushed to` : 'none are set up'
  print(`  3. Backups: ${where}`)
  print('  4. The plugin itself: remove it in Claude Code with /plugin. If you installed the command line, also run: npm uninstall -g thenwise')
  const old = legacyDir(memDir)
  if (old) print(`  5. An older data folder that still holds Thenwise data: ${old}`)
  if (existsSync(join(memDir, 'team.json'))) print('  6. Team: notes you shared stay on the team server. Run `thenwise unshare <note>` for each one first, or ask the server owner to delete them.')
  print("  7. Lines setup added to .gitignore files, if a git repo contained your data folder or vault: look for the data folder name and _thenwise/.")
  print('Not deleted and out of reach: Claude Code\'s own chat files, git history of a backed-up vault, iCloud or Time Machine versions, and copies your teammates pulled.')

  return 0
}
