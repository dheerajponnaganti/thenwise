import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { docsPart, memoryPart, notesPart, prPart } from '../src/ingest/parts.ts'
import { parseSession } from '../src/ingest/transcript.ts'
import { skipReason } from '../src/vault/user.ts'
import { World, diffStores, git } from './world.ts'

const rows = (w: World, db: string, sql: string, ...p: any[]) => new DatabaseSync(w.path(db), { readOnly: true }).prepare(sql).all(...p) as any[]
const user = (uuid: string, content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-01T09:00:00Z', cwd: '/p', entrypoint: 'cli', message: { role: 'user', content }, ...extra })
const same = (w: World, why: string) => {
  const { a, b } = w.both()
  assert.equal(a, b, `${why}\n${diffStores(w.path('inc.db'), w.path('full.db'))}`)
}

test('10: slash-command turns are kept, system wrappers are skipped, a typed <div> stays', () => {
  const text = [
    user('u1', '<command-message>review is running</command-message>\n<command-name>/review</command-name>\n<command-args>the diff</command-args>'),
    user('u2', '<local-command-stdout>ok</local-command-stdout>'),
    user('u3', '<system-reminder>x</system-reminder>'),
    user('u4', '<div>why is this broken</div>'),
    user('u5', '<ide_opened_file>a.ts</ide_opened_file>\nfix the bug'),
  ].join('\n')
  assert.deepEqual(parseSession(text, 's', '/h').turns.map((t) => t.prompt), ['/review the diff', '<div>why is this broken</div>', 'fix the bug'])
})

test('10/11: Agent results join the parent turn; a subagent file is parsed as turns of its parent', () => {
  const parent = [user('u1', 'do it'), JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T09:00:01Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] } }), user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'crew report: all fine' }] }])].join('\n')
  assert.match(parseSession(parent, 's', '/h').turns[0]!.reply.join(' '), /crew report/)
  const side = user('s1', 'crew task', { isSidechain: true })
  assert.equal(parseSession(side, 's', '/h').turns.length, 0)
  assert.equal(parseSession(side, 's', '/h', '', true).turns.length, 1)
})

