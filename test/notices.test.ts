// What the person sees: the "Thenwise added" line, /thenwise:shown, news of failures, the first-run message, the status
// dashboard, the notices level and Codex's hook trust.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { addedLine, addNews, forHost, noticeLevel, readSent, sentFile, setClient, takeNews } from '../src/core/notices.ts'
import { runHook, seen, syncRun } from '../src/hooks/hook.ts'
import { codexHooksTrusted } from '../src/ingest/codex.ts'
import { createServer } from '../src/server/stdio.ts'
import { tempDir, writeGraph } from './mcp-fixture.ts'

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
const key = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, '-')

/** A home with a repo, a data folder, and a Claude Code chat of the repo that stopped five minutes ago. */
function world(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tw-notice-'))
  const proj = join(home, 'shop')
  mkdirSync(proj, { recursive: true })
  git(proj, 'init', '-q')
  const dir = join(home, '.thenwise')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const at = new Date(Date.now() - 5 * 60_000).toISOString()
  const chats = join(home, '.claude/projects', key(proj))
  mkdirSync(chats, { recursive: true })
  const r = (o: object) => JSON.stringify({ cwd: proj, sessionId: 'cc-1', entrypoint: 'cli', ...o })
  writeFileSync(join(chats, 'cc-1.jsonl'), `${r({ type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: 'Shard the price cache' } })}\n${r({ type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Two shards done.' }] } })}\n`)
  utimesSync(join(chats, 'cc-1.jsonl'), new Date(at), new Date(at))

  return { home, proj, dir, env: { dir, cli: 'none' } }
}
function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    return f()
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

test('Claude Code: the person sees what Thenwise added, and /thenwise:shown lists exactly what went to the agent', () => {
  const w = world()
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, COPILOT_PLUGIN_ROOT: undefined, ANTIGRAVITY_CONVERSATION_ID: undefined }, () => {
    const out = JSON.parse(runHook('session-start', { session_id: 'me', source: 'startup', cwd: w.proj }, w.env))
    assert.match(out.systemMessage, /^Thenwise added: where a Claude Code session stopped 5 min ago \(ses:cc-1\)\. \/thenwise:shown lists it\.$/m)
    const sent = readSent(w.dir, 'me')!
    assert.deepEqual(sent.sent.map((s) => s.kind), ['handoff'])
    assert.match(sent.sent[0]!.text, /^<memory-handoff tool="Claude Code"/)
  })
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'shown', '--session', 'me'], { encoding: 'utf8', env: { ...process.env, HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.dir } })
  assert.match(cli.stdout, /What Thenwise added to the agent in session me: 1 block, about \d+ tokens/)
  assert.match(cli.stdout, /session-start · handoff/)
  assert.ok(existsSync(sentFile(w.dir, 'me')))
})

test('Copilot and Antigravity show no hook text, so the agent is asked to relay the same line', () => {
  const w = world()
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, COPILOT_PLUGIN_ROOT: '/plugin' }, () => {
    const out = JSON.parse(runHook('session-start', { session_id: 'cp', source: 'startup', cwd: w.proj }, w.env))
    assert.equal(out.systemMessage, undefined)
    assert.match(out.additionalContext, /<memory-notice note="Tell the person this in one short line, then continue.">\nThenwise added: where a Claude Code session stopped/)
  })
})

test('a brief alone is routine and stays quiet; a resume after a compaction is named', () => {
  assert.equal(addedLine('<memory-brief note="x">\nlast session here\n</memory-brief>'), '')
  assert.match(addedLine('<memory-resume topic="shop" note="x">\n...\n</memory-resume>'), /Thenwise added: a resume brief of this session/)
})

test('a failed sync step reaches the person once, at the next session start', () => {
  const w = world()
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, COPILOT_PLUGIN_ROOT: undefined, THENWISE_NO_UPDATE_CHECK: '1' }, () => {
    syncRun({ dir: w.dir, cli: join(w.dir, 'missing.js') }) // every step fails: the CLI is not there
    const first = JSON.parse(runHook('session-start', { session_id: 's1', source: 'startup', cwd: w.proj }, w.env))
    assert.match(first.systemMessage, /Thenwise: the background sync's \w+ step failed; \/thenwise:logs shows why/)
    const again = runHook('session-start', { session_id: 's2', source: 'startup', cwd: w.proj }, w.env)
    assert.doesNotMatch(again, /step failed/)
  })
})

