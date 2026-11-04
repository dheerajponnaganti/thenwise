#!/usr/bin/env node
// Plugin users install the committed plugin/ folder and run its dist/, never a fresh build, and npm provenance does not
// cover them. This proves that plugin/ is exactly what the public source builds to.
//   node scripts/check-plugin-build.mjs --self            HEAD's source builds to the same bytes twice
//   node scripts/check-plugin-build.mjs --folder --tag <t>  <t>'s plugin/ is its own source, built
//   node scripts/check-plugin-build.mjs --pr <base>         a pull request that changes plugin/ bumps the version, and its
//                                                           plugin/ is its source, built. Merging to main publishes plugin/.
// Git runs in the current directory; TypeScript comes from this repo's node_modules. Exits 1 and lists each problem.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assemble } from './plugin-folder.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
// Bytes as committed: a checkout must not turn LF into CRLF, or a true build would look changed.
const git = (args, env = {}) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28 }).trim()

function extract(ref, dir) {
  const env = { GIT_INDEX_FILE: join(dir, '.index') }
  git(['read-tree', ref], env)
  git(['checkout-index', '-a', `--prefix=${join(dir, 'tree')}/`], env)
  rmSync(env.GIT_INDEX_FILE, { force: true })

  return join(dir, 'tree')
}

function tsc(source, out) {
  execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(source, 'tsconfig.build.json'), '--outDir', out], { stdio: 'inherit' })
}

function build(source, out) {
  symlinkSync(join(ROOT, 'node_modules'), join(source, 'node_modules'), 'junction')
  tsc(source, out)
}

function files(dir) {
  const out = new Map()
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(relative(dir, join(e.parentPath, e.name)).replace(/\\/g, '/'), readFileSync(join(e.parentPath, e.name)))
  }

  return out
}

/** The files that differ between two folders, as sentences. */
export function compare(a, b, nameA, nameB) {
  const [left, right] = [files(a), files(b)]
  const problems = []
  for (const [f, bytes] of left) {
    if (!right.has(f)) problems.push(`${f} is in ${nameA} but not ${nameB}`)
    else if (!bytes.equals(right.get(f))) problems.push(`${f} differs between ${nameA} and ${nameB}`)
  }
  for (const f of right.keys()) if (!left.has(f)) problems.push(`${f} is in ${nameB} but not ${nameA}`)
  if (!left.size && !right.size) problems.push(`${nameA} and ${nameB} are both empty`)

  return problems
}

function checkSelf(tmp) {
  const source = extract('HEAD', tmp)
  build(source, join(tmp, 'one'))
  tsc(source, join(tmp, 'two'))

  return compare(join(tmp, 'one'), join(tmp, 'two'), 'the first build', 'the second build')
}

function checkFolder(tag, tmp) {
  const source = extract(tag, tmp)
  if (!existsSync(join(source, 'plugin'))) return [`${tag} has no plugin/ folder: run npm run plugin:folder and commit it`]
  build(source, join(tmp, 'rebuilt'))
  assemble(source, join(tmp, 'rebuilt'), join(tmp, 'expected'))

  return compare(join(source, 'plugin'), join(tmp, 'expected'), `${tag} plugin/`, 'its source, built')
}

// Every tool installs plugin/ from main, so a merge publishes it: prove it before the merge, not only at the tag.
function checkPullRequest(base, tmp) {
  if (!git(['diff', '--name-only', base, 'HEAD', '--', 'plugin'])) return []
  const version = (ref) => JSON.parse(git(['show', `${ref}:package.json`])).version
  if (version(base) === version('HEAD')) return [`plugin/ changed but the version is still ${version('HEAD')}: only a release pull request may change plugin/`]

  return checkFolder('HEAD', tmp)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const [tag, base] = [value('--tag'), value('--pr')]
  if (!args.includes('--self') && !(args.includes('--folder') && tag) && !base) {
    console.error('usage: check-plugin-build.mjs --self | --folder --tag <tag> | --pr <base>')
    process.exit(2)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'thenwise-build-'))
  let problems
  try {
    problems = args.includes('--self') ? checkSelf(tmp) : base ? checkPullRequest(base, tmp) : checkFolder(tag, tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (problems.length) {
    console.error(`plugin build check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`plugin build check: ${args.includes('--self') ? 'dist/ builds the same twice' : base && !git(['diff', '--name-only', base, 'HEAD', '--', 'plugin']) ? 'plugin/ unchanged' : 'plugin/ is exactly what the source builds to'}`)
}
