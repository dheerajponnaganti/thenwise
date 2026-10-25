// Finds the projects in Claude Code's history. A folder name under ~/.claude/projects is a lossy mangling of the
// real path (dots, underscores, spaces and slashes all become "-"), so the real folder comes from the `cwd` field.

import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'

export interface FoundProject {
  key: string
  chats: number
  /** The most common working folder in the chats, or null when no chat names one. */
  folder: string | null
  /** Other working folders that map to the same key. */
  clash: string[]
}

function headCwd(file: string): string | null {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(32768)
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    for (const line of text.split('\n')) {
      const m = /"cwd":\s*("(?:[^"\\]|\\.)*")/.exec(line)
      if (m) return JSON.parse(m[1]!)
    }
  } catch {
    // unreadable: the next file may name a folder
  } finally {
    closeSync(fd)
  }

  return null
}

/** Reads the head of up to `sample` chats per project; counts every top-level chat. */
/** Projects in the chat history that the config's roots leave out and no exclude rule names: they are silently out of scope. */
export function newProjectLines(claudeDir: string, roots: string[], excluded: (key: string) => boolean): string[] {
  const out = discoverProjects(claudeDir).filter((p) => p.folder && !excluded(p.key) && !roots.some((r) => p.folder === r || p.folder!.startsWith(`${r}/`)))

  return out.length ? [`not remembered yet: ${out.map((p) => p.folder).join(', ')}. Run \`thenwise setup\` to add ${out.length === 1 ? 'it' : 'them'}.`] : []
}

export function discoverProjects(claudeDir: string, sample = 20): FoundProject[] {
  const root = join(claudeDir, 'projects')
  if (!existsSync(root)) return []
  const out: FoundProject[] = []
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue
    const files = readdirSync(join(root, e.name)).filter((f) => f.endsWith('.jsonl')).sort()
    if (!files.length) continue
    const seen = new Map<string, number>()
    for (const f of files.slice(0, sample)) {
      const cwd = headCwd(join(root, e.name, f))
      // The disk root is no project: as a root it would put every chat in scope.
      if (cwd && !/^([a-zA-Z]:)?[\\/]?$/.test(cwd)) seen.set(cwd, (seen.get(cwd) ?? 0) + 1)
    }
    const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p)
    out.push({ key: e.name, chats: files.length, folder: ranked[0] ?? null, clash: ranked.slice(1) })
  }

  return out
}
