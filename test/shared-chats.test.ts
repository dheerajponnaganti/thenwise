// Shared project chats, client side and retrieval (0.1.18 and 0.1.19). The first half needs no server: units are built
// from the archive and the cache is written by hand. The second half runs against a real server from src/teams/server.ts
// and is skipped while the server routes of the shared-chats branch are not in this tree.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { real } from '../src/ingest/repos.ts'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { test } from 'node:test'

import { loadConfigSafe } from '../src/ingest/config.ts'
import { trimTrace } from '../src/hooks/hook.ts'
import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { teamChats, teamChatsPart, teamClaims } from '../src/ingest/parts.ts'
import { dropChat, openChatCache, putChat, readChats } from '../src/teams/chatcache.ts'
import type { WireChat } from '../src/teams/chatcache.ts'
import { archived, buildChat, formatPreview, loadShares, previewShare, pushShared, scrubber, setServerStatus, sharesStatus, unshareChats, updateShares } from '../src/teams/chats.ts'
import { fetchShared, joinTeam } from '../src/teams/client.ts'
import { openTeamDb } from '../src/teams/schema.ts'
import { createTeamServer, invite } from '../src/teams/server.ts'
import { chatText, diffStores, git, World } from './world.ts'

const SERVER = readFileSync(new URL('../src/teams/server.ts', import.meta.url), 'utf8').includes('chat-tombs')
const needs = SERVER ? {} : { skip: 'needs server routes from shared-chats' }
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `tw18-${p}-`))
const LONG = 'The quokka exporter writes eight shards, and each shard is flushed after the cache settles. '.repeat(14)

/** A World with one shared-able chat in its project (absolute paths read and edited, a path outside the repo, a secret). */
function sender(extra: Parameters<World['chat']>[1]['turns'] = []) {
  const w = new World()
  w.chat('c1', {
    turns: [
      { prompt: 'Why does the exporter drop shards?', reply: `${LONG}See ${w.proj}/src/a.ts and ${w.home}/.zshrc.`, reads: [`${w.proj}/src/a.ts`, '/etc/hosts'], edits: [`${w.proj}/src/b.ts`] },
      { prompt: 'Add a cache test', reply: 'Done. Key ghp_abcdefghijklmnopqrstuvwxyz0123456789 stays out.', reads: [`${w.proj}/src/a.ts`], commit: { subject: 'Add cache test', sha: 'abc1234def' } },
      ...extra,
    ],
  })
  w.archive()
  return w
}
const unit = (w: World, id = 'c1', redact: string[] = []) => {
  const cand = archived(w.cfg).find((x) => x.session === id)!
  return buildChat({ ...w.cfg, redact }, w.proj, cand, scrubber(redact).scrub)
}
const built = (b: ReturnType<typeof unit>) => {
  assert.ok(!('skip' in b), `skipped: ${'skip' in b ? b.skip : ''}`)
  return b as Exclude<typeof b, { skip: string }>
}

test('T18-H2: a unit holds prompt and reply passages and relative aliases only; passages equal the local store\'s', () => {
  const w = sender()
  try {
    const b = built(unit(w))
    const json = JSON.stringify(b.unit)
    assert.ok(!json.includes(w.home) && !json.includes(real(w.home)) && !json.includes('/etc/hosts') && !('cwd' in b.unit))
    assert.deepEqual(b.unit.turns[0]!.paths, ['src/a.ts', 'src/b.ts'])
    assert.equal(b.unit.project, 'proj')
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    const local = g.passages('turn:c1-0').map((p) => p.text)
    assert.ok(local.length > 1)
    assert.equal(b.unit.turns[0]!.passages.length, local.length)
    assert.ok(b.unit.turns[0]!.passages.join('').includes('See src/a.ts and ~/.zshrc.'), 'paths in prose are rewritten')
    assert.ok(!json.includes('ghp_abcdefghijkl'), 'the secret is masked')
    assert.deepEqual(b.unit.turns[1]!.shas, ['abc1234'])
    assert.ok(b.unit.turns.every((t) => t.passages.every((p) => p.length <= 1200)))
  } finally {
    w.destroy()
  }
})

test('T18-B1: [no-memory], a paused project, a subagent file and a chat of another project never leave', () => {
  const w = sender()
  try {
    w.chat('marked', { turns: [{ prompt: 'secret plan [no-memory]', reply: 'x' }] })
    w.chat('elsewhere', { turns: [{ prompt: 'other repo work', reply: 'y' }] }, '-home-other')
    const sub = join(w.home, '.claude/projects', w.key, 'c1', 'subagents', 'agent-1.jsonl')
    mkdirSync(dirname(sub), { recursive: true })
    const base = { cwd: w.proj, sessionId: 'c1', isSidechain: true, entrypoint: 'cli' }
    writeFileSync(sub, `${JSON.stringify({ type: 'user', uuid: 'sub-u', timestamp: '2026-10-01T10:00:00Z', ...base, message: { role: 'user', content: 'subagent brief about quokkas' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'sub-a', timestamp: '2026-10-01T10:00:05Z', ...base, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent report' }] } })}\n`)
    w.archive()
    const all = archived(w.cfg)
    const out = all.map((x) => [x.session, buildChat(w.cfg, w.proj, x, (t) => t)] as const)
    assert.deepEqual(out.filter(([, b]) => !('skip' in b)).map(([s]) => s), ['c1'])
    assert.ok(!all.some((x) => x.session === 'marked'), 'a marked chat never enters the archive')
    // A marker added after archiving still keeps the chat home.
    assert.deepEqual(buildChat({ ...w.cfg, ingestExcludeMarkers: ['Why does the exporter'] }, w.proj, all.find((x) => x.session === 'c1')!, (t) => t), { skip: 'no-memory' })
    assert.equal((out.find(([s]) => s === 'elsewhere')![1] as { skip: string }).skip, 'other')
    const c1 = built(unit(w))
    assert.equal(c1.subagentFiles, 1)
    assert.ok(!JSON.stringify(c1.unit).includes('quokkas'))
    // Allowed by the member: the subagent turns join the chat.
    const withSub = built(buildChat({ ...w.cfg, shareSubagents: true }, w.proj, all.find((x) => x.session === 'c1')!, (t) => t))
    assert.ok(JSON.stringify(withSub.unit).includes('subagent brief about quokkas'))
    // Paused after archiving: stays home.
    const paused = buildChat({ ...w.cfg, offProjects: [w.proj] }, w.proj, all.find((x) => x.session === 'c1')!, (t) => t)
    assert.deepEqual(paused, { skip: 'paused' })
  } finally {
    w.destroy()
  }
})

