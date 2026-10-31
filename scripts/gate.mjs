#!/usr/bin/env node
// The merge gate, the same steps CI runs: npm run gate. Stops at the first failure.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const STEPS = [
  ['type check', 'npm', ['run', 'check']],
  ['build', 'npm', ['run', 'build']],
  ['tests', 'npm', ['test']],
  ['package', process.execPath, ['scripts/pack-check.mjs']],
  ['hooks', process.execPath, ['scripts/hooks-check.mjs']],
  ['owner-data scan', process.execPath, ['scripts/scan-owner.mjs']],
]

for (const [label, cmd, args] of STEPS) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
  if (r.status !== 0) {
    console.error(`\ngate: ${label} failed (exit ${r.status}). Fix it and run npm run gate again.`)
    process.exit(1)
  }
  console.log(`gate: ${label} passed in ${((Date.now() - t) / 1000).toFixed(1)} s`)
}
console.log('gate: all passed')
