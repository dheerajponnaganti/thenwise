// What the background sync is doing, for the person: first sync, a rebuild or an automatic one, which phase, and how far it
// got. Only the sync writes <data folder>/sync-progress.json; status, the hooks and the memory tools read it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SyncKind = 'first' | 'rebuild' | 'auto'
export interface Progress {
  kind: SyncKind
  phase: string // 'copying chats', 'building the store', 'team sync', or 'done'
  done: number // chats handled in this phase
  total: number
  started: string
  updated: string
  pid: number
  finished?: string
  chats?: number // chats in the memory when it finished
  ms?: number
  failed?: boolean // the ingest step failed or never ran: the store may be missing chats
}

export const progressFile = (dir: string) => join(dir, 'sync-progress.json')

export function readProgress(dir: string): Progress | null {
  try {
    return JSON.parse(readFileSync(progressFile(dir), 'utf8')) as Progress
  } catch {
    return null
  }
}

/** Merges fields into the file, through a temp file and a rename, so a reader never sees half of it. Only the sync
 * process and its steps call it, one at a time, so no merge loses another's fields. */
export function writeProgress(dir: string, p: Partial<Progress>, replace = false) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const next = { ...(replace ? {} : readProgress(dir)), ...p, updated: new Date().toISOString() }
    const tmp = `${progressFile(dir)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    renameSync(tmp, progressFile(dir))
  } catch {} // progress is a courtesy: it never fails a sync
}

// When the person was last shown a line about a sync. Hooks write it from any session, so it has its own file.
const toldFile = (dir: string) => join(dir, 'sync-told')
export function readTold(dir: string): string {
  try {
    return readFileSync(toldFile(dir), 'utf8').trim()
  } catch {
    return (readProgress(dir) as { told?: string } | null)?.told ?? '' // older versions kept it in the progress file
  }
}
export function writeTold(dir: string, iso: string) {
  try {
    writeFileSync(toldFile(dir), iso, { mode: 0o600 })
  } catch {} // the worst case is one repeated line
}

/** A callback for a phase's loop that writes at most every half second, and always the last step. Null when no sync asked. */
export function reporter(dir: string, phase: string): ((done: number, total: number) => void) | null {
  if (!process.env.THENWISE_PROGRESS) return null
  let last = 0

  return (done, total) => {
    const now = Date.now()
    if (done < total && now - last < 500) return
    last = now
    writeProgress(dir, { phase, done, total })
  }
}

// Copying chats is the first half of a sync, building the store the second.
const WEIGHT: Record<string, [number, number]> = { 'copying chats': [0, 50], 'building the store': [50, 50] }

/** The whole sync's share done, 0 to 100. */
export function percent(p: Progress): number {
  if (p.finished) return 100
  const [from, span] = WEIGHT[p.phase] ?? [p.phase === 'team sync' ? 50 : 0, 0]

  return Math.min(99, Math.floor(from + (p.total ? (span * p.done) / p.total : 0)))
}

/** Whether a process lives. EPERM means it does, under another user. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** True while a sync is running: started, not finished, and its process still alive. */
export const running = (p: Progress | null): p is Progress => !!p && !p.finished && alive(p.pid)

const n = (x: number) => x.toLocaleString('en-US')
const secs = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
const NAME: Record<SyncKind, string> = { first: 'first sync', rebuild: 'rebuild after an update', auto: 'sync' }

/** One line for the person, or '' when there is nothing worth saying. */
export function progressLine(p: Progress | null, now = Date.now()): string {
  if (!p) return ''
  if (p.finished && p.failed) return `${NAME[p.kind]} failed; /thenwise:logs shows why`
  if (p.finished) return `${NAME[p.kind]} done${p.chats ? `: ${n(p.chats)} chats remembered` : ''}${p.ms ? ` in ${secs(p.ms)}` : ''}`
  if (!running(p)) return ''
  const what = p.total ? `${p.phase}, ${n(p.done)} of ${n(p.total)} chats` : p.phase

  return `${NAME[p.kind]} ${percent(p)}% (${what}), started ${secs(now - Date.parse(p.started))} ago`
}

/** For answers given while the first sync or a rebuild runs: the memory is incomplete, and the agent should say so. */
export function incompleteNote(dir: string): string {
  const p = readProgress(dir)
  if (!running(p) || p.kind === 'auto') return ''

  return `Note: Thenwise's ${NAME[p.kind]} is ${percent(p)}% done, so older chats may be missing from these results. Say so rather than claiming something was never recorded.`
}

export const hasStore = (dir: string) => existsSync(join(dir, 'graph.db'))