test('T18-B2: the redact list removes its words everywhere and the preview lists them with counts', () => {
  const w = sender([{ prompt: 'Does Acme use acme.internal for the exporter?', reply: 'Yes, ACME runs it at acme.internal.' }])
  try {
    const cfg = { ...w.cfg, redact: ['Acme', 'acme.internal'] }
    const b = built(buildChat(cfg, w.proj, archived(cfg)[0]!, scrubber(cfg.redact).scrub))
    assert.ok(!/acme/i.test(JSON.stringify(b.unit)))
    assert.ok(JSON.stringify(b.unit).includes('[redacted]'))
    const pv = previewShare(cfg, w.proj)
    assert.ok(pv.redacted.Acme! >= 3 && pv.redacted['acme.internal']! >= 2)
    const text = formatPreview(pv, cfg.redact)
    assert.match(text, /Acme \(\d+ removed\)/)
    assert.match(text, /acme\.internal \(\d+ removed\)/)
  } finally {
    w.destroy()
  }
})

test('T18-H1: the preview has counts, size, dates, three masked passages and what was left out', () => {
  const w = sender()
  try {
    w.chat('marked', { turns: [{ prompt: 'private [no-memory]', reply: 'x' }] })
    w.archive()
    const pv = previewShare(w.cfg, w.proj, { pick: () => 0 })
    assert.equal(pv.chats, 1)
    assert.ok(pv.passages >= 3 && pv.bytes > 1000)
    assert.match(pv.oldest, /^2026-10-/)
    assert.equal(pv.samples.length, 3)
    assert.ok(pv.samples.every((s) => !s.includes('ghp_')))
    const text = formatPreview(pv, [])
    assert.match(text, /chats: 1, passages: \d+, size: /)
    assert.match(text, /--since/)
    // --since leaves older chats out.
    assert.equal(previewShare(w.cfg, w.proj, { since: '2030-01-01' }).chats, 0)
  } finally {
    w.destroy()
  }
})

test('config: team.share_chats, team.redact and team.share_subagents are read and validated', () => {
  const w = new World()
  try {
    writeFileSync(join(w.memDir, 'config.json'), JSON.stringify({ ingest: { roots: [w.proj], repos: [w.proj] }, team: { share_chats: [w.proj], redact: ['Acme'], share_subagents: true } }))
    const r = loadConfigSafe(w.home)
    assert.deepEqual([r.config!.shareChats, r.config!.redact, r.config!.shareSubagents], [[w.proj], ['Acme'], true])
    assert.equal(loadConfigSafe(w.home).warnings.length, 0)
    writeFileSync(join(w.memDir, 'config.json'), JSON.stringify({ team: { redact: 'Acme' } }))
    assert.match(loadConfigSafe(w.home).errors.join(), /team\.redact/)
  } finally {
    w.destroy()
  }
})

// The cache and the ingest layer --------------------------------------------------------------------------------------

const wire = (over: Partial<WireChat> = {}): WireChat => ({
  owner: 'alice',
  session: 'as1',
  project: 'proj',
  rev: 5,
  started_at: Date.parse('2026-10-20T09:00:00Z'),
  ended_at: Date.parse('2026-10-20T10:00:00Z'),
  head: 'Why did we drop the quokka cache?',
  mask: 5,
  bytes: 400,
  turns: [
    { id: 't1', at: Date.parse('2026-10-20T09:00:00Z'), line: 'Why did we drop the quokka cache?', kind: 'turn', passages: ['We tried the quokka cache in src/a.ts and it corrupted shards, so we dropped it.'], paths: ['src/a.ts'], shas: [], prs: [], dead_end: true, dead_kind: 'undone' },
    { id: 't2', at: Date.parse('2026-10-20T09:30:00Z'), line: 'Use plain writes', kind: 'turn', passages: ['Plain writes are enough for the exporter.'], paths: [], shas: [], prs: [], dead_end: false, dead_kind: '' },
    { id: 'm1', at: Date.parse('2026-10-20T09:45:00Z'), line: 'Compaction summary', kind: 'summary', passages: ['Summary: the cache was dropped.'], paths: [], shas: [], prs: [], dead_end: false, dead_kind: '' },
  ],
  ...over,
})
const cache = (w: World, ...chats: WireChat[]) => {
  const db = openChatCache(w.memDir)
  for (const x of chats) putChat(db, x)
  db.close()
}

test('T19-H1: a teammate\'s cached chat becomes tses, tturn and tsum nodes with attribution, readable by id; the cache is 0600', () => {
  const w = new World()
  try {
    cache(w, wire())
    assert.equal(statSync(join(w.memDir, 'team-chats.db')).mode & 0o777, 0o600)
    w.archive()
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    assert.deepEqual(['tses:alice/as1', 'tturn:alice/t1', 'tsum:alice/m1'].map((i) => g.nodes.get(i)?.kind), ['session', 'turn', 'summary'])
    assert.equal(g.nodes.get('tturn:alice/t1')!.extra.sharedBy, 'alice')
    const out = c.search(g, 'quokka cache corrupted shards')
    assert.match(out, /\[turn\] tturn:alice\/t1/)
    assert.match(out, /source: chat of alice, 2026-10-20 \(team\)/)
    assert.match(c.get(g, 'tturn:alice/t1#p0'), /corrupted shards/)
    assert.match(c.pointers(g, 'what happened with the quokka cache corrupting shards'), /\(2026-10-20, alice\)/)
  } finally {
    w.destroy()
  }
})

