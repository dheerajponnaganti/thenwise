#!/usr/bin/env node
// Refuses owner data and eval data before anything is pushed or shipped.
//   node scripts/scan-owner.mjs                 every file git tracks or would add (not ignored)
//   node scripts/scan-owner.mjs --staged        only the staged files (a pre-push or pre-commit hook)
//   node scripts/scan-owner.mjs --dir <folder>  every file in a folder (a tarball or a release tree)
//   node scripts/scan-owner.mjs --text          a pull request title and description, from stdin
//   node scripts/scan-owner.mjs --title         checks a pull request title's form, from stdin
// Exits 1 and lists each hit. Imported by test/release.test.ts (R-B4).

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const SELF = 'scripts/scan-owner.mjs'

// Paths and names that only exist on the owner's machine or in his private notes.
export const OWNER = [/\/Users\/dheeraj/i, /\/home\/dheeraj/i, /carapace-private/i, /carapace-crew/i, /\.memory\/eval/, /claude mods/i, /iCloud~md~obsidian/]
// The author's name is fine as the public GitHub handle in a repo URL, and in files that credit the author.
export const NAME = /dheeraj|ponnaganti/i
const HANDLE = /(github\.com\/|raw\.githubusercontent\.com\/|cdn\.jsdelivr\.net\/gh\/|^|[\s("'`<[@])dheerajponnaganti(\/[\w.-]+)?/gim
export const NAME_OK = new Set(['LICENSE', 'package.json', 'package-lock.json', 'CHANGELOG.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'])

// Eval data never enters the repo: question sets, answers, gold sets, chat archives and stores.
const DATA = [/(^|\/)answers[^/]*\.jsonl/i, /(^|\/)questions[^/]*\.jsonl/i, /(^|\/)gold[^/]*\.jsonl/i, /\.jsonl\.gz$/i, /(^|\/)graph[^/]*\.db$/i]
const DATA_OK = /^fixtures\// // synthetic test data
// bench/out holds measured numbers only; a new file there must be added here on purpose.
const BENCH_OUT_OK = new Set(['manifest-fixture.txt', 'perf-10000.json', 'perf-2000.json', 'phase0-sqlite.json', 'phase0-sqlite.md', 'phase0.json', 'phase0.md', 'phase2-l1.json', 'phase2-l1.md', 'phase3.json', 'phase4-expand.json'])

// The eval tooling under bench/ runs only on the owner's machine and names Thenwise's own old data folder (~/.memory/eval).
const SCOPED_OK = [{ re: /\.memory\/eval/, under: 'bench/' }]
// shortcut: these eval scripts default to the owner's eval workspace and list his plugins to switch off; move both to
// THENWISE_EVAL_ROOT and a local file before the next eval, then delete these entries.
const KNOWN = { 'bench/real/guard.ts': ['carapace-crew', 'name'], 'bench/real/run.ts': ['carapace-crew', 'name'], 'bench/e2e/e5_small.py': ['carapace-crew', 'name'] }

/** The hits for one file, as "path: reason" lines. `rel` uses forward slashes. */
export function scanFile(rel, text) {
  const hits = []
  if (DATA.some((re) => re.test(rel)) && !DATA_OK.test(rel)) hits.push(`${rel}: eval or chat data does not belong in the repo`)
  if (rel.startsWith('bench/out/') && !BENCH_OUT_OK.has(rel.slice('bench/out/'.length))) hits.push(`${rel}: new file in bench/out (add it to BENCH_OUT_OK in ${SELF} if it holds numbers only)`)
  if (rel === SELF || rel.endsWith(`/${SELF}`)) return hits
  const known = KNOWN[rel] ?? []
  for (const re of OWNER) {
    if (!re.test(text) || SCOPED_OK.some((s) => s.re.source === re.source && rel.startsWith(s.under)) || known.some((k) => re.test(k))) continue
    hits.push(`${rel}: matches ${re}`)
  }
  if (!known.includes('name') && !NAME_OK.has(rel.replace(/^package\//, '')) && NAME.test(text.replace(HANDLE, ''))) hits.push(`${rel}: names the author outside a repo URL`)

  return hits
}

// What a commit message or pull request must not say: these are public for good. Stricter than files, since a message
// has no reason to name a machine, a private worktree or an email address, and commits carry no AI attribution.
const MESSAGE = [/\bworktree\b/i, /\btw-[a-z]/i, /(^|[\s(`'"])~\//m, /\/Users\//, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, /co-authored-by/i, /generated (with|by) /i, /claude-session/i, /claude\.ai\/code/i]

// Pull request titles become the commit subjects on main: type(area): what changed.
export const TITLE = /^(fix|feat|docs|test|ci|chore|refactor|perf)(\([a-z-]+\))?!?: \S.*$/

/** The hits for a commit message or a pull request title and description. */
export function scanMessage(text) {
  const hits = [...OWNER, ...MESSAGE].filter((re) => re.test(text)).map((re) => `message matches ${re}`)
  if (NAME.test(text.replace(HANDLE, ''))) hits.push('message names the author outside a repo URL')

  return hits
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
}

/** Scans a list of absolute files, relative to `base`. */
export function scanFiles(files, base) {
  const hits = []
  for (const full of files) {
    const rel = relative(base, full).replace(/\\/g, '/')
    let text = ''
    try {
      if (statSync(full).size < 64 << 20) text = readFileSync(full, 'latin1') // binary files are read as bytes; names still match
    } catch {
      continue // a staged delete or a vanished file
    }
    hits.push(...scanFile(rel, text))
  }

  return hits
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--title')) {
    if (TITLE.test(readFileSync(0, 'utf8').trim())) process.exit(0)
    console.error('Pull request titles look like: fix(hooks): keep the store open. Types: fix, feat, docs, test, ci, chore, refactor, perf.')
    process.exit(1)
  }
  if (args.includes('--text')) {
    const hits = scanMessage(readFileSync(0, 'utf8'))
    if (hits.length) {
      console.error(hits.join('\n'))
      process.exit(1)
    }
    console.log('owner-data scan: text clean')
    process.exit(0)
  }
  const dirAt = args.indexOf('--dir')
  let base = ROOT
  let files
  if (dirAt !== -1) {
    base = resolve(args[dirAt + 1] ?? '.')
    files = walk(base)
  } else if (args.includes('--staged')) files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).map((f) => join(ROOT, f))
  else files = git(['ls-files', '--cached', '--others', '--exclude-standard']).map((f) => join(ROOT, f))
  const hits = scanFiles(files, base)
  if (hits.length) {
    console.error(`owner-data scan: ${hits.length} problem${hits.length === 1 ? '' : 's'}\n${hits.map((h) => `  ${h}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`owner-data scan: ${files.length} files clean`)
}
