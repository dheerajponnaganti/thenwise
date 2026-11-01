#!/usr/bin/env node
// Plugin users install from the release branch and run its committed dist/, never a fresh build, and npm provenance does
// not cover them. This proves that dist/ is exactly what the public source builds to.
//   node scripts/check-plugin-build.mjs --self                     HEAD's source builds to the same bytes twice
//   node scripts/check-plugin-build.mjs --release <ref> --tag <t>  <ref> ships <t>'s source, and its dist/ is that source built
// Git runs in the current directory; TypeScript comes from this repo's node_modules. Exits 1 and lists each problem.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
// What decides how the plugin behaves. Docs and images may differ between main and the release branch.
export const SHIPPED = ['src', 'hooks', 'commands', 'skills', '.claude-plugin', '.mcp.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']

const git = (args, env = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28 }).trim()

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

function checkRelease(ref, tag, tmp) {
  const changed = git(['diff', '--name-only', tag, ref, '--', ...SHIPPED]).split('\n').filter(Boolean)
  if (changed.length) return changed.map((f) => `${f} differs between ${tag} and ${ref}`)
  const source = extract(ref, tmp)
  build(source, join(tmp, 'rebuilt'))

  return compare(join(source, 'dist'), join(tmp, 'rebuilt'), `${ref} dist`, 'the rebuild')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const [ref, tag] = [value('--release'), value('--tag')]
  if (!args.includes('--self') && !(ref && tag)) {
    console.error('usage: check-plugin-build.mjs --self | --release <ref> --tag <tag>')
    process.exit(2)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'thenwise-build-'))
  let problems
  try {
    problems = args.includes('--self') ? checkSelf(tmp) : checkRelease(ref, tag, tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (problems.length) {
    console.error(`plugin build check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log('plugin build check: dist/ is exactly what the source builds to')
}
