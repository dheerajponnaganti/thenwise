// One ingest at a time per store. A second one waits for the first, then runs (and finds little to do).

import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

const STALE_MS = 30 * 60000 // a lock this old belongs to a crashed run
const POLL_MS = 50

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function withLock<T>(path: string, run: () => T, waitMs = 10 * 60000): T {
  const lock = `${path}.lock`
  const until = Date.now() + waitMs
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      writeFileSync(lock, String(process.pid))
      break
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      let stale = false
      try {
        const pid = Number(readFileSync(lock, 'utf8'))
        stale = (pid > 0 && !alive(pid)) || Date.now() - statSync(lock).mtimeMs > STALE_MS
      } catch {
        stale = false // released between the two reads: try again
      }
      if (stale) rmSync(lock, { force: true })
      else if (Date.now() > until) throw new Error(`another ingest holds ${lock}`)
      else sleep(POLL_MS)
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { force: true })
  }
}
