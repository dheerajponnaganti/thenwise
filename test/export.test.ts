import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { openChatCache, putChat, readChats } from '../src/teams/chatcache.ts'
import { previewShare } from '../src/teams/chats.ts'
import { readExport, removeImported } from '../src/teams/export.ts'
import { World } from './world.ts'

const cli = (w: World, ...args: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir }, input: '' })

/** A sender with one chat to export, one [no-memory] chat, and a subagent result that must never travel. */
function sender() {
  const w = new World()
  w.chat('c1', { turns: [{ prompt: 'Why does the exporter drop shards?', reply: `Because the quokka exporter flushes eight shards. See ${w.proj}/src/a.ts.`, reads: [`${w.proj}/src/a.ts`, '/etc/hosts'], edits: [`${w.proj}/src/b.ts`], agent: 'SUBAGENT-TOOL-OUTPUT-xyz' }], cwd: w.proj })
  w.chat('c2', { turns: [{ prompt: '[no-memory] my private wombat question', reply: 'private wombat answer' }], cwd: w.proj })
  w.archive()
  return w
}

test('export writes what the preview counts, and only after a yes; import brings it into another memory as chats of the sender', () => {
  const a = sender()
  const b = new World()
  try {
    const file = join(a.home, 'proj.thenwise')
    const no = cli(a, 'export', a.proj, '--out', file, '--name', 'ana')
    assert.equal(no.status, 1, no.stderr)
    assert.match(no.stdout, /export: this writes the prompts and replies of your chats in proj to .*, for anyone you give it to[\s\S]*never sent: .*chats marked \[no-memory\][\s\S]*chats of ana[\s\S]*not exported/)
    assert.ok(!existsSync(file), 'nothing is written without a yes')

    const yes = cli(a, 'export', a.proj, '--out', file, '--name', 'ana', '--yes')
    assert.equal(yes.status, 0, yes.stderr)
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
    const chats = readExport(file)
    const pv = previewShare(a.cfg, a.proj)
    assert.equal(chats.length, pv.chats)
    assert.equal(chats.reduce((n, x) => n + x.turns.reduce((m, t) => m + t.passages.length, 0), 0), pv.passages, 'the file holds what the preview counted')
    assert.deepEqual(chats.map((x) => [x.owner, x.session]), [['ana', 'c1']], 'the [no-memory] chat stays home')
    const raw = readFileSync(file).toString('latin1')
    for (const bad of [a.home, a.proj, 'SUBAGENT-TOOL-OUTPUT', 'wombat', '/etc/hosts']) assert.ok(!raw.includes(bad), `the file holds ${bad}`)
    assert.ok(raw.includes('src/a.ts'), 'paths are kept relative to the repo')
    assert.equal(cli(a, 'export', a.proj, '--out', file, '--yes').status, 2, 'an existing file is never overwritten')

    const imp = cli(b, 'import', file, '--yes')
    assert.equal(imp.status, 0, imp.stderr)
    assert.match(imp.stdout, /1 chat of ana in proj[\s\S]*"chat of ana \(imported\)"[\s\S]*import --remove ana/)
    b.archive()
    const g = new Graph(b.ingest('graph.db').db)
    const answer = c.why(g, 'exporter drop shards')
    assert.match(answer, /chat of ana \(imported\)/, 'an import is labelled as one')
    assert.ok(!answer.includes('(team)'), 'an import is not the team')
  } finally {
    a.destroy()
    b.destroy()
  }
})

test('import refuses a file that is not an export or a chat with an absolute path, masks what it stores, and never touches synced chats', () => {
  const a = sender()
  try {
    const file = join(a.home, 'good.thenwise')
    assert.equal(cli(a, 'export', a.proj, '--out', file, '--name', 'ana', '--yes').status, 0)
    const bad = join(a.home, 'bad.thenwise')
    copyFileSync(file, bad)
    const db = new DatabaseSync(bad)
    db.prepare(`UPDATE passages SET paths = '["/etc/passwd"]' WHERE n = 0`).run()
    db.close()
    assert.throws(() => readExport(bad), /relative to the repo/)
    const text = join(a.home, 'notes.txt')
    writeFileSync(text, 'hello')
    assert.throws(() => readExport(text), /not a Thenwise export/)
    assert.equal(cli(a, 'import', text, '--yes').status, 1)

    // A secret in a hand-made or older file is masked before anything is stored.
    const leaky = join(a.home, 'leaky.thenwise')
    copyFileSync(file, leaky)
    const ldb = new DatabaseSync(leaky)
    ldb.prepare(`UPDATE passages SET text = 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here' WHERE n = 0`).run()
    ldb.close()
    assert.ok(readExport(leaky).every((x) => x.turns.every((t) => t.passages.every((p) => !p.includes('sk-ant-api03')))))

    // ana's chat c1 already came through the team sync: an import neither replaces it nor lets --remove take it.
    const cache = openChatCache(a.memDir)
    const synced = (session: string) => ({ owner: 'ana', session, project: 'proj', rev: 3, started_at: 1, ended_at: 2, head: 'h', mask: 4, bytes: 1, tool: '', turns: [{ id: 't', at: 1, line: 'l', kind: 'turn' as const, passages: [`synced text ${session}`], paths: [], shas: [], prs: [], dead_end: false, dead_kind: '' }] })
    putChat(cache, synced('c1'))
    putChat(cache, synced('other'))
    cache.close()
    const imp = cli(a, 'import', file, '--yes')
    assert.equal(imp.status, 0, imp.stderr)
    assert.match(imp.stdout, /imported 0 chats; 1 your team sync already brought stay as they are/)
    assert.equal(removeImported(a.memDir, 'ana'), 0)
    assert.deepEqual(readChats(a.memDir).map((x) => [x.session, x.rev]), [['c1', 3], ['other', 3]], 'the synced chats stay, unchanged')
  } finally {
    a.destroy()
  }
})

test('export names the sender by their team name when joined, so a teammate never sees one person twice', () => {
  const a = sender()
  try {
    writeFileSync(join(a.memDir, 'team.json'), JSON.stringify({ url: 'http://x', token: 't', lastRev: 0, shared: {}, queue: [], me: 'ana-team' }))
    const r = cli(a, 'export', a.proj, '--out', join(a.home, 'f.thenwise'))
    assert.match(r.stdout, /the reader sees them as chats of ana-team/)
    const file = join(a.home, 'g.thenwise')
    assert.equal(cli(a, 'export', a.proj, '--out', file, '--yes').status, 0)
    const b = new World()
    try {
      assert.equal(cli(b, 'import', file, '--yes').status, 0)
      assert.equal(removeImported(b.memDir, 'ana-team'), 1, 'an import is removed by the name it came under')
    } finally {
      b.destroy()
    }
  } finally {
    a.destroy()
  }
})