test('11: archived subagent chats become turns part_of the parent session, update equals rebuild', () => {
  const w = new World()
  try {
    w.chat('p1', { turns: [{ prompt: 'start the crew job', reply: 'on it' }] })
    const dir = join(w.home, '.claude/projects', w.key, 'p1', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-1.jsonl'), `${user('sub1', 'crew member task about retries', { isSidechain: true, cwd: w.proj, sessionId: 'p1' })}\n`)
    w.archive()
    same(w, 'subagent')
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM edges WHERE src = 'turn:sub1' AND dst = 'ses:p1' AND kind = 'part_of'")[0].n, 1)
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM nodes WHERE kind = 'session'")[0].n, 1)
  } finally {
    w.destroy()
  }
})

test('12: sdk and missing entrypoints are in, marked eval chats stay out', () => {
  const w = new World()
  try {
    w.chat('a', { turns: [{ prompt: 'one' }], entrypoint: 'sdk-cli' })
    w.chat('b', { turns: [{ prompt: 'two' }], entrypoint: 'sdk-ts' })
    w.chat('c', { turns: [{ prompt: 'three' }], entrypoint: '' })
    w.chat('d', { turns: [{ prompt: '[no-memory] four' }], entrypoint: 'sdk-cli' })
    w.chat('e', { turns: [{ prompt: 'five' }], entrypoint: 'sdk-cli' }, '-home-x-eval-ws-1')
    w.archive()
    assert.equal(w.ingest('inc.db').sessionsIn, 3)
  } finally {
    w.destroy()
  }
})

test('17/19: commits say onMain, stash is not read, rewritten commits are kept as unreachable', () => {
  const w = new World()
  try {
    w.chat('a', { turns: [{ prompt: 'one' }] })
    w.archive()
    git(w.proj, 'checkout', '-q', '-b', 'side')
    const side = w.commit(w.proj, 'src/side.ts', 'Side work')
    git(w.proj, 'checkout', '-q', 'main')
    writeFileSync(join(w.proj, 'src/a.ts'), 'changed\n')
    git(w.proj, 'stash')
    w.ingest('inc.db')
    const on = (sha: string) => rows(w, 'inc.db', 'SELECT extra FROM nodes WHERE id = ?', `commit:proj:${sha}`).map((r) => JSON.parse(r.extra))[0]
    assert.equal(on(side).onMain, false)
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM nodes WHERE kind = 'commit'")[0].n, 2)
    const old = w.commit(w.proj, 'src/tmp.ts', 'Tmp')
    w.ingest('inc.db')
    assert.equal(on(old).onMain, true)
    git(w.proj, 'commit', '--amend', '-q', '-m', 'Tmp again')
    w.ingest('inc.db')
    assert.equal(on(old).unreachable, true)
    assert.equal(on(old).onMain, false)
    assert.equal(on(git(w.proj, 'rev-parse', 'main')).onMain, true)
  } finally {
    w.destroy()
  }
})

test('18: CLAUDE.md files of clones below a root are not global rules', () => {
  const w = new World()
  try {
    mkdirSync(join(w.proj, 'research/clone'), { recursive: true })
    git(join(w.proj, 'research/clone'), 'init', '-q')
    writeFileSync(join(w.proj, 'research/clone/CLAUDE.md'), '- a rule that belongs to the clone only\n')
    mkdirSync(join(w.proj, 'plain'), { recursive: true })
    writeFileSync(join(w.proj, 'plain/CLAUDE.md'), '- a rule of this very project\n')
    const sources = docsPart(w.cfg).nodes.map((n) => n.source)
    assert.ok(sources.some((s) => s.endsWith('plain/CLAUDE.md')))
    assert.ok(!sources.some((s) => s.includes('clone')))
  } finally {
    w.destroy()
  }
})

test('20: a repo is found from the files a chat edited, though the chat ran elsewhere', () => {
  const w = new World({ repos: [] })
  try {
    w.chat('a', { turns: [{ prompt: 'edit across', edits: [join(w.proj, 'src/a.ts')] }], cwd: w.home })
    w.archive()
    same(w, 'edit dirs')
    assert.ok(rows(w, 'inc.db', "SELECT id FROM nodes WHERE kind = 'commit'").length >= 1)
  } finally {
    w.destroy()
  }
})

test('29: reviews join the PR text and the gh timeout is configurable', () => {
  const w = new World()
  try {
    const pr = prPart([{ full: 'me/proj', list: [{ number: 1, title: 't', body: 'b', createdAt: '2026-10-01T00:00:00Z', reviews: [{ body: 'looks right, ship it' }] }] }], [], { id: () => undefined, repo: () => undefined })
    assert.match(pr.nodes[0]!.text, /ship it/)
    assert.equal(w.cfg.ghTimeoutMs, 60000)
  } finally {
    w.destroy()
  }
})

test('30: auto-memory of a key with no chats, Part 2 beside Part, and note dates from git', () => {
  const w = new World()
  try {
    const mem = join(w.home, 'mem/-no-chats/memory')
    mkdirSync(mem, { recursive: true })
    writeFileSync(join(mem, 'x.md'), 'a fact\n')
    assert.equal(memoryPart(w.cfg, [], join(w.home, 'mem')).nodes.length, 1)

    w.note('Part.md', '# Part\nline one\nline two\nline three\n')
    w.note('Part 2.md', '# Part two\nsomething else entirely\n')
    w.note('Copy.md', '# Copy\nline one\nline two\n')
    w.note('Copy 2.md', '# Copy\nline one\nline two\n')
    assert.equal(skipReason(join(w.vault, 'Part 2.md'), 'Part 2.md'), '')
    assert.equal(skipReason(join(w.vault, 'Copy 2.md'), 'Copy 2.md'), 'conflict copy')

    git(w.vault, 'init', '-q', '-b', 'main')
    git(w.vault, 'add', '.')
    process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = '2026-03-04T10:00:00Z'
    try {
      git(w.vault, 'commit', '-q', '-m', 'notes')
    } finally {
      delete process.env.GIT_AUTHOR_DATE
      delete process.env.GIT_COMMITTER_DATE
    }
    utimesSync(join(w.vault, 'Details.md'), new Date('2026-09-09T00:00:00Z'), new Date('2026-09-09T00:00:00Z'))
    const at = notesPart(w.cfg).nodes.find((n) => n.id.endsWith('Details.md'))!.at
    assert.equal(at, '2026-03-04T10:00:00.000Z')
  } finally {
    w.destroy()
  }
})