test('notices: important keeps failures and drops the added line; off shows nothing; the env wins', () => {
  const w = world({ notices: 'important' })
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, COPILOT_PLUGIN_ROOT: undefined }, () => {
    addNews(w.dir, 'sync-ingest', "the background sync's ingest step failed")
    const out = JSON.parse(runHook('session-start', { session_id: 'i1', source: 'startup', cwd: w.proj }, w.env))
    assert.match(out.systemMessage, /ingest step failed/)
    assert.doesNotMatch(out.systemMessage, /Thenwise added/)
  })
  const off = world({ notices: 'off' })
  addNews(off.dir, 'sync-ingest', 'failed')
  assert.equal(takeNews(off.dir, noticeLevel({ notices: 'off' })), '')
  withEnv({ THENWISE_NOTICES: 'off' }, () => assert.equal(noticeLevel({ notices: 'all' }), 'off'))
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'notices', 'important'], { encoding: 'utf8', env: { ...process.env, HOME: off.home, USERPROFILE: off.home, THENWISE_HOME: off.dir } })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(readFileSync(join(off.dir, 'config.json'), 'utf8')).notices, 'important')
  assert.equal(spawnSync(process.execPath, ['src/cli.ts', 'notices', 'loud'], { encoding: 'utf8', env: { ...process.env, HOME: off.home, THENWISE_HOME: off.dir } }).status, 2)
})

test('first run: the person and the agent hear what is read, where it goes and how to pause it, once per install', () => {
  const w = world()
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, THENWISE_SYNC: 'on', COPILOT_PLUGIN_ROOT: undefined }, () => {
    const env = { dir: w.dir, cli: join(w.dir, 'missing.js') } // the detached sync starts and exits at once
    const out = JSON.parse(runHook('session-start', { session_id: 'f1', source: 'startup', cwd: w.proj }, env))
    assert.match(out.systemMessage, /Thenwise: first sync started\. It reads your past chats \(1 from Claude Code\) into .*\.thenwise, masking secrets first; nothing leaves this machine\./)
    assert.match(out.hookSpecificOutput.additionalContext, /<memory-first-run note="Tell the person this in up to three short lines, then continue.">[\s\S]*`thenwise off` pauses it/)
    const again = runHook('session-start', { session_id: 'f2', source: 'startup', cwd: w.proj }, env)
    assert.doesNotMatch(again, /memory-first-run/)
  })
})

test('/thenwise:status leads with six lines: memory, session, hooks, team, inbox, errors', () => {
  const w = world()
  withEnv({ HOME: w.home, THENWISE_HOME: w.dir, COPILOT_PLUGIN_ROOT: undefined }, () => {
    runHook('session-start', { session_id: 'st', source: 'startup', cwd: w.proj }, w.env)
    writeFileSync(join(w.dir, 'graph.db'), '')
    const out = runHook('status', {}, w.env)
    assert.deepEqual(out.split('\n').slice(0, 6).map((l) => l.split(/\s+/)[0]), ['memory', 'session', 'hooks', 'team', 'inbox', 'errors'])
    assert.match(out, /^session +handoff added, about \d+ tokens; \/thenwise:shown lists them$/m)
    assert.match(out, /^team +not in a team$/m)
  })
})