test('T19-H2: a team turn links to this machine\'s file, and the file hint names the teammate\'s dead end', () => {
  const w = new World()
  try {
    cache(w, wire())
    w.archive()
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    const file = `file:${w.proj}/src/a.ts`
    assert.ok(g.nodes.has(file))
    assert.ok((g.adj.get(file) ?? []).some((e) => e.to === 'tturn:alice/t1'))
    g.scopeTo(w.proj)
    const hint = trimTrace(c.trace(g, 'src/a.ts'), 'src/a.ts')
    assert.match(hint, /- alice: tturn:alice\/t1/)
    assert.match(hint, /dead end \(undone\)/)
  } finally {
    w.destroy()
  }
})

test('T19-H3: without a checkout of the project the chats are global: hidden in another repo\'s scope, found in the all-projects search', () => {
  const w = new World()
  try {
    cache(w, wire({ project: 'org/nothing-here' }))
    w.archive()
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    g.scopeTo(w.proj)
    assert.doesNotMatch(c.search(g, 'quokka cache corrupted shards'), /tturn:alice/)
    g.scope = undefined
    assert.match(c.search(g, 'quokka cache corrupted shards'), /tturn:alice/)
    assert.equal(g.projectName(g.nodes.get('tturn:alice/t1')!), 'org/nothing-here')
  } finally {
    w.destroy()
  }
})

test('T19-H3: with a checkout the chats belong to the project and show in its scope', () => {
  const w = new World()
  try {
    cache(w, wire())
    w.archive()
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    g.scopeTo(w.proj)
    assert.match(c.search(g, 'quokka cache corrupted shards'), /tturn:alice/)
  } finally {
    w.destroy()
  }
})

test('T19-H5 T19-B4: chats arriving, changing and leaving: an update equals a rebuild each time', () => {
  const w = new World()
  try {
    w.chat('own', { turns: [{ prompt: 'my own work', reply: 'done', edits: [`${w.proj}/src/a.ts`] }] })
    w.archive()
    w.both()
    cache(w, wire())
    let r = w.both()
    assert.equal(r.a, r.b, diffStores(w.path('inc.db'), w.path('full.db')))
    assert.ok(new Graph(w.path('inc.db')).nodes.has('tturn:alice/t1'))
    cache(w, wire({ rev: 6, turns: [{ ...wire().turns[0]!, passages: ['Changed text about the quokka cache and the exporter.'], paths: ['src/b.ts'] }] }), wire({ owner: 'bob', session: 'bs1', turns: [{ ...wire().turns[1]!, id: 'b1' }] }))
    r = w.both()
    assert.equal(r.a, r.b, diffStores(w.path('inc.db'), w.path('full.db')))
    const db = openChatCache(w.memDir)
    dropChat(db, 'alice', 'as1')
    db.close()
    r = w.both()
    assert.equal(r.a, r.b, diffStores(w.path('inc.db'), w.path('full.db')))
    const g = new Graph(w.path('inc.db'))
    assert.ok(!g.nodes.has('tturn:alice/t1') && !g.nodes.has('tses:alice/as1') && g.nodes.has('tturn:bob/b1'))
    assert.ok(![...g.adj.keys()].some((k) => k.startsWith('tturn:alice')))
  } finally {
    w.destroy()
  }
})

test('T19-B3: a chat B holds itself is not added a second time from the team copy', () => {
  const w = sender()
  try {
    cache(w, wire({ session: 'c1' }))
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    assert.ok(g.nodes.has('ses:c1'))
    assert.ok(![...g.nodes.keys()].some((k) => k.startsWith('tses:') || k.startsWith('tturn:')))
  } finally {
    w.destroy()
  }
})

