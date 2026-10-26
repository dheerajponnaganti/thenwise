// `thenwise status`: what the store holds, when it was updated, and what ingest could not use. Read only.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Config } from './config.ts'
import type { ManifestEntry } from './archive.ts'
import { prStatus } from './prs.ts'
import { skippedDocs } from './parts.ts'
import { teamStatus } from '../teams/client.ts'

export function statusLines(cfg: Config, dbPath: string): string[] {
  if (!existsSync(dbPath)) return [`no store at ${dbPath}: run \`thenwise ingest\``]
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const all = (sql: string) => db.prepare(sql).all() as any[]
  const out = [`store ${dbPath}, ${(statSync(dbPath).size / 1e6).toFixed(1)} MB, updated ${statSync(dbPath).mtime.toISOString()}`]
  out.push(`nodes: ${all('SELECT kind, count(*) n FROM nodes GROUP BY kind ORDER BY kind').map((r) => `${r.kind} ${r.n}`).join(', ')}`)
  const meta = Object.fromEntries(all('SELECT * FROM meta').map((r) => [r.key, r.value]))
  out.push(`chats: ${meta.sessions_in_scope} in scope, ${meta.sessions_out_of_scope} out of scope, ${meta.excluded_eval_projects} test chats left out, ${meta.excluded_entrypoint} not interactive`)

  const manifestFile = join(cfg.memDir, 'archive/manifest.json')
  if (existsSync(manifestFile)) {
    const man = Object.values(JSON.parse(readFileSync(manifestFile, 'utf8'))) as ManifestEntry[]
    const bad = man.reduce((n, e) => n + e.unparsed.length, 0)
    const open = man.filter((e) => e.pending).length
    out.push(`archive: ${man.length} chat files; ${bad} lines did not parse and were skipped${open ? `; ${open} chats end in a half-written line, read on the next run` : ''}`)
  }
  const repos: string[] = JSON.parse((all("SELECT value FROM ingest_state WHERE key = 'repos'")[0]?.value as string | undefined) ?? '[]')
  out.push(`git: ${repos.length ? repos.join(', ') : 'no repository found in the chats working folders'}`)
  out.push(...prStatus(cfg, repos))
  out.push(...teamStatus(cfg.memDir))
  const skipped = skippedDocs(cfg)
  if (skipped.length) out.push(`CLAUDE.md files not read (more than one folder below a root): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}. Add one with "docs" under "ingest" in config.json.`)

  // A project folder that was moved or renamed no longer exists: its old chats keep their old project name.
  const gone = new Map<string, number>()
  for (const r of all("SELECT json_extract(extra, '$.cwd') cwd, count(*) n FROM nodes WHERE kind = 'session' GROUP BY cwd")) if (r.cwd && !existsSync(r.cwd)) gone.set(r.cwd, r.n)
  for (const [cwd, n] of gone) out.push(`project folder gone: ${cwd} (${n} chats). If it was moved or renamed, those chats stay under the old name.`)
  db.close()

  return out
}
