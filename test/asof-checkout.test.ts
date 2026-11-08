import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Graph } from '../src/query/engine.ts'
import { checkout, checkoutDir, cleanCheckouts } from '../src/query/checkout.ts'
import { git, World } from './world.ts'

const dirOf = (out: string) => out.split('\n').find((l) => l.includes('checkouts/'))!.trim()

test('asof --checkout puts the code of a date in its own folder, lists that day\'s chats, and --clean removes it', () => {
  const w = new World()
  try {
    const one = w.commit(w.proj, 'src/b.ts', 'B one', '', '2026-10-10T08:00:00Z')
    const two = w.commit(w.proj, 'src/b.ts', 'B two', '', '2026-10-20T08:00:00Z')
    // A post-checkout hook (husky, lefthook) must not run from a search command.
    mkdirSync(join(w.proj, '.git/hooks'), { recursive: true })
    writeFileSync(join(w.proj, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch "${join(w.home, 'hook-ran')}"\n`)
    chmodSync(join(w.proj, '.git/hooks/post-checkout'), 0o755)
    w.chat('s1', { turns: [{ prompt: 'zebra work on b', at: '2026-10-12T10:00:00Z' }] })
    w.chat('s2', { turns: [{ prompt: 'later quokka work', at: '2026-10-25T10:00:00Z' }] })
    w.archive()
    const g = new Graph(w.ingest('a.db').db)

    const out = checkout(g, '2026-10-12', w.memDir)
    const dir = dirOf(out)
    assert.ok(dir.endsWith(`proj-${one.slice(0, 12)}`))
    assert.match(readFileSync(join(dir, 'src/b.ts'), 'utf8'), /^B one/, 'the folder holds the code of that date')
    assert.match(readFileSync(join(w.proj, 'src/b.ts'), 'utf8'), /^B two/, "the user's working tree is not touched")
    assert.ok(!existsSync(join(w.home, 'hook-ran')), 'no git hook ran')
    assert.match(out, /chats on 2026-10-12 \(1\)[\s\S]*zebra work on b/)
    assert.ok(!out.includes('quokka'), 'a chat of another day is not listed')
    assert.equal(checkout(g, '2026-10-12', w.memDir), out, 'a second run reuses the folder')
    assert.equal(dirOf(checkout(g, '2026-10-15', w.memDir)), dir, 'another date on the same commit reuses it too')
    assert.match(checkout(g, '2026-09-01', w.memDir), /no commit on or before 2026-09-01 is recorded/)
    assert.match(checkout(g, 'soon', w.memDir), /needs an ISO date/)

    // A checkout someone changed is kept, and the line says how to drop it from any folder.
    const other = dirOf(checkout(g, '2026-10-21', w.memDir))
    assert.ok(other.endsWith(two.slice(0, 12)))
    writeFileSync(join(other, 'src/b.ts'), 'edited here\n')
    writeFileSync(join(checkoutDir(w.memDir), '.DS_Store'), '') // a stray file is not a checkout
    const cleaned = cleanCheckouts(w.memDir)
    assert.match(cleaned, new RegExp(`removed .*${one.slice(0, 12)}`))
    const drop = new RegExp(`kept .*${two.slice(0, 12)}.*: git --git-dir="([^"]+)" worktree remove --force`).exec(cleaned)
    assert.ok(drop, cleaned)
    assert.ok(!existsSync(dir) && existsSync(other))
    assert.equal(git(w.proj, 'worktree', 'list').split('\n').length, 2, 'git forgets the removed worktree')
    git(w.home, `--git-dir=${drop[1]}`, 'worktree', 'remove', '--force', other) // the printed command works from any folder
    assert.equal(cleanCheckouts(w.memDir), 'no checkouts to remove')
    assert.ok(!existsSync(checkoutDir(w.memDir)), 'the checkouts folder goes too, stray files and all')
  } finally {
    w.destroy()
  }
})

test('#74: asof with a date that does not parse is an input error: exit 2, the message on stderr, nothing on stdout', () => {
  const w = new World()
  try {
    w.commit(w.proj, 'src/b.ts', 'B one', '', '2026-10-10T08:00:00Z')
    w.archive()
    w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
    const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), ...a], { cwd: w.proj, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    for (const args of [['asof', 'soon', '--checkout'], ['asof', 'soon', 'quokka']]) {
      const r = cli(...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /asof needs an ISO date .*got "soon"/)
      assert.equal(r.stdout, '')
    }
    assert.ok(!existsSync(checkoutDir(w.memDir)), 'no checkout is made')
    assert.equal(cli('asof', '2026-10-12', '--checkout').status, 0, 'a good date still works')
  } finally {
    w.destroy()
  }
})
