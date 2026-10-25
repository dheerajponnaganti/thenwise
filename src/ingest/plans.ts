// planning-with-files plans (task_plan.md, findings.md, progress.md) get overwritten by the next task. Every version is
// kept, masked, under <data folder>/archive/plans/<project key>/<slug or root>/<stem>/<time>.md, and ingest turns each
// snapshot into a dated `plan` record.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { maskSecrets } from '../core/secrets.ts'
import { isForgotten, loadTombs } from '../privacy/tombstones.ts'
import { globMatch, isOff } from './config.ts'
import type { Config } from './config.ts'
import { fullNode } from './parts.ts'
import type { Part } from './parts.ts'

export const STEMS = ['task_plan', 'findings', 'progress']
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
/** The Claude Code project key of a folder, the same one the chat archive uses. */
export const keyOf = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, '-')
const plansDir = (cfg: Config) => join(cfg.memDir, 'archive', 'plans')
const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [])

/** Which project, plan and stem a path is, or null when it is no plan file. */
function planOf(file: string): { dir: string; slug: string; stem: string } | null {
  const stem = basename(file, '.md')
  if (!STEMS.includes(stem) || !file.endsWith('.md')) return null
  const up = dirname(file)
  if (basename(dirname(up)) === '.planning') return { dir: dirname(dirname(up)), slug: basename(up).replace(/[^\w.-]/g, '-'), stem }

  return { dir: up, slug: 'root', stem }
}

/** Saves the current content of one plan file unless it equals the newest snapshot. True when a snapshot was written. */
export function snapshotPlan(cfg: Config, file: string, now = new Date()): boolean {
  const p = planOf(file)
  if (!cfg.plans || !p || !existsSync(file)) return false
  const key = keyOf(p.dir)
  if (isOff(cfg, p.dir) || cfg.excludeProjects.some((g) => globMatch(g, key)) || isForgotten(loadTombs(cfg.memDir), `${key}/x`, p.dir)) return false
  const text = maskSecrets(readFileSync(file, 'utf8')).text
  if (!text.trim()) return false
  const dest = join(plansDir(cfg), key, p.slug, p.stem)
  const last = existsSync(dest) ? readdirSync(dest).filter((x) => x.endsWith('.md')).sort().pop() : undefined
  if (last && sha(readFileSync(join(dest, last), 'utf8')) === sha(text)) return false
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  // Compare resolved paths: a data folder written with a trailing slash must not walk this up to `/`.
  for (let d = resolve(dest), top = resolve(cfg.memDir); d.startsWith(top + sep); d = dirname(d)) chmodSync(d, 0o700)
  // Forget finds a project's folders by this marker, since the key cannot be turned back into a path.
  writeFileSync(join(plansDir(cfg), key, '.folder'), p.dir, { mode: 0o600 })
  const name = join(dest, `${now.toISOString().replace(/[:.]/g, '-')}.md`)
  writeFileSync(`${name}.tmp`, text, { mode: 0o600 })
  renameSync(`${name}.tmp`, name)

  return true
}

/** The hook's entry: a Write or Edit is about to change a plan file, so keep what it holds now. */
export const snapshotBefore = (cfg: Config, file: string, cwd: string) => snapshotPlan(cfg, isAbsolute(file) ? file : resolve(cwd, file))

/** Snapshots the plan files in each root and the folders directly inside it. shortcut: two levels only, deeper projects need their own root. */
export function snapshotAll(cfg: Config): number {
  if (!cfg.plans) return 0
  let n = 0
  const one = (d: string) => {
    for (const stem of STEMS) if (snapshotPlan(cfg, join(d, `${stem}.md`))) n++
    const pl = join(d, '.planning')
    for (const slug of dirs(pl)) for (const stem of STEMS) if (snapshotPlan(cfg, join(pl, slug, `${stem}.md`))) n++
  }
  for (const root of cfg.roots) {
    one(root)
    for (const sub of dirs(root)) if (!sub.startsWith('.') && sub !== 'node_modules') one(join(root, sub))
  }

  return n
}

const when = (name: string) => name.replace(/\.md$/, '').replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)$/, '$1:$2:$3.$4')

/** One `plan` record per snapshot, dated by the snapshot. */
export function plansPart(cfg: Config, until?: string): Part {
  const out: Part = { nodes: [], edges: [] }
  if (!cfg.plans) return out
  for (const key of dirs(plansDir(cfg))) {
    if (cfg.ingestExcludeProjects.some((g) => globMatch(g, key))) continue
    for (const slug of dirs(join(plansDir(cfg), key)))
      for (const stem of dirs(join(plansDir(cfg), key, slug)))
        for (const f of readdirSync(join(plansDir(cfg), key, slug, stem)).filter((x) => x.endsWith('.md')).sort()) {
          const at = when(f)
          if (Number.isNaN(Date.parse(at)) || (until && Date.parse(at) > Date.parse(until))) continue
          const path = join(plansDir(cfg), key, slug, stem, f)
          const text = readFileSync(path, 'utf8')
          const heading = /^#+\s+(.+)$/m.exec(text)?.[1]?.trim()
          out.nodes.push(fullNode({ id: `plan:${key}/${slug}/${stem}@${at}`, kind: 'plan', title: `${stem} (${at.slice(0, 10)} ${at.slice(11, 16)})${heading ? ` ${heading}` : ''}`, text, at, project: key, source: path, extra: { plan: slug, stem } }))
        }
  }

  return out
}
