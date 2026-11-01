#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, for the GitHub release notes. Exits 1 if it has none.
//   node scripts/changelog-section.mjs [version]     version defaults to the one in package.json

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The text under `## <version>`, up to the next `## ` heading, or null. */
export function section(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.indexOf(`## ${version}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  const text = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

  return text || null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..')
  const version = process.argv[2] ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  const text = section(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version)
  if (!text) {
    console.error(`CHANGELOG.md has no text under "## ${version}"`)
    process.exit(1)
  }
  console.log(text)
}
