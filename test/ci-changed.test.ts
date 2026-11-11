import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

// @ts-expect-error a plain script with no types
import { needsTests } from '../scripts/docs-only.mjs'

const CI = readFileSync('.github/workflows/ci.yml', 'utf8')

test('#106: Markdown that tests read runs the tests; docs-only paths skip them', () => {
  for (const f of ['commands/why.md', 'skills/thenwise/SKILL.md', 'ARCHITECTURE.md', 'README.md', 'CHANGELOG.md', 'LICENSE', 'plugin/commands/why.md', 'src/cli.ts', 'package.json', 'test/notes.md']) {
    assert.equal(needsTests([f]), true, f)
  }
  for (const f of ['docs/teams.md', 'assets/readme/hero.png', 'CONTRIBUTING.md', 'RELEASING.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/pull_request_template.md', 'docker/README.md', 'fixtures/vault-sample/rules/x.md']) {
    assert.equal(needsTests([f]), false, f)
  }
  assert.equal(needsTests(['docs/teams.md', 'src/cli.ts']), true)
  assert.equal(needsTests(['']), false)
  const out = spawnSync(process.execPath, [resolve('scripts/docs-only.mjs')], { input: 'docs/teams.md\nREADME.md\n', encoding: 'utf8' })
  assert.equal(out.stdout.trim(), 'code=true')
  assert.match(CI, /node scripts\/docs-only\.mjs/)
})

test('#106: all-passed needs every other job, so a failed changed job fails the required check', () => {
  const jobs = [...CI.slice(CI.indexOf('\njobs:')).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!).filter((j) => j !== 'all-passed')
  const needs = CI.match(/^ {2}all-passed:\n(?: {4}#.*\n)* {4}needs: \[(.+)\]$/m)?.[1]?.split(/,\s*/)
  assert.ok(jobs.includes('changed'))
  assert.deepEqual(needs?.sort(), jobs.sort())
})