test('T19-H6: the startup brief gets one line with the teammates\' chats since the last session', () => {
  const w = new World()
  try {
    const now = Date.parse('2026-10-21T00:00:00Z')
    w.chat('own', { turns: [{ prompt: 'my work', reply: 'done', at: '2026-10-19T09:00:00Z' }] })
    cache(w, wire(), wire({ session: 'as2', turns: [{ ...wire().turns[1]!, id: 'q9' }] }), wire({ owner: 'bob', session: 'bs1', turns: [{ ...wire().turns[1]!, id: 'b1' }] }))
    w.archive()
    w.ingest('g.db')
    const g = new Graph(w.path('g.db'))
    g.scopeTo(w.proj)
    const brief = c.resumeShort(g, 7, now)
    assert.match(brief, /teammates' chats in this project since your last session: 3 \(alice 2, bob 1\)/)
    assert.match(brief, /last session here/)
  } finally {
    w.destroy()
  }
})

test('T19-B1: a planted secret and redact word in a chat never reach a teammate\'s store through the unit', () => {
  const a = new World()
  const b = new World()
  try {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`
    a.chat('s1', { turns: [{ prompt: 'Why Zorblax?', reply: `The token is ${token} and Zorblax uses it.` }] })
    a.archive()
    const cfg = { ...a.cfg, redact: ['Zorblax'] }
    const u = built(buildChat(cfg, a.proj, archived(cfg)[0]!, scrubber(cfg.redact).scrub)).unit
    cache(b, { ...u, owner: 'alice', session: 's1', rev: 1, bytes: 10 })
    b.archive()
    b.ingest('g.db')
    for (const f of ['g.db', 'team-chats.db']) {
      const raw = readFileSync(f === 'g.db' ? b.path(f) : join(b.memDir, f)).toString('latin1')
      assert.ok(!raw.includes(token) && !raw.includes('Zorblax'), f)
    }
    const db = new DatabaseSync(b.path('g.db'), { readOnly: true })
    assert.ok((db.prepare('SELECT count(*) n FROM passages WHERE text LIKE ?').get('%The token is%') as { n: number }).n > 0, 'the chat did arrive')
    db.close()
  } finally {
    a.destroy()
    b.destroy()
  }
})

test('T19-B5: forgetting B\'s own chat leaves A\'s shared chats in the cache and the store', async () => {
  const w = sender()
  try {
    cache(w, wire())
    const { forget } = await import('../src/privacy/forget.ts')
    await forget(w.cfg, 'c1', { yes: true, print: () => {}, rewriteVault: () => {} })
    assert.equal(readChats(w.memDir).length, 1)
    w.ingest('g.db')
    assert.ok(new Graph(w.path('g.db')).nodes.has('tturn:alice/t1'))
  } finally {
    w.destroy()
  }
})

// With a server -------------------------------------------------------------------------------------------------------

async function team() {
  const dir = tmp('srv')
  const app = createTeamServer({ dir })
  const base = `http://127.0.0.1:${(await app.listen()).port}`
  const db = openTeamDb(dir)
  const tokens = { alice: invite(db, 'alice'), bob: invite(db, 'bob') }
  db.close()
  const a = sender()
  const b = new World()
  await joinTeam(a.memDir, base, tokens.alice)
  await joinTeam(b.memDir, base, tokens.bob)
  const share = (w: World, since?: string) => updateShares(w.memDir, (s) => void (s.projects.proj = { repo: w.proj, status: 'active', ...(since ? { since } : {}) }))
  const serverCount = (sql: string) => {
    const d = openTeamDb(dir)
    try {
      return Number((d.prepare(sql).get() as { n: number }).n)
    } finally {
      d.close()
    }
  }
  const stop = async () => {
    a.destroy()
    b.destroy()
    await app.close()
  }

  return { dir, app, base, tokens, a, b, share, serverCount, stop }
}

test('T18-H3 T19-H1: A shares, a sync pushes the chat, B fetches it into team-chats.db and its memory finds it', needs, async () => {
  const t = await team()
  try {
    assert.equal((await pushShared(t.a.cfg)), '')
    t.share(t.a)
    assert.match(await pushShared(t.a.cfg), /^1 chat pushed/)
    assert.equal(Object.keys(loadShares(t.a.memDir).chats).length, 1)
    assert.match(sharesStatus(t.a.cfg).summary, /sharing chats of 1 project \(1 chats/)
    // Nothing changed: nothing is sent again.
    assert.match(await pushShared(t.a.cfg), /^0 chats pushed/)
    // A new chat in the shared project goes at the next sync.
    t.a.chat('c2', { turns: [{ prompt: 'Second chat about the quokka exporter', reply: 'ok' }] })
    t.a.archive()
    assert.match(await pushShared(t.a.cfg), /^1 chat pushed/)
    assert.match(await fetchShared(t.b.memDir), /2 team chats fetched/)
    assert.equal(readChats(t.b.memDir).length, 2)
    t.b.archive()
    t.b.ingest('g.db')
    const g = new Graph(t.b.path('g.db'))
    assert.match(c.search(g, 'quokka exporter shards'), /tturn:alice\/c1-0/)
    // B's own chats are never fed back to A.
    assert.equal(readChats(t.a.memDir).length, 0)
    assert.equal((await fetchShared(t.b.memDir)).includes('team chats fetched'), true)
  } finally {
    await t.stop()
  }
})

test('T18-H4: a mask or redact change re-pushes every shared chat once', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    const rev = loadShares(t.a.memDir).chats.c1!.rev
    assert.match(await pushShared({ ...t.a.cfg, redact: ['quokka'] }), /^1 chat pushed/)
    assert.ok(loadShares(t.a.memDir).chats.c1!.rev > rev)
    assert.match(await pushShared({ ...t.a.cfg, redact: ['quokka'] }), /^0 chats pushed/)
    await fetchShared(t.b.memDir)
    assert.ok(!JSON.stringify(readChats(t.b.memDir)).includes('quokka'))
  } finally {
    await t.stop()
  }
})

test('T18-H5: forgetting a shared chat deletes it on the server, the summary says so, and B drops it at its next sync', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    await fetchShared(t.b.memDir)
    assert.equal(readChats(t.b.memDir).length, 1)
    const { forget } = await import('../src/privacy/forget.ts')
    const lines: string[] = []
    await forget(t.a.cfg, 'c1', { yes: true, print: (l) => lines.push(l), rewriteVault: () => {} })
    assert.match(lines.join('\n'), /team: 0 shared notes unshared, 1 shared chat unshared/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    await fetchShared(t.b.memDir)
    assert.equal(readChats(t.b.memDir).length, 0)
    t.b.archive()
    t.b.ingest('g.db')
    assert.ok(![...new Graph(t.b.path('g.db')).nodes.keys()].some((k) => k.startsWith('tturn:')))
  } finally {
    await t.stop()
  }
})

test('a [no-memory] marker added after a chat was shared takes it off the server, and B drops it', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    await fetchShared(t.b.memDir)
    assert.equal(readChats(t.b.memDir).length, 1)
    t.a.grow('c1', [{ prompt: '[no-memory]' }])
    t.a.archive()
    assert.match(await pushShared(t.a.cfg), /1 chat no longer kept, unshared/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    assert.equal(Object.keys(loadShares(t.a.memDir).chats).length, 0)
    await fetchShared(t.b.memDir)
    assert.equal(readChats(t.b.memDir).length, 0)
  } finally {
    await t.stop()
  }
})

test('T18-H6: unshare-chats --pause keeps the server copy and sends nothing new; unshare removes the project', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    assert.match(await unshareChats(t.a.cfg, 'proj', { pause: true }), /paused/)
    t.a.chat('c3', { turns: [{ prompt: 'A chat after the pause', reply: 'ok' }] })
    t.a.archive()
    assert.equal(await pushShared(t.a.cfg), '')
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 1)
    assert.match(sharesStatus(t.a.cfg).lines.join(), /proj  paused/)
    t.share(t.a)
    assert.match(await unshareChats(t.a.cfg, t.a.proj), /unshared: 1 chat removed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM shared_projects'), 0)
    assert.equal(await pushShared(t.a.cfg), '')
    await fetchShared(t.b.memDir)
    assert.equal(readChats(t.b.memDir).length, 0)
  } finally {
    await t.stop()
  }
})

