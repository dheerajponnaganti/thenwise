// On Windows every child process without windowsHide opens its own console window: hooks start several per turn, and the
// detached sync's window stays until the sync ends. Every process Thenwise starts must hide its window.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []))
const CALL = /\b(spawnSync|spawn|execFileSync|execSync|execFile)\(/

test('every process Thenwise starts hides its window on Windows (blank Node terminals kept opening)', () => {
  const missing: string[] = []
  for (const f of files('src')) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (!CALL.test(l) || l.trimStart().startsWith('//') || /import\s/.test(l)) return
      // The options sit on the same line, or in an `opts` object defined just above it.
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
      if (!/windowsHide: true/.test(near)) missing.push(`${f}:${i + 1}`)
    })
  }
  assert.deepEqual(missing, [])
})
