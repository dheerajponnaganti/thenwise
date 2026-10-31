#!/usr/bin/env node
// One version everywhere, and with --tag, equal to the tag. Manifests can all go stale together and still agree, so a
// release also compares them with what is being released.
//   node scripts/check-versions.mjs [--tag v0.1.25]
// Exits 1 and lists each problem.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The problems in the checkout at `root`, as sentences. */
export function checkVersions(root, tag) {
  const json = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'))
  const problems = []
  const { version } = json('package.json')
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) problems.push(`package.json version must be X.Y.Z, got ${version}`)
  const lock = json('package-lock.json')
  if (lock.version !== version) problems.push(`package-lock.json version ${lock.version} differs from package.json ${version}`)
  if (lock.packages?.['']?.version !== version) problems.push(`package-lock.json root package version ${lock.packages?.['']?.version} differs from package.json ${version}`)
  const plugin = json('.claude-plugin/plugin.json')
  if (plugin.version !== version) problems.push(`plugin.json version ${plugin.version} differs from package.json ${version}`)
  // A marketplace entry that carried a version would silently lose to plugin.json.
  for (const entry of json('.claude-plugin/marketplace.json').plugins ?? []) {
    if ('version' in entry) problems.push('marketplace.json carries a version; plugin.json is the single source')
  }
  if (!readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`\n## ${version}\n`)) problems.push(`CHANGELOG.md has no "## ${version}" section`)
  if (tag !== undefined && tag !== `v${version}`) problems.push(`tag ${tag} does not match version ${version}`)

  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--tag')
  const problems = checkVersions(resolve(fileURLToPath(import.meta.url), '../..'), at === -1 ? undefined : process.argv[at + 1])
  if (problems.length) {
    console.error(`version check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log('version check: one version everywhere')
}
