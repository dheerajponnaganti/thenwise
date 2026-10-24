// The IO port for Node hosts (CLI, benchmark, server).

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DirEntry, IO } from '../core/io.ts'

export const nodeIO: IO = {
  async readText(path) {
    return readFile(path, 'utf8').catch(() => null)
  },
  async writeText(path, text) {
    await mkdir(dirname(path), { recursive: true })
    // Temp file then rename: a crash never leaves a half-written note.
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  },
  async list(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    const out: DirEntry[] = []
    for (const e of entries) {
      if (!e.isFile() && !e.isDirectory()) continue
      const s = await stat(join(dir, e.name)).catch(() => null)
      if (s) out.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: s.size, mtimeMs: s.mtimeMs })
    }

    return out
  },
  async exists(path) {
    return access(path).then(
      () => true,
      () => false,
    )
  },
  now: () => Date.now(),
  run: (argv, opts) =>
    new Promise(resolve => {
      const [cmd, ...args] = argv
      execFile(cmd!, args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
        resolve({ exitCode: code, stdout: stdout ?? '' })
      })
    }),
}
