import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Graph, localDay } from '../src/query/engine.ts'
import { digest } from '../src/query/digest.ts'
import { sinceOf } from '../src/query/engine.ts'
import { buildNotes } from '../src/vault/vault.ts'
import { World } from './world.ts'

function world() {
  const w = new World()
  const sha = w.commit(w.proj, 'src/b.ts', 'Add the b module', '', '2026-10-12T09:59:00Z')
  w.chat('s1', {
    turns: [
      { prompt: 'wire up the zebra module', edits: [join(w.proj, 'src/a.ts'), join(w.proj, 'src/b.ts')], commit: { subject: 'Add the b module', sha }, at: '2026-10-12T10:00:00Z' },
      { prompt: '[dead-end] retries without jitter overload the server', at: '2026-10-12T10:05:00Z' },
    ],
  })
  w.chat('s2', { turns: [{ prompt: 'an older quokka chat', at: '2026-10-01T10:00:00Z' }] })
  w.archive()
  return { w, sha, g: new Graph(w.ingest('a.db').db) }
}

test('digest lists what each chat did since a time, newest first: prompt, edits, commits and dead ends', () => {
  const { w, sha, g } = world()
  try {
    const out = digest(g, Date.parse('2026-10-10T00:00:00Z'))
    assert.match(out, /^digest since .*: 1 chat, newest first/)
    assert.match(out, /Claude Code · proj · ses:s1/)
    assert.match(out, /asked: "wire up the zebra module"/)
    assert.match(out, /edited 2 files: src\/a\.ts, src\/b\.ts/)
    assert.ok(out.includes(`commits: ${sha.slice(0, 7)} "Add the b module"`), out)
    assert.match(out, /dead ends: retries without jitter overload the server/)
    assert.ok(!out.includes('quokka'), 'a chat before the window is left out')
    assert.match(digest(g, Date.parse('2026-10-20T00:00:00Z')), /no chats recorded/)
  } finally {
    w.destroy()
  }
})

test('digest reads 24h, 7d, ISO times and plain local dates for --since', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')
  assert.equal(sinceOf('24h', now), now - 864e5)
  assert.equal(sinceOf('7d', now), now - 7 * 864e5)
  assert.equal(sinceOf('2026-11-01T00:00:00Z', now), Date.parse('2026-11-01T00:00:00Z'))
  assert.ok(Number.isNaN(sinceOf('soon', now)))
  // A plain date starts at local midnight, as asof reads a plain date as the local day's end.
  const start = sinceOf('2026-11-01', now)
  assert.equal(localDay(new Date(start).toISOString()), '2026-11-01')
  assert.equal(localDay(new Date(start - 1).toISOString()), '2026-10-31')
})

test('the vault keeps a Digest note of the last 7 days that names changes but holds no chat text', () => {
  const { w, sha, g } = world()
  try {
    const { notes } = buildNotes(g, w.cfg, 'per-project', Date.parse('2026-10-13T00:00:00Z'))
    const note = [...notes].find(([k]) => k.endsWith('Digest.md'))?.[1] ?? ''
    assert.match(note, /# Digest: .*, the last 7 days/)
    assert.match(note, /Claude Code chat: edited 2 files \(src\/a\.ts, src\/b\.ts\)/)
    assert.ok(note.includes(`commit ${sha.slice(0, 7)} Add the b module`) && note.includes('1 dead end'), note)
    assert.ok(!/zebra|jitter|quokka/.test(note), 'no prompt or dead-end text in the vault')
    assert.ok([...notes.values()].some((t) => t.includes('Digest]] (1)')), 'the index links the digest')
    const later = buildNotes(g, w.cfg, 'per-project', Date.parse('2026-11-30T00:00:00Z')).notes
    assert.ok(![...later.keys()].some((k) => k.endsWith('Digest.md')), 'no digest note when nothing happened in the last 7 days')
  } finally {
    w.destroy()
  }
})

test('digest --since with no value or a bad one is an input error that names the problem, never the 24h default', () => {
  const { w } = world()
  try {
    w.ingest('x.db', { db: join(w.memDir, 'graph.db') })
    const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'digest', ...a], { cwd: w.proj, encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir } })
    for (const [args, msg] of [[['--since'], /^--since needs a value$/m], [['--since', '--here'], /^--since needs a value$/m], [['--since', 'soon'], /--since needs 24h, 7d or a date such as 2026-11-01, found soon$/m]] as const) {
      const r = cli(...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, msg)
      assert.ok(!r.stderr.includes('usage:'), 'one line that names the problem, not the whole usage')
      assert.equal(r.stdout, '')
    }
    const ok = cli('--since', '2026-10-10')
    assert.equal(ok.status, 0)
    assert.match(ok.stdout, /zebra/)
  } finally {
    w.destroy()
  }
})