test('unshare-chats <session> removes one chat and it is not pushed again', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    assert.match(await unshareChats(t.a.cfg, 'c1'), /chat c1 unshared/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    assert.match(await pushShared(t.a.cfg), /^0 chats pushed/)
  } finally {
    await t.stop()
  }
})

test('T18-B3 T18-B4: 50 pushes per sync, a server that goes down mid-run resumes from the record without repeats', needs, async () => {
  const t = await team()
  try {
    for (let i = 0; i < 5; i++) t.a.chat(`n${i}`, { turns: [{ prompt: `Chat number ${i} about shards`, reply: 'ok' }] })
    t.a.archive()
    t.share(t.a)
    assert.match(await pushShared(t.a.cfg, { limit: 2 }), /^2 chats pushed, 4 more at the next sync/)
    await t.app.close()
    assert.match(await pushShared(t.a.cfg, { limit: 2 }), /stopped: server not reachable/)
    assert.equal(Object.keys(loadShares(t.a.memDir).chats).length, 2)
    const app2 = createTeamServer({ dir: t.dir, port: Number(new URL(t.base).port) })
    await app2.listen()
    try {
      assert.match(await pushShared(t.a.cfg, { limit: 2 }), /^2 chats pushed, 2 more/)
      assert.match(await pushShared(t.a.cfg, { limit: 2 }), /^2 chats pushed\)?/)
      assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 6)
      assert.match(await pushShared(t.a.cfg), /^0 chats pushed/)
    } finally {
      await app2.close()
    }
  } finally {
    t.a.destroy()
    t.b.destroy()
  }
})

test('T18-B6: no plaintext secret reaches the server file', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    assert.equal(t.serverCount("SELECT count(*) AS n FROM chat_passages WHERE text LIKE '%ghp_abcdefghijklmnop%'"), 0)
    assert.ok(t.serverCount("SELECT count(*) AS n FROM chat_passages WHERE text LIKE '%quokka%'") > 0)
  } finally {
    await t.stop()
  }
})

