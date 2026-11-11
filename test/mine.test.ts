import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { mineRules } from '../src/capture/mine.ts'
import { readNotes, reject, saveNote } from '../src/capture/notes.ts'
import type { CNote } from '../src/capture/notes.ts'
import { runHook, syncRun } from '../src/hooks/hook.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'
import { World } from './world.ts'

test('rule mining proposes a file where real dead ends keep happening, and a [dead-end] line written twice; never a reply sentence', () => {
  const w = new World()
  try {
    // Three reverts of src/a.ts: three commits, each its own dead end.
    for (const i of [1, 2, 3]) {
      w.commit(w.proj, 'src/a.ts', `Try cache layout ${i}`)
      w.commit(w.proj, 'src/a.ts', `Revert "Try cache layout ${i}"`)
    }
    // Three chats edit src/x.ts with a reply that only says it did not work: sentences, not evidence. No rule.
    for (const i of [1, 2, 3]) w.chat(`p${i}`, { turns: [{ prompt: `tune the parser ${i}`, reply: 'That did not work, so I reverted it.', edits: [join(w.proj, 'src/x.ts')] }] })
    // The person wrote the same dead end in two chats.
    w.chat('m1', { turns: [{ prompt: '[dead-end] a global lock around the exporter deadlocks under load' }] })
    w.chat('m2', { turns: [{ prompt: '[dead-end] A global lock around the exporter deadlocks under load.' }] })
    w.archive()
    const db = w.path('a.db')
    w.ingest('a.db')

    assert.equal(mineRules(w.memDir, db), 2)
    const rules = readNotes(w.memDir).filter((n) => n.type === 'rule')
    const file = rules.find((n) => n.title.startsWith('Dead ends keep happening at'))!
    assert.match(file.title, /a\.ts$/)
    assert.match(file.summary, /^3 chats or commits hit a dead end after changing .*a\.ts/)
    assert.equal(file.status, 'inbox')
    assert.equal(file.sources.length, 3)
    // The evidence keeps one line per dead end, in the note and in `thenwise inbox`.
    assert.equal(file.summary.split('\n').filter((l) => l.startsWith('- ')).length, 3)
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir }
    const inbox = spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'inbox'], { encoding: 'utf8', env }).stdout
    assert.match(inbox, /may save the next one\.\n   - \d{4}-\d{2}-\d{2} revert: Revert/)
    // A summary edited by hand in the front matter wins over the body.
    writeFileSync(file.path, readFileSync(file.path, 'utf8').replace(/^summary: .*$/m, 'summary: edited by hand'))
    assert.equal(readNotes(w.memDir).find((n) => n.id === file.id)!.summary, 'edited by hand')
    assert.ok(!rules.some((n) => /x\.ts/.test(n.title)), 'reply sentences never make a rule')
    const line = rules.find((n) => n.title.startsWith('Repeated dead end:'))!
    assert.match(line.summary, /written in 2 chats/)

    assert.equal(mineRules(w.memDir, db), 0, 'the same evidence never proposes twice')
    reject(w.memDir, [file.id])
    assert.equal(mineRules(w.memDir, db), 0)
    assert.equal(readNotes(w.memDir).find((n) => n.id === file.id)!.status, 'rejected', 'a rejected proposal stays rejected')
  } finally {
    w.destroy()
  }
})

