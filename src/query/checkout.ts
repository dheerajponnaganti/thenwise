// `thenwise asof <date> --checkout`: each repository's code as it was on a date, in its own folder beside the store, next
// to the chats of that day. A git worktree is a separate folder, so the user's working tree is never touched.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { endOf, Graph, local, localDay } from './engine.ts'
import { newestCommits, shaOf } from './commands.ts'
import { normPath } from '../core/vault-index.ts'

// No hooks (a post-checkout hook may run npm install) and no LFS downloads: a search command makes no network call.
const git = (cwd: string, noHooks: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${noHooks}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } }).trim()
const why = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').pop()

export const checkoutDir = (memDir: string) => join(memDir, 'checkouts')
const noHooks = (memDir: string) => join(checkoutDir(memDir), '.no-hooks') // never created, so git finds no hook there

export function checkout(g: Graph, date: string, memDir: string): string {
  const end = Date.parse(endOf(date))
  if (Number.isNaN(end)) return `asof needs an ISO date or date and time first, such as 2026-10-19 or 2026-10-19T06:50:00Z; got "${date}".`
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDay(date)
  const out = [`asof ${date} --checkout: the code as it was then, in folders of its own (your working tree is not touched); remove them with \`thenwise asof --clean\``]
  const commits = newestCommits(g, end)
  if (!commits.length) out.push(`- no commit on or before ${date} is recorded${g.scope ? ` for ${basename(g.scope)}` : ''}`)
  for (const n of commits) {
    const sha = shaOf(n)
    // One folder per commit: another date that lands on the same commit reuses it.
    const dir = join(checkoutDir(memDir), `${n.project.replace(/[^\w.-]+/g, '-')}-${sha.slice(0, 12)}`)
    try {
      if (!existsSync(dir)) {
        if (!existsSync(n.source)) throw new Error(`the repository ${n.source} is not on this machine`)
        mkdirSync(checkoutDir(memDir), { recursive: true })
        git(n.source, noHooks(memDir), 'worktree', 'add', '--detach', dir, sha)
      }
      out.push(`- ${n.project}: commit ${sha.slice(0, 7)} "${n.title.slice(0, 60)}", ${local(n.at)}\n   ${normPath(dir)}`)
    } catch (e) {
      out.push(`- ${n.project}: commit ${sha.slice(0, 7)} could not be checked out: ${why(e)}`)
    }
  }
  // Chats that were open at some point on that local day, oldest first.
  const ses = g.ofKind('session').filter((s) => g.inScope(s) && !s.extra?.team && localDay(s.at) <= day && localDay(s.until || s.at) >= day).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  out.push(`chats on ${day}${ses.length ? ` (${ses.length}), oldest first; read one with \`thenwise get <id>\`` : ': none recorded'}`)
  for (const s of ses.slice(0, 20)) out.push(`- ${local(s.at)} ${s.extra?.tool ?? 'Claude Code'} ${s.id}: "${s.title.replace(/\s+/g, ' ').trim().slice(0, 100)}"`)
  if (ses.length > 20) out.push(`(${ses.length - 20} more)`)
  return out.join('\n')
}

/** Removes every checkout folder. One with changes made in it is kept, and the line says how to remove it anyway. */
export function cleanCheckouts(memDir: string): string {
  const root = checkoutDir(memDir)
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => !d.startsWith('.')).map((d) => join(root, d)).filter((d) => statSync(d).isDirectory()) : []
  const out: string[] = dirs.length ? [] : ['no checkouts to remove']
  let kept = 0
  for (const dir of dirs) {
    // Find the repository from inside the checkout, then remove it from outside: Windows never deletes the folder a
    // process (here git itself) is running in. The same goes for the command printed for a folder that is kept.
    let repo = ''
    try {
      repo = git(dir, noHooks(memDir), 'rev-parse', '--path-format=absolute', '--git-common-dir')
      git(root, noHooks(memDir), `--git-dir=${repo}`, 'worktree', 'remove', dir)
      out.push(`removed ${normPath(dir)}`)
    } catch (e) {
      kept++
      out.push(`kept ${normPath(dir)}: ${why(e)}; ${repo ? `to drop it with its changes: git --git-dir="${repo}" worktree remove --force "${dir}"` : 'its repository is gone, so delete the folder'}`)
    }
  }
  if (!kept && existsSync(root)) rmSync(root, { recursive: true, force: true }) // only stray files such as .DS_Store are left
  return out.join('\n')
}
