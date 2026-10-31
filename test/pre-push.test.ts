import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// @ts-expect-error a plain script with no types
import { TITLE, scanMessage } from '../scripts/scan-owner.mjs'

const HOOK = resolve('scripts/pre-push.mjs')
const ZERO = '0'.repeat(40)
// Built here, so this file stays clean under the same scan.
const ME = 'dhe' + 'eraj'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'thenwise-push-'))
  const bare = join(dir, 'bare.git')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '--bare', bare])
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: work, encoding: 'utf8' }).trim()
  const commit = (file: string, text: string, message: string) => {
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, file), text)
    git('add', '.')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  commit('src/a.ts', 'a\n', 'First')
  git('branch', '-M', 'main')
  git('push', '-q', 'origin', 'main')
  const push = (sha: string, ref: string, remoteSha = ZERO) => spawnSync(process.execPath, [HOOK, 'origin'], { cwd: work, encoding: 'utf8', input: `${ref} ${sha} ${ref} ${remoteSha}\n` })

  return { git, commit, push }
}

test('pre-push: a clean branch from the public main passes', () => {
  const r = repo()
  r.git('checkout', '-q', '-b', 'work')
  const sha = r.commit('src/b.ts', 'b\n', 'Add b')
  const out = r.push(sha, 'refs/heads/work')
  assert.equal(out.status, 0, out.stderr)
})

test('pre-push: a branch that does not start from the public branches is private history, and is refused', () => {
  const r = repo()
  r.git('checkout', '-q', '--orphan', 'old')
  const sha = r.commit('src/c.ts', 'c\n', 'Old private work')
  const out = r.push(sha, 'refs/heads/old')
  assert.equal(out.status, 1)
  assert.match(out.stderr, /private history/)
})

test('pre-push: owner data in a pushed file or commit message is refused', () => {
  const r = repo()
  r.git('checkout', '-q', '-b', 'work')
  const file = r.push(r.commit('src/d.ts', `see /Users/${ME}/x\n`, 'Add d'), 'refs/heads/work')
  assert.equal(file.status, 1)
  assert.match(file.stderr, /src\/d\.ts/)
  const r2 = repo()
  r2.git('checkout', '-q', '-b', 'work')
  const message = r2.push(r2.commit('src/e.ts', 'e\n', 'Merged from worktree tw-fix-sync'), 'refs/heads/work')
  assert.equal(message.status, 1)
  assert.match(message.stderr, /commit [0-9a-f]{7}/)
})

test('pre-push: deleting a branch and a tag on commits already public both pass', () => {
  const r = repo()
  assert.equal(r.push(ZERO, 'refs/heads/gone', r.git('rev-parse', 'HEAD')).status, 0)
  r.git('tag', '-a', 'v1.0.0', '-m', 'Thenwise 1.0.0')
  assert.equal(r.push(r.git('rev-parse', 'v1.0.0'), 'refs/tags/v1.0.0').status, 0)
})

test('pull request titles follow type(area): what changed', () => {
  for (const good of ['ci: move to pull requests', 'fix(hooks): keep the store open', 'feat(teams)!: change the share format']) assert.match(good, TITLE)
  for (const bad of ['Move to pull requests', 'fix(Hooks): x', 'fix:no space', 'update: x']) assert.doesNotMatch(bad, TITLE)
})

test('scanMessage: private names, paths, attribution and session links are caught; plain messages pass', () => {
  for (const bad of [`Fix /Users/${ME}/x`, `See ~/cara${'pace'}-crew/tw-fix`, 'From branch tw-fix-sync', 'worktree cleanup', 'Co-Authored-By: Someone <a@b.dev>', 'Generated with Claude Code', 'https://claude.ai/code/session_123', `Thanks ${ME}`, 'a@gmail.com', `Notes in the claude ${'mods'} vault`]) {
    assert.ok(scanMessage(bad).length > 0, bad)
  }
  for (const good of ['Windows: compare project folders with forward slashes', 'Fixes #12: keep the store open', 'See https://github.com/dheerajponnaganti/thenwise/issues/3', 'Claude Code hooks stay silent on old Node']) {
    assert.deepEqual(scanMessage(good), [], good)
  }
})
