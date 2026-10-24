// What the user told Thenwise to forget. Archive checks it for every chat it finds in Claude Code's own files,
// so a forgotten chat does not come back on the next sync. Stored in <data folder>/forgotten.json (mode 0600).

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normPath } from '../core/vault-index.ts'

export interface Tombs {
  sessions: string[] // session ids
  projects: string[] // Claude Code project keys
  folders: string[] // project folders (normalized)
}

const file = (memDir: string) => join(memDir, 'forgotten.json')

export function loadTombs(memDir: string): Tombs {
  try {
    return { sessions: [], projects: [], folders: [], ...JSON.parse(readFileSync(file(memDir), 'utf8')) }
  } catch {
    return { sessions: [], projects: [], folders: [] }
  }
}

export function saveTombs(memDir: string, t: Tombs) {
  const uniq = (l: string[]) => [...new Set(l)].sort()
  writeFileSync(`${file(memDir)}.tmp`, JSON.stringify({ sessions: uniq(t.sessions), projects: uniq(t.projects), folders: uniq(t.folders) }, null, 1), { mode: 0o600 })
  renameSync(`${file(memDir)}.tmp`, file(memDir))
  chmodSync(file(memDir), 0o600)
}

/** The session id of an archive path `<project>/<session>.jsonl` or `<project>/<session>/subagents/<x>.jsonl`. */
export const sessionOf = (rel: string) => (rel.split('/')[1] ?? '').replace(/\.jsonl$/, '')

export const underFolder = (path: string, folder: string) => {
  const p = normPath(path)
  const f = normPath(folder)

  return !!f && (p === f || p.startsWith(`${f}/`))
}

export function isForgotten(t: Tombs, rel: string, cwd = ''): boolean {
  return t.projects.includes(rel.split('/')[0]!) || t.sessions.includes(sessionOf(rel)) || (!!cwd && t.folders.some((f) => underFolder(cwd, f)))
}
