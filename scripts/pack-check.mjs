#!/usr/bin/env node
// Checks what npm would publish and what the plugin manifests say, without publishing. Needs `npm run build` first.
//   node scripts/pack-check.mjs
// Exits 1 and lists each problem.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const MAX_BYTES = 300_000 // packed size; 0.1.23 packs to about 187 kB
const json = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
const problems = []

const pkg = json('package.json')
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }))[0]
for (const { path } of packed.files) {
  const ok = path === 'package.json' || path === 'README.md' || path === 'LICENSE' || (path.startsWith('dist/') && path.endsWith('.js'))
  if (!ok) problems.push(`npm package holds ${path} (only dist/**/*.js, package.json, README.md, LICENSE ship)`)
}
if (!packed.files.some((f) => f.path === 'dist/cli.js')) problems.push('npm package has no dist/cli.js: run npm run build first')
if (packed.size > MAX_BYTES) problems.push(`npm package is ${packed.size} bytes, over ${MAX_BYTES}`)
// No runtime dependencies is a promise in the README and the whole supply-chain story.
if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push(`package.json has runtime dependencies: ${Object.keys(pkg.dependencies).join(', ')}`)

const cli = join(ROOT, 'dist/cli.js')
const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
if (version.status !== 0 || version.stdout.trim() !== pkg.version) problems.push(`thenwise --version printed "${version.stdout.trim()}" (exit ${version.status}), expected ${pkg.version}`)
const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
if (help.status !== 0 || !/usage/i.test(help.stdout)) problems.push(`thenwise --help exited ${help.status} or printed no usage`)

// Plugins install from this entry. check-versions.mjs covers the version numbers.
const plugin = json('.claude-plugin/plugin.json')
const market = json('.claude-plugin/marketplace.json')
const entry = market.plugins?.find((p) => p.name === plugin.name)
if (!entry) problems.push(`marketplace.json has no entry named ${plugin.name}`)
else if (entry.source?.ref !== 'release') problems.push(`marketplace.json source ref is ${entry.source?.ref}, expected release`)

if (problems.length) {
  console.error(`pack check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`pack check: ${packed.files.length} files, ${packed.size} bytes, version ${pkg.version}`)
