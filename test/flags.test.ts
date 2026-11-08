import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './mcp-fixture.ts'

test('#76: a flag given with no value is an input error, not the default', () => {
  const home = tempDir()
  mkdirSync(join(home, '.thenwise'), { recursive: true })
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), ...a], { cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, THENWISE_HOME: join(home, '.thenwise') } })
  for (const [args, name] of [[['status', '--db'], 'db'], [['distill', '--since', '--dry-run'], 'since'], [['search', 'cache', '--project'], 'project']] as const) {
    const r = cli(...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.stderr.trim(), `--${name} needs a value`)
  }
  assert.match(cli('status', '--db', join(home, 'none.db')).stdout, /no store at/, 'a flag with its value still works')
})