test('a project named by its GitHub slug is pushed under that name and unshared by it', needs, async () => {
  const t = await team()
  try {
    git(t.a.proj, 'remote', 'add', 'origin', 'https://github.com/me/proj.git')
    t.share(t.a)
    updateShares(t.a.memDir, (s) => void (s.projects['me/proj'] = s.projects.proj!, delete s.projects.proj))
    assert.match(await pushShared(t.a.cfg), /^1 chat pushed/)
    assert.equal(t.serverCount("SELECT count(*) AS n FROM chats WHERE project = 'me/proj'"), 1)
    assert.match(await unshareChats(t.a.cfg, 'me/proj'), /unshared: 1 chat removed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
  } finally {
    await t.stop()
  }
})

test('T18-H1: `team share-chats` shows the preview, shares nothing without a yes, and shares with --yes', needs, async () => {
  const t = await team()
  try {
    // Asynchronous: the server runs in this process and must keep answering while the command runs.
    const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const p = spawn(process.execPath, ['src/main.ts', 'team', ...args], { env: { ...process.env, HOME: t.a.home, THENWISE_HOME: t.a.memDir, THENWISE_SYNC: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let [stdout, stderr] = ['', '']
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      p.on('close', (status) => done({ status, stdout, stderr }))
    })
    const no = await run('share-chats', t.a.proj)
    assert.equal(no.status, 1)
    assert.match(no.stdout, /chats: 1, passages: \d+, size: .* from 2026-10-/)
    assert.match(no.stdout, /not shared/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    const yes = await run('share-chats', t.a.proj, '--yes')
    assert.equal(yes.status, 0, yes.stderr)
    assert.match(yes.stdout, /1 chat pushed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 1)
    assert.match((await run('shares')).stdout, /proj {2}sharing {2}1 chats/)
    assert.match((await run('unshare-chats', 'proj')).stdout, /unshared: 1 chat removed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    assert.equal((await run('share-chats', t.a.proj, '--since', 'nope')).status, 2)
  } finally {
    await t.stop()
  }
})

// Sync fixes (F1, F5, F7, F8, F10, F11) ---------------------------------------------------------------------------------

const api = (t: { base: string }, token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(`${t.base}/v1${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })

test('F1: an admin unshare is not undone by a re-push', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    assert.equal((await api(t, t.tokens.alice, '/chats/alice/c1', { method: 'DELETE', headers: { 'if-match': '*' } })).status, 200) // no seq: made on the server
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 1 - 1)
    const out = await pushShared({ ...t.a.cfg, redact: ['quokka'] })
    assert.match(out, /1 chat was unshared on the server/)
    assert.match(out, /0 chats pushed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
    assert.equal(loadShares(t.a.memDir).chats.c1, undefined)
    assert.match(sharesStatus(t.a.cfg).lines.join(), /1 unshared on the server/)
    // a plain PUT behind the tomb is refused, one that says reshare goes through
    const body = { project: 'proj', head: 'h', started_at: 1, ended_at: 2, turns: [{ id: 't', at: 1, passages: ['text'] }], seq: Date.now() }
    const refused = await api(t, t.tokens.alice, '/chats/c1', { method: 'PUT', body, headers: { 'if-match': '*' } })
    assert.equal(refused.status, 409)
    assert.equal(((await refused.json()) as any).error.code, 'unshared')
    assert.equal((await api(t, t.tokens.alice, '/chats/c1', { method: 'PUT', body: { ...body, reshare: true }, headers: { 'if-match': '*' } })).status, 200)
  } finally {
    await t.stop()
  }
})

test('F1: a deliberate share again sends reshare and brings the chat back', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    await api(t, t.tokens.alice, '/chats/alice/c1', { method: 'DELETE', headers: { 'if-match': '*' } })
    await pushShared(t.a.cfg)
    updateShares(t.a.memDir, (s) => {
      delete s.removed.c1
      s.projects.proj = { repo: t.a.proj, status: 'active', reshare: true }
    })
    assert.match(await pushShared(t.a.cfg), /^1 chat pushed/)
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 1)
    assert.match(await pushShared({ ...t.a.cfg, redact: ['quokka'] }), /^1 chat pushed/) // the tomb no longer blocks plain pushes
    assert.equal(loadShares(t.a.memDir).projects.proj?.reshare, undefined)
  } finally {
    await t.stop()
  }
})

test('F1: a project deleted on the server is marked removed on the owner\'s machine', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    assert.equal((await api(t, t.tokens.alice, '/shared-projects/alice/proj', { method: 'DELETE' })).status, 200)
    await pushShared({ ...t.a.cfg, redact: ['quokka'] })
    assert.equal(loadShares(t.a.memDir).projects.proj?.status, 'removed')
    assert.equal(t.serverCount('SELECT count(*) AS n FROM chats'), 0)
  } finally {
    await t.stop()
  }
})

test('F5: pause and resume reach the server and /v1/shared-projects returns the status', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    const status = async () => ((await (await api(t, t.tokens.bob, '/shared-projects')).json()) as any).projects[0].status
    assert.equal(await status(), 'active')
    await unshareChats(t.a.cfg, 'proj', { pause: true })
    assert.equal(await status(), 'paused')
    await setServerStatus(t.a.memDir, 'proj', 'active')
    assert.equal(await status(), 'active')
    const bad = await api(t, t.tokens.alice, '/shared-projects/alice/proj', { method: 'PATCH', body: { status: 'removed' } })
    assert.equal(bad.status, 400)
    assert.equal((await api(t, t.tokens.alice, '/shared-projects/alice/none', { method: 'PATCH', body: { status: 'paused' } })).status, 404)
    assert.equal((await api(t, t.tokens.bob, '/shared-projects/alice/proj', { method: 'PATCH', body: { status: 'paused' } })).status, 403)
  } finally {
    await t.stop()
  }
})

test('F7: GET /v1/chats lists metadata only, and full=1 carries the passages', needs, async () => {
  const t = await team()
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    const brief = ((await (await api(t, t.tokens.bob, '/chats?since=0')).json()) as any).chats[0]
    assert.equal(brief.session, 'c1')
    assert.ok(brief.turn_count > 0 && !('turns' in brief))
    const full = ((await (await api(t, t.tokens.bob, '/chats?since=0&full=1')).json()) as any).chats[0]
    assert.ok(full.turns.length > 0 && full.turns[0].passages.length > 0)
    await fetchShared(t.b.memDir) // the plugin's sync asks for full=1
    assert.ok(readChats(t.b.memDir)[0]!.turns.length > 0)
  } finally {
    await t.stop()
  }
})

test('F8: a team-shares.json without the removed key still remembers a hand unshare', () => {
  const w = new World()
  try {
    writeFileSync(join(w.memDir, 'team-shares.json'), JSON.stringify({ projects: {}, chats: {}, deletes: [] }))
    const s = loadShares(w.memDir)
    assert.ok(!Array.isArray(s.removed))
    updateShares(w.memDir, (x) => void (x.removed.c9 = 'proj'))
    assert.equal(loadShares(w.memDir).removed.c9, 'proj')
  } finally {
    w.destroy()
  }
})

test('F10: a dead end travels with its sentence, and the receiver\'s hint shows it', needs, async () => {
  const t = await team()
  try {
    t.a.chat('c2', { turns: [{ prompt: 'Add a cache test', reply: 'We tried the quokka cache and then reverted the quokka cache because it corrupted the shards.' }] })
    t.a.archive()
    const b = built(unit(t.a, 'c2'))
    const dead = b.unit.turns.find((x) => x.dead_end)
    assert.ok(dead?.dead_text && /reverted/.test(dead.dead_text) && dead.dead_text.length <= 160 && dead.dead_text !== dead.line)
    t.share(t.a)
    await pushShared(t.a.cfg)
    await fetchShared(t.b.memDir)
    const got = readChats(t.b.memDir).flatMap((c) => c.turns).find((x) => x.dead_end)
    assert.equal(got?.dead_text, dead!.dead_text)
    t.b.archive()
    t.b.ingest('g.db')
    const node = new Graph(t.b.path('g.db')).nodes.get(`tturn:alice/${dead!.id}`)!
    assert.equal(node.extra.deadEnd, dead!.dead_text)
    const over = await api(t, t.tokens.alice, '/chats/c3', { method: 'PUT', body: { project: 'proj', head: 'h', started_at: 1, ended_at: 2, turns: [{ id: 't', at: 1, passages: ['x'], dead_end: true, dead_text: 'y'.repeat(161) }] }, headers: { 'if-match': '*' } })
    assert.equal(over.status, 400)
  } finally {
    await t.stop()
  }
})

test('F11: pushes go newest chat first by date, and fit under the server\'s write limit', needs, async () => {
  const t = await team()
  try {
    const { utimesSync } = await import('node:fs')
    t.a.chat('aaa-new', { turns: [{ prompt: 'A newer chat about shards', reply: 'ok' }] })
    t.a.chat('zzz-old', { turns: [{ prompt: 'An older chat about shards', reply: 'ok' }] })
    utimesSync(t.a.chatPath('aaa-new'), new Date('2026-10-20'), new Date('2026-10-20'))
    utimesSync(t.a.chatPath('c1'), new Date('2025-01-01'), new Date('2025-01-01'))
    utimesSync(t.a.chatPath('zzz-old'), new Date('2026-01-01'), new Date('2026-01-01'))
    t.a.archive()
    t.share(t.a)
    await pushShared(t.a.cfg, { limit: 1 })
    assert.ok(loadShares(t.a.memDir).chats['aaa-new'] && !loadShares(t.a.memDir).chats['zzz-old'])
    const { PUSH_PER_SYNC } = await import('../src/teams/chats.ts')
    assert.ok(PUSH_PER_SYNC <= 45)
  } finally {
    await t.stop()
  }
})

// F2, F4, F9, F6 of the review: what leaves, checked on the unit and through a real server.

const PLANT = { token: `ghp_${'q1W2e3R4t5'.repeat(4).slice(0, 36)}`, word: 'Zorblax', env: 'DB_PASSWORD=supersecretvalue99', report: 'SUBAGENT-REPORT-MARKER' }
const planted = (w: World) =>
  w.chat('c1', {
    turns: [
      { prompt: 'Why does the exporter drop shards?', reply: `Zorblax runs it. Token ${PLANT.token}. Edited ${w.proj}/src/a.ts, see ${w.home}/.zshrc. ${LONG}`, agent: `${PLANT.report} contents of .env were ${PLANT.env} at ${w.home}/private/notes.md` },
      { prompt: 'Add a cache test', reply: 'Done.' },
    ],
  })

test('F2 subagent reports stay home: an Agent tool result is not in the unit, and local search still has it', () => {
  const w = new World()
  try {
    planted(w)
    w.archive()
    const json = JSON.stringify(built(unit(w)).unit)
    assert.ok(!json.includes(PLANT.report) && !json.includes('supersecretvalue99'))
    assert.ok(json.includes('exporter drop shards'), 'the prompt still travels')
    w.ingest('g.db')
    assert.ok(new Graph(w.path('g.db')).passages('turn:c1-0').some((p) => p.text.includes(PLANT.report)), 'the local store keeps the report')
  } finally {
    w.destroy()
  }
})

test('F4 home and project paths in prose become ~ and repo-relative before a passage leaves', () => {
  const w = new World()
  try {
    planted(w)
    w.archive()
    const json = JSON.stringify(built(unit(w)).unit)
    assert.ok(json.includes('Edited src/a.ts, see ~/.zshrc.'))
    assert.ok(!json.includes(w.home) && !json.includes(real(w.home)))
  } finally {
    w.destroy()
  }
})

test('F9 a chat over the limits keeps its newest turns and the preview says the oldest stay home', () => {
  const w = new World()
  try {
    const big = 'quokka shard flush '.repeat(60)
    w.chat('c1', { turns: Array.from({ length: 8 }, (_, i) => ({ prompt: `turn ${i}`, reply: `${big} end${i}` })) })
    w.archive()
    const b = built(buildChat({ ...w.cfg }, w.proj, archived(w.cfg)[0]!, (t) => t))
    assert.equal(b.cut, false)
    // Shrink the allowance by padding: 2,000-passage limit reached with many short turns.
    w.chat('c2', { turns: Array.from({ length: 2100 }, (_, i) => ({ prompt: `t${i}`, reply: `r${i}` })) })
    w.archive()
    const c2 = archived(w.cfg).find((x) => x.session === 'c2')!
    const u = built(buildChat(w.cfg, w.proj, c2, (t) => t))
    assert.ok(u.cut && u.dropped > 0)
    assert.ok(u.unit.turns.at(-1)!.id === 'c2-2099', 'the newest turn is kept')
    assert.ok(!u.unit.turns.some((t) => t.id === 'c2-0'), 'the oldest is dropped')
    const pv = previewShare(w.cfg, w.proj)
    assert.match(formatPreview(pv, []), /newest turns are sent and the oldest \d+ stay home/)
  } finally {
    w.destroy()
  }
})

test('F6 end to end: a planted key, redact word, home path and Agent result reach no server or teammate store', needs, async () => {
  const t = await team()
  try {
    planted(t.a)
    t.a.archive()
    t.share(t.a)
    t.a.cfg.redact = ['Zorblax']
    assert.match(await pushShared(t.a.cfg), /^1 chat pushed/)
    await fetchShared(t.b.memDir)
    t.b.archive()
    t.b.ingest('g.db')
    const files = (dir: string, prefix: string) => readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f))
    const scan = [...files(t.dir, 'team.db'), ...files(t.b.memDir, 'team-chats.db'), t.b.path('g.db')]
    assert.ok(scan.length >= 3)
    const bad = [PLANT.token, PLANT.word, 'supersecretvalue99', PLANT.report, t.a.home, real(t.a.home), 'private/notes.md']
    for (const f of scan) {
      const raw = readFileSync(f).toString('latin1')
      for (const x of bad) assert.ok(!raw.includes(x), `${x} in ${f}`)
    }
    assert.ok(t.serverCount("SELECT count(*) AS n FROM chat_passages WHERE text LIKE '%exporter drop%' OR text LIKE '%src/a.ts%'") > 0, 'the chat did travel')
  } finally {
    await t.stop()
  }
})

test('F6 no network: with a team and shared chats, search, hooks and MCP tools make no connection; team sync does', needs, async () => {
  const t = await team()
  const log = join(t.b.home, 'nonet.log')
  try {
    t.share(t.a)
    await pushShared(t.a.cfg)
    await fetchShared(t.b.memDir)
    const env = { ...process.env, HOME: t.b.home, THENWISE_HOME: t.b.memDir, THENWISE_SYNC: 'off', NONET_LOG: log, NONET_ALL: '1', NODE_OPTIONS: `--import=${new URL('./no-net.mjs', import.meta.url).pathname}` }
    const cli = new URL('../src/cli.ts', import.meta.url).pathname
    const run = (args: string[], input = '') => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', input, cwd: t.b.home })
    assert.equal(run(['archive']).status, 0)
    assert.equal(run(['ingest']).status, 0)
    assert.match(run(['search', 'quokka exporter shards', '--all']).stdout, /quokka/)
    assert.equal(run(['hook', 'session-start'], JSON.stringify({ source: 'startup', cwd: t.b.proj, session_id: 'x' })).status, 0)
    assert.equal(run(['hook', 'prompt'], JSON.stringify({ prompt: 'quokka exporter shards', cwd: t.b.proj, session_id: 'x' })).status, 0)
    const rpc = (id: number, method: string, params: object) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const mcp = run(['mcp'], `${rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })}\n${rpc(2, 'tools/call', { name: 'memory_search', arguments: { query: 'quokka exporter' } })}\n`)
    assert.match(mcp.stdout, /"id":2/)
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '', 'a connection was made')
    // The guard sees the team server when it should: `team sync` connects.
    run(['team', 'sync'])
    assert.match(readFileSync(log, 'utf8'), /127\.0\.0\.1|localhost/)
  } finally {
    await t.stop()
  }
})

test('F4 a sibling folder is not rewritten', () => {
  const w = new World()
  try {
    w.chat('c1', { turns: [{ prompt: 'Where?', reply: `Saw ${w.proj}-other/a.ts, ${w.home}2/x and ${w.proj}/src/a.ts and ${w.home}.` }] })
    w.archive()
    const json = JSON.stringify(built(unit(w)).unit)
    assert.ok(json.includes('~/proj-other/a.ts') && json.includes(`${w.home}2/x`))
    assert.ok(json.includes('and src/a.ts and ~.'), json)
  } finally {
    w.destroy()
  }
})

test('F3: opening a store with many shared chats runs no git at all', () => {
  const w = new World()
  const bin = tmp('gitshim')
  const log = join(bin, 'calls.log')
  const oldPath = process.env.PATH
  try {
    w.chat('own', { turns: [{ prompt: 'my work', reply: 'done' }] })
    w.chat('own2', { turns: [{ prompt: 'other work', reply: 'done' }] }, '-home-other')
    w.archive()
    cache(w, ...Array.from({ length: 30 }, (_, i) => wire({ session: `s${i}`, turns: [{ ...wire().turns[0]!, id: `t${i}` }] })))
    w.ingest('g.db')
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho x >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${oldPath}`
    const g = new Graph(w.path('g.db'))
    g.rootOf(g.nodes.get('tturn:alice/t1')!)
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0
    assert.equal(calls, 0, `git ran ${calls} times`)
  } finally {
    process.env.PATH = oldPath
    w.destroy()
  }
})

test('F11: the team chat cache is read once per ingest and the sender\'s passages arrive unchanged', () => {
  const w = new World()
  try {
    const passages = ['First short one.', 'Second one.', 'x '.repeat(30)]
    const chat = wire({ turns: [{ ...wire().turns[0]!, passages }] })
    cache(w, chat)
    w.archive()
    const chats = teamChats(w.cfg)
    rmSync(join(w.memDir, 'team-chats.db'))
    // With the chats passed in, neither layer touches the (now deleted) cache.
    assert.ok(teamChatsPart(w.cfg, [], chats).nodes.some((n) => n.id === 'tturn:alice/t1'))
    assert.ok(teamClaims(w.cfg, chats) instanceof Map)
    cache(w, chat)
    w.both()
    const g = new Graph(w.path('inc.db'))
    assert.deepEqual(g.passages('tturn:alice/t1').map((p) => p.text), passages)
    assert.equal(w.both().a, w.both().b)
    assert.deepEqual(new Graph(w.path('full.db')).passages('tturn:alice/t1').map((p) => p.text), passages)
  } finally {
    w.destroy()
  }
})

/** A chat started in the home folder (no repository), editing the given files. */
function homeChat(w: World, id: string, edits: string[]) {
  const path = w.chatPath(id, '-home')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, chatText(id, { turns: [{ prompt: `Work from home ${id}`, reply: 'Edited it.', edits }] }, w.home))
}

