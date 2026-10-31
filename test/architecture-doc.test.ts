import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const doc = readFileSync('ARCHITECTURE.md', 'utf8')
// Each table row: | `src/x/y.ts` | `a`, `b` | what it does |
const rows = [...doc.matchAll(/^\| `(src\/[\w/.-]+\.ts)` \| (.+?) \| .+ \|$/gm)].map((m) => ({ file: m[1]!, symbols: [...m[2]!.matchAll(/`(\w+)`/g)].map((s) => s[1]!) }))

test('ARCHITECTURE.md: every file and entry point it names exists and is exported', () => {
  assert.ok(rows.length > 20, 'the module table was found')
  for (const { file, symbols } of rows) {
    assert.ok(existsSync(file), `${file} does not exist`)
    assert.ok(symbols.length > 0, `${file} names no entry point`)
    const text = readFileSync(file, 'utf8')
    for (const s of symbols) assert.match(text, new RegExp(`^export (async )?(function|const|class) ${s}\\b`, 'm'), `${file} does not export ${s}`)
  }
})

test('ARCHITECTURE.md: every src folder is in the module table', () => {
  const listed = new Set(rows.map((r) => r.file.split('/')[1]))
  for (const e of readdirSync('src', { withFileTypes: true })) if (e.isDirectory()) assert.ok(listed.has(e.name), `src/${e.name} is not in ARCHITECTURE.md`)
})

test('ARCHITECTURE.md: the hooks it lists are the hooks the plugin registers', () => {
  const hooks = Object.keys(JSON.parse(readFileSync('hooks/hooks.json', 'utf8')).hooks as object)
  for (const h of hooks) assert.ok(doc.includes(`\`${h}\``), `${h} is not in ARCHITECTURE.md`)
})
