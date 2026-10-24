// An in-memory IO for tests: files are a map; every write bumps a clock so mtimes change.

import type { DirEntry, IO } from '../src/core/io.ts'

export class MemIO implements IO {
  files = new Map<string, { text: string; mtimeMs: number }>()
  /** Paths that exist but cannot be read (a cloud placeholder). */
  unreadable = new Set<string>()
  writes: string[] = []
  clock = 1_700_000_000_000

  constructor(seed: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(seed)) this.files.set(p, { text: t, mtimeMs: this.clock++ })
  }

  async readText(path: string): Promise<string | null> {
    if (this.unreadable.has(path)) return null

    return this.files.get(path)?.text ?? null
  }

  async writeText(path: string, text: string): Promise<void> {
    this.writes.push(path)
    this.files.set(path, { text, mtimeMs: ++this.clock })
  }

  async list(dir: string): Promise<DirEntry[]> {
    const prefix = dir.replace(/\/+$/, '') + '/'
    const out = new Map<string, DirEntry>()
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const [head, ...more] = rest.split('/')
      if (!head) continue
      if (more.length > 0) out.set(head, { name: head, kind: 'dir', size: 0, mtimeMs: 0 })
      else out.set(head, { name: head, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs })
    }
    if (out.size === 0 && ![...this.files.keys()].some(p => p.startsWith(prefix))) throw new Error(`ENOENT ${dir}`)

    return [...out.values()]
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  now(): number {
    return this.clock
  }
}