test('scope: a chat started in the home folder that edited the project is shared', () => {
  const w = sender()
  try {
    // A repo outside the ingest roots does not count, however many of its folders were edited.
    const out = join(w.home, 'aaa')
    mkdirSync(join(out, 'src'), { recursive: true })
    mkdirSync(join(out, 'lib'), { recursive: true })
    git(out, 'init', '-q', '-b', 'main')
    homeChat(w, 'homed', [`${out}/src/x.ts`, `${out}/lib/y.ts`, `${w.proj}/src/a.ts`])
    w.archive()
    built(buildChat(w.cfg, w.proj, archived(w.cfg).find((x) => x.session === 'homed')!, (t) => t))
    assert.equal(previewShare(w.cfg, w.proj).chats, 2)
  } finally {
    w.destroy()
  }
})

test('scope: a chat that touched two repos is shared under one project only', () => {
  const w = sender()
  try {
    homeChat(w, 'both', [`${w.other}/src/a.ts`, `${w.proj}/src/a.ts`, `${w.proj}/lib/b.ts`])
    w.archive()
    const c = archived(w.cfg).find((x) => x.session === 'both')!
    const ok = [w.proj, w.other].filter((r) => !('skip' in buildChat(w.cfg, r, c, (t) => t)))
    assert.deepEqual(ok, [w.proj])
  } finally {
    w.destroy()
  }
})

