#!/usr/bin/env node
// Runs CI on a branch without publishing its history: pushes one snapshot commit of HEAD's tree as ci/<name>.
//   node scripts/ci-push.mjs [name]          name defaults to the current branch
//   node scripts/ci-push.mjs --delete [name] removes ci/<name> from GitHub after the release
// The snapshot's only parent is the public main, so local commit messages (which name private branches and paths) never
// leave the machine. Uncommitted changes are not in the snapshot. The owner-data scan runs first.

import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const args = process.argv.slice(2)
const del = args.includes('--delete')
const name = args.find((a) => !a.startsWith('--')) ?? git('branch', '--show-current')
if (!/^[\w.-]+$/.test(name)) {
  console.error(`ci-push: "${name}" is not a plain branch name`)
  process.exit(2)
}
const ref = `refs/heads/ci/${name}`

if (del) {
  git('push', 'origin', `:${ref}`)
  console.log(`ci-push: deleted ci/${name}`)
  process.exit(0)
}

if (git('status', '--porcelain', '--untracked-files=no')) console.log('ci-push: note, uncommitted changes are not in the snapshot')
if (spawnSync(process.execPath, ['scripts/scan-owner.mjs'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
  console.error('ci-push: owner-data scan failed; nothing pushed')
  process.exit(1)
}
git('fetch', '--quiet', 'origin', 'main') // a fetch, never a pull: local main is not touched
const parent = git('rev-parse', 'origin/main')
const short = git('rev-parse', '--short', 'HEAD')
const snapshot = git('commit-tree', 'HEAD^{tree}', '-p', parent, '-m', `CI snapshot of ${name} at ${short}`)
git('push', '--force', 'origin', `${snapshot}:${ref}`)
console.log(`ci-push: ci/${name} is ${snapshot.slice(0, 7)} (tree of ${short}). Watch it with: gh run watch $(gh run list --branch ci/${name} --limit 1 --json databaseId --jq '.[0].databaseId')`)
