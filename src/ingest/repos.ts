// Which git repositories a person's chats worked in, found from the chats' working folders. Read only: files are
// looked at and `git config` is read, nothing is written and no network is used.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** The main repository folder that holds `dir`. A linked worktree maps to its main repo (what `--git-common-dir` gives). */
export function repoRoot(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const dot = join(d, '.git')
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isDirectory()) return d
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]?.trim()
        if (!gitdir) return d
        const common = join(resolve(d, gitdir), 'commondir')
        if (!existsSync(common)) return d // a submodule: its own repo
        const main = resolve(resolve(d, gitdir), readFileSync(common, 'utf8').trim())

        return basename(main) === '.git' ? dirname(main) : main
      } catch {
        return undefined
      }
    }
    if (dirname(d) === d) return undefined
  }
}

export const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The folder a project is known by: its repository (or the folder itself), as a real path, so two spellings compare equal. */
export const projectRoot = (dir: string) => real(repoRoot(dir) ?? resolve(dir))

/** The configured repos first, then the repos of the given working folders, each once, in a stable order. */
export function discoverRepos(configured: string[], cwds: Iterable<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (r: string) => seen.has(real(r)) || (seen.add(real(r)), out.push(r))
  for (const r of configured) add(r)
  // One lookup per folder (chats repeat the same few), and at most 200 repos found this way.
  const roots = new Map<string, string | undefined>()
  for (const c of new Set([...cwds].filter(Boolean))) roots.set(c, repoRoot(c))
  for (const r of [...new Set([...roots.values()].filter((r): r is string => !!r))].sort().slice(0, 200)) add(r)

  return out
}

/** `owner/name` of the repo's GitHub remote: origin when it is on GitHub, else the first GitHub remote. None without a remote. */
export function githubSlug(repo: string): string | undefined {
  let out = ''
  try {
    out = execFileSync('git', ['-C', repo, 'config', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
  const remotes = out.split('\n').filter(Boolean).map((l) => {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(l)
    const s = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(m?.[2] ?? '')

    return { name: m?.[1] ?? '', slug: s ? `${s[1]}/${s[2]}` : '' }
  }).filter((r) => r.slug)

  return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.slug
}