test('Codex hook trust: read from its config, shown by doctor and by the first memory answer in a Codex session', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-cxtrust-'))
  mkdirSync(join(home, '.codex'), { recursive: true })
  assert.equal(codexHooksTrusted(home), undefined) // no config: Codex is not here
  writeFileSync(join(home, '.codex/config.toml'), '[plugins."thenwise@thenwise"]\nenabled = true\n')
  assert.equal(codexHooksTrusted(home), false)
  withEnv({ HOME: home, CODEX_HOME: undefined }, () => {
    const s = createServer(() => writeGraph(tempDir()), '/x/p')
    s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } })
    s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const call = (id: number) => (s.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_why', arguments: { query: 'cache shards' } } }) as any).result.content[0].text as string
    const first = call(2)
    assert.match(first, /^Note for the person: Thenwise's Codex hooks aren't trusted, so automatic sync and hook context are off\. Memory tools still work, and memory_resume can read a live handoff\. Trust Thenwise in \/hooks\./)
    assert.doesNotMatch(call(3), /hooks aren't trusted/) // once per server
  })
  // A session that starts with memory_resume gets the note there, once.
  withEnv({ HOME: home, CODEX_HOME: undefined }, () => {
    const s = createServer(() => writeGraph(tempDir()), '/x/p')
    s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } })
    const resume = (s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_resume', arguments: {} } }) as any).result.content[0].text as string
    assert.match(resume, /^Note for the person: Thenwise's Codex hooks aren't trusted/)
    const next = (s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_why', arguments: { query: 'cache shards' } } }) as any).result.content[0].text as string
    assert.doesNotMatch(next, /hooks aren't trusted/)
  })
  writeFileSync(join(home, '.codex/config.toml'), '[plugins."thenwise@thenwise"]\nenabled = true\n\n[hooks.state."thenwise@thenwise:hooks/codex.json:session_start:0:0"]\ntrusted_hash = "sha256:x"\n')
  assert.equal(codexHooksTrusted(home), true)
})

test('a /thenwise: command is named the way each tool runs it: Codex and Antigravity load no plugin commands (agent feedback, 2026-11-04)', () => {
  const line = 'a step failed; /thenwise:logs shows why'
  setClient('') // an earlier test's Codex server named its client in this process
  withEnv({ PLUGIN_ROOT: undefined, COPILOT_PLUGIN_ROOT: undefined, ANTIGRAVITY_CONVERSATION_ID: undefined }, () => assert.equal(forHost(line), line)) // Claude Code
  withEnv({ PLUGIN_ROOT: '/p', COPILOT_PLUGIN_ROOT: '/p', ANTIGRAVITY_CONVERSATION_ID: undefined }, () => assert.equal(forHost(line), line)) // Copilot
  for (const env of [{ PLUGIN_ROOT: '/p', COPILOT_PLUGIN_ROOT: undefined, ANTIGRAVITY_CONVERSATION_ID: undefined }, { PLUGIN_ROOT: undefined, COPILOT_PLUGIN_ROOT: undefined, ANTIGRAVITY_CONVERSATION_ID: 'c1' }]) {
    withEnv(env, () => {
      assert.doesNotMatch(forHost(line), /\/thenwise:/)
      assert.match(forHost(line), /`(node "[^"]+" |thenwise )logs` shows why/)
    })
  }
  // The memory server knows its client from initialize.
  withEnv({ PLUGIN_ROOT: undefined, COPILOT_PLUGIN_ROOT: undefined, ANTIGRAVITY_CONVERSATION_ID: undefined }, () => {
    setClient('codex-mcp-client')
    try {
      assert.doesNotMatch(forHost(line), /\/thenwise:/)
    } finally {
      setClient('claude-code')
    }
    assert.equal(forHost(line), line)
  })
})

test('Codex gets one line on memory_search to call memory before its shell; other clients get the plain tools (agent feedback, 2026-11-04)', () => {
  const tools = (client: string) => {
    const s = createServer(() => writeGraph(tempDir()), '/x/p')
    s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: client } } })
    return (s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any).result.tools as { name: string; description: string }[]
  }
  const codex = tools('codex-mcp-client')
  assert.deepEqual(codex.filter((t) => /before any shell command/.test(t.description)).map((t) => t.name), ['memory_search'])
  assert.ok(tools('claude-code').every((t) => !/shell command/.test(t.description)))
  setClient('')
})

test('the weekly sweep of hook state keeps the mark of news already told, so old news is not told again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-news-'))
  addNews(dir, 'sync-ingest', 'the ingest step failed')
  assert.match(takeNews(dir, 'all'), /ingest step failed/)
  const old = new Date(Date.now() - 9 * 864e5)
  utimesSync(join(dir, 'hook-state', 'news-told'), old, old) // told nine days ago; news.jsonl was written since
  seen({ dir, cli: 'none' }, 's1', undefined, '/x/a.ts') // a file hint runs the sweep
  assert.equal(takeNews(dir, 'all'), '')
})
