#!/usr/bin/env node
// Run by .githooks/pre-push. Refuses a push that carries private history, owner data, or a commit message that should
// not be public. Git gives one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { scanFile, scanMessage } from './scan-owner.mjs'

const ZERO = /^0+$/
const REMOTE = process.argv[2] || 'origin'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim()
const attempt = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const lines = (s) => (s ? s.split('\n').filter(Boolean) : [])

/** The public branch a push builds on, or null when it does not descend from any of them. */
function baseOf(sha) {
  for (const branch of ['main', 'release']) {
    const base = attempt('rev-parse', '--verify', `refs/remotes/${REMOTE}/${branch}^{commit}`)
    if (base && attempt('merge-base', '--is-ancestor', base, sha) !== null) return base
  }
  return null
}

function check(ref, sha) {
  const commit = git('rev-parse', `${sha}^{commit}`)
  const hits = git('cat-file', '-t', sha) === 'tag' ? scanMessage(git('cat-file', 'tag', sha).split('\n\n').slice(1).join('\n\n')).map((h) => `tag: ${h}`) : []
  const fresh = lines(git('rev-list', commit, '--not', `--remotes=${REMOTE}`))
  if (!fresh.length) return hits
  const base = baseOf(commit)
  if (!base) return [...hits, `${ref} does not start from ${REMOTE}/main or ${REMOTE}/release, so it would publish private history`]
  for (const c of fresh) hits.push(...scanMessage(git('log', '-1', '--format=%B', c)).map((h) => `commit ${c.slice(0, 7)}: ${h}`))
  for (const file of lines(git('diff', '--name-only', '--diff-filter=ACMR', base, commit))) {
    const text = execFileSync('git', ['show', `${commit}:${file}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('latin1')
    hits.push(...scanFile(file, text))
  }

  return hits
}

const hits = []
for (const line of lines(readFileSync(0, 'utf8'))) {
  const [, sha, ref] = line.split(' ')
  if (!ZERO.test(sha)) hits.push(...check(ref, sha))
}
if (hits.length) {
  console.error(`pre-push: refused\n${hits.map((h) => `  ${h}`).join('\n')}`)
  process.exit(1)
}