test('the sync mines only after an ingest that changed the store', () => {
  const dir = tempDir()
  const cli = join(dir, 'fake-cli.mjs')
  writeFileSync(cli, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(dir, 'calls'))}, process.argv.slice(2).join(' ') + '\\n')\nif (process.argv[2] === 'ingest') console.log(process.env.FAKE_INGEST ?? 'nothing new: 0 chat files read in 0.0 s')\n`)
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
  const home = process.env.THENWISE_HOME
  process.env.THENWISE_HOME = dir
  try {
    syncRun({ dir, cli })
    assert.ok(!calls().includes('mine'), 'nothing new: no mining')
    writeFileSync(join(dir, 'calls'), '')
    process.env.FAKE_INGEST = 'updated: 1 chat files read in 0.1 s'
    syncRun({ dir, cli })
    const c = calls()
    assert.ok(c.indexOf('mine') === c.indexOf('ingest') + 1, 'a changed ingest is mined right after')
  } finally {
    delete process.env.FAKE_INGEST
    if (home === undefined) delete process.env.THENWISE_HOME
    else process.env.THENWISE_HOME = home
  }
})

test('#110: unreviewed inbox notes expire after 14 days without distill; rejected ones stay rejected; status counts what is left', () => {
  const dir = tempDir()
  const db = writeGraph(dir)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, THENWISE_HOME: dir }
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), ...a], { encoding: 'utf8', env })
  const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString()
  const note = (id: string, status: CNote['status'], created: string) => saveNote(dir, { id, type: 'rule', title: `Rule ${id}`, summary: 's', status, valid_from: '', valid_to: '', supersedes: '', sources: [], created, project: '', path: '' })
  note('mine-old', 'inbox', ago(15))
  note('exp-old', 'inbox', ago(20)) // a decision recheck the sync wrote
  note('mine-no', 'rejected', ago(15))
  note('mine-new', 'inbox', ago(1))
  const home = process.env.THENWISE_HOME
  process.env.THENWISE_HOME = dir
  try {
    // Status counts only the notes that have not expired, before any command has run.
    assert.match(runHook('status', {}, { dir, cli: 'none' }), /^inbox +1 proposed note waits, the oldest expires in 13 days; \/thenwise:inbox$/m)
  } finally {
    if (home === undefined) delete process.env.THENWISE_HOME
    else process.env.THENWISE_HOME = home
  }
  // `mine` is what the sync runs with capture.auto off: it expires them.
  const r = cli('mine', '--db', db)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^expired 2 unreviewed inbox note\(s\) older than 14 days$/m)
  const st = () => Object.fromEntries(readNotes(dir).map((n) => [n.id, n.status]))
  assert.deepEqual(st(), { 'mine-old': 'expired', 'exp-old': 'expired', 'mine-no': 'rejected', 'mine-new': 'inbox' })
  // The inbox command expires before it lists, and accept still takes an expired note.
  saveNote(dir, { ...readNotes(dir).find((n) => n.id === 'mine-new')!, created: ago(15) })
  assert.match(cli('inbox').stdout, /^0 note\(s\) in the inbox$/m)
  assert.match(cli('accept', 'mine-old').stdout, /^mine-old: accepted/m)
  assert.deepEqual(st(), { 'mine-old': 'active', 'exp-old': 'expired', 'mine-no': 'rejected', 'mine-new': 'expired' })
})

test('rule mining skips churn files and dead ends that changed many files at once', () => {
  const w = new World()
  try {
    // Every commit updates the changelog: three reverts of src/b.ts name it too, but it is churn.
    for (const i of [1, 2, 3]) {
      w.commit(w.proj, 'CHANGELOG.md', `Note ${i}`)
      writeFileSync(join(w.proj, 'CHANGELOG.md'), `try ${i}\n`)
      w.commit(w.proj, 'src/b.ts', `Try queue layout ${i}`)
      writeFileSync(join(w.proj, 'CHANGELOG.md'), `revert ${i}\n`)
      w.commit(w.proj, 'src/b.ts', `Revert "Try queue layout ${i}"`)
    }
    for (const i of [4, 5, 6, 7]) w.commit(w.proj, 'CHANGELOG.md', `Note ${i}`)
    // Three reverts that each changed seven files: too wide to blame any one of them.
    for (const i of [1, 2, 3]) {
      mkdirSync(join(w.proj, 'wide'), { recursive: true })
      for (const f of [1, 2, 3, 4, 5, 6]) writeFileSync(join(w.proj, `wide/f${f}.ts`), `${i}\n`)
      w.commit(w.proj, 'wide/f0.ts', `Revert "Release ${i}"`)
    }
    w.archive()
    w.ingest('a.db')
    mineRules(w.memDir, w.path('a.db'))
    const titles = readNotes(w.memDir).filter((n) => n.type === 'rule').map((n) => n.title)
    assert.deepEqual(titles.filter((t) => t.startsWith('Dead ends keep happening at')).map((t) => t.split(' ').pop()), ['src/b.ts'])
  } finally {
    w.destroy()
  }
})
