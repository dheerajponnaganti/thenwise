// One holder at a time per lock file. A lock holds its pid, and is stale only when that process is dead or the machine restarted
// since the lock was written. Its age alone never makes it stale: an ingest can run for long, and a laptop can sleep.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'

import { alive } from '../core/progress.ts'

const POLL_MS = 50
// shortcut: the boot time is the wall clock minus uptime, so a clock step over a minute (NTP, a VM resume) can make a live lock look
// older than this boot; store the holder's process start time if double runs show up after such steps.
const BOOT_SLACK_MS = 60_000 // two reads of the boot time differ by clock steps and rounding
const TAKEOVER_MS = 10_000 // a takeover lasts microseconds; one this old was left by a crash

// Locks this process took. A lock that names this process but is not in here was left by a dead process with the same pid.
const taken = new Set<string>()

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const read = (f: string) => ({ text: readFileSync(f, 'utf8'), mtimeMs: statSync(f).mtimeMs })

/** An empty lock is a holder that has not written its pid yet. A lock written before this boot is stale even if its pid lives again. */
function holds({ text, mtimeMs }: { text: string; mtimeMs: number }): boolean {
  const pid = Number(text.trim())
  if (!pid) return Date.now() - mtimeMs < 10_000

  return alive(pid) && mtimeMs > Date.now() - uptime() * 1000 - BOOT_SLACK_MS
}

/** True while a live process of this boot holds the lock. */
export function lockHeld(file: string): boolean {
  try {
    return holds(read(file))
  } catch {
    return false // no lock, or released between the two reads
  }
}

/** True when this process now holds the lock. A stale lock is removed by one taker at a time, the one holding `<lock>.takeover`. */
export function takeLock(file: string, pid = process.pid): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 })
      taken.add(`${pid}:${file}`)

      return true
    } catch (e) {
      // Windows reports a file that is being deleted as EPERM.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && !(code === 'EPERM' && process.platform === 'win32')) throw e
    }
    let seen: ReturnType<typeof read>
    try {
      seen = read(file)
      // A lock naming this very process that it did not take was left by a dead process with our pid, as in a container that
      // restarts with the same pids. One it took is still held: a second take waits like any other.
      const ours = Number(seen.text.trim()) === pid
      if (ours ? taken.has(`${pid}:${file}`) : holds(seen)) return false
    } catch {
      continue // released between our create and our read: try again
    }
    if (!removeStale(file, pid, (now) => now.text === seen.text && now.mtimeMs === seen.mtimeMs)) return false
  }

  return false
}

/** Removes the lock if `still` holds, as the one taker holding `<lock>.takeover`. False when another taker holds it. */
function removeStale(file: string, pid: number, still: (now: ReturnType<typeof read>) => boolean): boolean {
  const takeover = `${file}.takeover`
  try {
    writeFileSync(takeover, String(pid), { flag: 'wx', mode: 0o600 })
  } catch {
    if (Date.now() - (statSync(takeover, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > TAKEOVER_MS) rmSync(takeover, { force: true })

    return false
  }
  try {
    // Only a takeover holder removes a lock it did not write, so the file changed only if its holder released it.
    if (still(read(file))) rmSync(file, { force: true })
  } catch {} // released meanwhile
  rmSync(takeover, { force: true })

  return true
}

/** After a killed child: no `finally` ran, so its lock stays. Removes the lock only while it still names that pid. */
export function dropLock(file: string, pid: number | undefined) {
  if (pid) removeStale(file, process.pid, (now) => Number(now.text.trim()) === pid)
}

/** Runs `run` under `<path>.lock`, waiting up to waitMs for another holder. */
export function withLock<T>(path: string, run: () => T, waitMs = 10 * 60000): T {
  const lock = `${path}.lock`
  const until = Date.now() + waitMs
  while (!takeLock(lock)) {
    if (Date.now() > until) throw new Error(`another ingest holds ${lock}`)
    sleep(POLL_MS)
  }
  try {
    return run()
  } finally {
    rmSync(lock, { force: true })
  }
}