test('team shares counts only chats the push would send', () => {
  const w = sender()
  try {
    w.chat('late', { turns: [{ prompt: 'Zebra plan', reply: 'y' }] })
    w.archive()
    // A marker added after archiving keeps the chat home, so the push drops it.
    const cfg = { ...w.cfg, shareChats: [w.proj], ingestExcludeMarkers: ['Zebra'] }
    assert.match(sharesStatus(cfg).lines.join(), /, 1 waiting to push/)
  } finally {
    w.destroy()
  }
})

test('scope: a chat in a worktree of the project is shared under the project', () => {
  const w = sender()
  try {
    const wt = join(w.home, 'wt')
    for (const r of [w.proj]) git(r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git')
    git(w.proj, 'worktree', 'add', '-q', '-b', 'wt', wt)
    const clone = join(w.home, 'clone')
    execFileSync('git', ['clone', '-q', w.proj, clone])
    git(clone, 'remote', 'set-url', 'origin', 'git@github.com:me/proj.git')
    homeChat(w, 'inwt', [`${wt}/src/a.ts`])
    homeChat(w, 'inclone', [`${clone}/src/a.ts`])
    w.archive()
    const cfg = { ...w.cfg, roots: [...w.cfg.roots, wt, clone] }
    for (const id of ['inwt', 'inclone']) {
      const b = built(buildChat(cfg, w.proj, archived(w.cfg).find((x) => x.session === id)!, (t) => t))
      assert.deepEqual(b.unit.turns[0]!.paths, ['src/a.ts'])
      assert.equal(b.unit.project, 'me/proj')
    }
  } finally {
    w.destroy()
  }
})
