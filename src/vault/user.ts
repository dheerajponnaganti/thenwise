// Rules for the notes people write in a vault: Thenwise reads them and never changes them.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { parseFrontMatter } from '../core/frontmatter.ts'
import { walk } from '../ingest/parts.ts'

export const OURS = '_thenwise'
const COPY = /^(.+) (\d+)\.md$/

const readOrEmpty = (f: string) => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
/** Near-identical: at least 80% of the distinct non-empty lines are shared. */
function similar(a: string, b: string): boolean {
  const la = new Set(a.split('\n').map((l) => l.trim()).filter(Boolean))
  const lb = new Set(b.split('\n').map((l) => l.trim()).filter(Boolean))
  const both = [...la].filter((l) => lb.has(l)).length

  return la.size + lb.size === 0 || both / (la.size + lb.size - both) >= 0.8
}

/** Why a user note is not read, or '' when it is read. `rel` is relative to the vault. */
export function skipReason(file: string, rel: string, raw?: string): string {
  if (rel === OURS || rel.startsWith(`${OURS}/`)) return 'generated'
  const m = COPY.exec(basename(file))
  raw ??= readFileSync(file, 'utf8')
  // iCloud's "name 2.md" is a copy only when "name.md" exists and says nearly the same ("Part 2" next to "Part" is its own note).
  if (m && Number(m[2]) >= 2 && existsSync(join(dirname(file), `${m[1]}.md`)) && similar(raw, readOrEmpty(join(dirname(file), `${m[1]}.md`)))) return 'conflict copy'
  const fm = parseFrontMatter(raw)

  return fm.issues.some((i) => /no closing/.test(i)) ? 'broken front matter' : ''
}

/** Every user note that is skipped, as "<reason>: <path>". */
export function skippedNotes(vaults: string[]): string[] {
  const out: string[] = []
  for (const v of new Set(vaults)) {
    const files: string[] = []
    walk(v, (n) => n.endsWith('.md'), files)
    for (const f of files) {
      const why = skipReason(f, f.slice(v.length + 1))
      if (why && why !== 'generated') out.push(`${why}: ${f}`)
    }
  }

  return out
}
