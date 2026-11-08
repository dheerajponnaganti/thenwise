import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { proposeExpiry } from '../src/capture/expire.ts'
import { accept, readNotes, reject } from '../src/capture/notes.ts'
import { projectKey } from '../src/ingest/copilot.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { World } from './world.ts'

const at = (min: number) => new Date(Date.now() + min * 60e3).toISOString()
const exp = (w: World) => readNotes(w.memDir).filter((n) => n.id.startsWith('exp-'))

test('a Decision: trailer whose files a later commit changes asks in the inbox whether it still holds, once per change', () => {
  const w = new World() // its first commit says "Decision: keep a tiny" and adds src/a.ts
  try {
    const db = w.path('a.db')
    w.commit(w.proj, 'src/z.ts', 'Unrelated file', '', at(1))
    w.ingest('a.db')
    assert.equal(proposeExpiry(w.memDir, db), 0, 'nothing changed the decision\'s file yet')

    const sha = w.commit(w.proj, 'src/a.ts', 'Grow a into a module', '', at(2))
    w.ingest('a.db')
    assert.equal(proposeExpiry(w.memDir, db), 1)
    const q = exp(w)[0]!
    assert.equal(q.type, 'finding')
    assert.equal(q.status, 'inbox')
    assert.equal(q.title, 'Changed since decided: keep a tiny')
    assert.ok(q.summary.includes(`Commit ${sha.slice(0, 7)} "Grow a into a module"`) && q.summary.includes('changed src/a.ts'), q.summary)
    assert.equal(q.supersedes, '', 'a trailer nobody accepted closes nothing')

    assert.equal(proposeExpiry(w.memDir, db), 0, 'a second run adds nothing')
    w.commit(w.proj, 'src/a.ts', 'Grow a again', '', at(3))
    w.ingest('a.db')
    assert.equal(proposeExpiry(w.memDir, db), 0, 'one open question per decision while it waits in the inbox')
    reject(w.memDir, [q.id])
    assert.equal(proposeExpiry(w.memDir, db), 1, 'after a reject, a newer change asks again')
  } finally {
    w.destroy()
  }
})

test('decide records the files named and the files its own chat edited; the decision shows in their history, and a later change asks to supersede it', () => {
  const w = new World()
  try {
    const proj = realpathSync(w.proj)
    // The agent's own chat, written just now, edited src/c.ts.
    w.chat('own', { turns: [{ prompt: 'shard the cache', edits: [join(proj, 'src/c.ts')], at: new Date().toISOString() }], cwd: proj }, projectKey(proj))
    const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir, CLAUDECODE: '1' }
    const r = spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'decide', 'use eight shards', '--file', 'src/b.ts'], { cwd: proj, encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /About 2 files: b\.ts, c\.ts\./)
    const note = readNotes(w.memDir).find((n) => n.title === 'use eight shards')!
    assert.deepEqual(note.files, [join(proj, 'src/b.ts'), join(proj, 'src/c.ts')].map((p) => p.replace(/\\/g, '/')).sort())
    assert.ok(!note.summary.includes('src/b.ts'), 'the --file value is not part of the text')

    w.archive()
    w.ingest('graph.db', { db: join(w.memDir, 'graph.db') })
    const g = new Graph(join(w.memDir, 'graph.db'))
    assert.match(c.trace(g, join(proj, 'src/b.ts')), /use eight shards/, 'the decision is in the file\'s history')

    w.commit(w.proj, 'src/b.ts', 'Go back to one shard', '', at(5))
    w.ingest('graph.db', { db: join(w.memDir, 'graph.db') })
    assert.equal(proposeExpiry(w.memDir, join(w.memDir, 'graph.db')), 1)
    const q = exp(w)[0]!
    assert.equal(q.supersedes, note.id)
    accept(w.memDir, { ids: [q.id] }, at(60))
    const closed = readNotes(w.memDir).find((n) => n.id === note.id)!
    assert.equal(closed.status, 'superseded', 'accepting closes the decision')
    // It stopped holding when the commit changed its file, not when the question was answered an hour later.
    assert.equal(closed.valid_to, q.valid_from)
    assert.equal(readNotes(w.memDir).find((n) => n.id === q.id)!.valid_from, q.valid_from, 'the accepted note keeps its date')
  } finally {
    w.destroy()
  }
})

test('decide with a bare --file is an input error that saves nothing; a --file that does not exist is kept and said', () => {
  const w = new World()
  try {
    const proj = realpathSync(w.proj)
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir }
    delete env.CLAUDECODE
    delete env.COPILOT_CLI
    const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), ...a], { cwd: proj, encoding: 'utf8', env })
    for (const args of [['decide', 'keep the parser pure', '--file'], ['deadend', 'a lock deadlocks', '--file', '--here']]) {
      const r = cli(...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /--file needs a path/)
    }
    assert.equal(readNotes(w.memDir).length, readNotes(w.memDir).filter((n) => n.id.startsWith('tr-')).length, 'nothing was saved')

    const typo = cli('decide', 'use eight shards', '--file', 'src/cahce.ts')
    assert.equal(typo.status, 0)
    assert.match(typo.stdout, /Not found on disk, kept as given: src\/cahce\.ts\. Check the path/)
    assert.ok(readNotes(w.memDir).find((n) => n.title === 'use eight shards')!.files![0]!.endsWith('src/cahce.ts'))
    const real = cli('decide', 'keep a small', '--file', 'src/a.ts')
    assert.equal(real.status, 0)
    assert.ok(!real.stdout.includes('Not found'), 'an existing file gets no warning')
  } finally {
    w.destroy()
  }
})

test('decide keeps only the chat\'s recent edits, and the commit its own chat made later is no change to it', () => {
  const w = new World({ roots: [realpathSync(tmpdir())] }) // the chat runs in the real path of the temp folder
  try {
    const proj = realpathSync(w.proj)
    const db = join(w.memDir, 'graph.db')
    // The chat edited src/old.ts two hours ago, then src/c.ts just now, and lands the decision with a commit after it.
    const sha = w.commit(w.proj, 'src/c.ts', 'Shard the cache', '', at(2))
    w.chat('own', { turns: [
      { prompt: 'tidy the old module', edits: [join(proj, 'src/old.ts')], at: at(-120) },
      { prompt: 'shard the cache', edits: [join(proj, 'src/c.ts')], commit: { subject: 'Shard the cache', sha }, at: new Date().toISOString() },
    ], cwd: proj }, projectKey(proj))
    w.archive()
    w.ingest('graph.db', { db })
    const env = { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir, CLAUDECODE: '1' }
    const r = spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'decide', 'use eight shards'], { cwd: proj, encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    const note = readNotes(w.memDir).find((n) => n.title === 'use eight shards')!
    assert.deepEqual(note.files, [join(proj, 'src/c.ts').replace(/\\/g, '/')], 'an edit from two hours ago is other work')
    assert.ok(note.sources[0]?.startsWith('ses:'), JSON.stringify(note) + r.stdout)
    w.ingest('graph.db', { db })
    assert.equal(proposeExpiry(w.memDir, db), 0, 'the chat\'s own commit lands the decision')
    w.commit(w.proj, 'src/c.ts', 'Go back to one shard', '', at(5))
    w.ingest('graph.db', { db })
    assert.equal(proposeExpiry(w.memDir, db), 1, 'a later commit by other work asks')
  } finally {
    w.destroy()
  }
})
