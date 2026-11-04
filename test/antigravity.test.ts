// Antigravity chats in one memory with the other tools': its transcript lines, its hook payloads, its plugin files.
// Line shapes as Antigravity 2.28.2 and agy 1.4.12 wrote them in live runs, trimmed.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { antigravityConverter, antigravitySources } from '../src/ingest/antigravity.ts'
import { claudeHookInput } from '../src/ingest/copilot.ts'
import { nothingToDo } from '../src/hooks/entry.ts'
import { runHook } from '../src/hooks/hook.ts'
import { createServer, serveStdio } from '../src/server/stdio.ts'

let n = 0
const step = (type: string, more: object) => JSON.stringify({ step_index: n++, source: 'MODEL', status: 'DONE', created_at: '2026-11-01T15:19:00Z', type, ...more })
const user = (text: string) => step('USER_INPUT', { source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is now.\n</ADDITIONAL_METADATA>` })
const convert = (...lines: string[]) => {
  const f = antigravityConverter('c1', '/work/repo')

  return lines.flatMap((l) => f(l)).map((o) => JSON.parse(o))
}

test('a prompt loses its wrapper, a reply is kept, and hook-injected or system steps are not chat', () => {
  const rows = convert(
    user('why is the cache sharded'),
    step('EPHEMERAL_MESSAGE', { source: 'SYSTEM_SDK', content: 'memory brief' }),
    step('SYSTEM_MESSAGE', { content: 'system text' }),
    step('USER_INPUT', { source: 'USER_EXPLICIT', content: '<USER_SETTINGS_CHANGE>model</USER_SETTINGS_CHANGE>' }),
    step('PLANNER_RESPONSE', { content: 'Friday peaks.', thinking: 'never kept' }),
  )
  assert.deepEqual(rows.map((r) => [r.type, r.message.content]), [['user', 'why is the cache sharded'], ['assistant', [{ type: 'text', text: 'Friday peaks.' }]]])
  assert.equal(rows[0].entrypoint, 'antigravity')
  assert.equal(rows[0].cwd, '/work/repo')
  assert.doesNotMatch(JSON.stringify(rows), /never kept|memory brief|system text/)
})

test('its tools become the tools that link files, and a result answers the call before it', () => {
  const rows = convert(
    user('change it'),
    step('PLANNER_RESPONSE', { content: '', tool_calls: [{ name: 'read_file', args: { Path: '/work/repo/a.ts' } }] }),
    step('GENERIC', { content: 'Showing lines 1-1' }),
    step('PLANNER_RESPONSE', { content: '', tool_calls: [{ name: 'edit_file', args: { Path: '/work/repo/a.ts', Target: 'old', Replacement: 'new' } }] }),
    step('GENERIC', { content: 'Made 1 replacement', status: 'ERROR' }),
    step('PLANNER_RESPONSE', { content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }, { name: 'call_mcp_tool', args: { ServerName: 'docs', ToolName: 'find', Arguments: { q: 'x' } } }, { name: 'write_to_file', args: { TargetFile: '/work/repo/n.ts', CodeContent: 'x' } }] }),
  )
  const uses = rows.flatMap((r) => (r.type === 'assistant' ? r.message.content : []))
  assert.deepEqual(uses.map((u: any) => u.name), ['Read', 'Edit', 'Bash', 'mcp__docs__find', 'Write'])
  assert.equal(uses[0].input.file_path, '/work/repo/a.ts')
  assert.deepEqual([uses[1].input.old_string, uses[1].input.new_string], ['old', 'new'])
  assert.equal(uses[2].input.command, 'npm test')
  assert.deepEqual([uses[4].input.file_path, uses[4].input.content], ['/work/repo/n.ts', 'x'])
  const results = rows.filter((r) => r.type === 'user' && Array.isArray(r.message.content)).map((r) => r.message.content[0])
  assert.equal(results[0].tool_use_id, uses[0].id)
  assert.equal(results[1].is_error, true)
  assert.equal(new Set(uses.map((u: any) => u.id)).size, uses.length)
})

test('reading its own tool definitions links no file', () => {
  const rows = convert(step('PLANNER_RESPONSE', { content: '', tool_calls: [{ name: 'read_file', args: { Path: '/home/me/.gemini/antigravity-cli/mcp/x/ping.json' } }] }))
  assert.deepEqual(rows, [])
})

test('a broken line stays as text', () => {
  assert.deepEqual(antigravityConverter('c', '/w')('not json'), ['not json'])
})

test('sources: a chat with no workspace takes the git root of the first file it names, outside Antigravity\'s own folders', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-agy-'))
  const repo = join(home, 'work', 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  const chat = (dir: string, id: string, lines: string[]) => {
    const logs = join(home, '.gemini', dir, 'brain', id, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), `${lines.join('\n')}\n`)
  }
  chat('antigravity', 'a1', [user('hi'), step('PLANNER_RESPONSE', { tool_calls: [{ name: 'read_file', args: { Path: join(home, '.gemini', 'antigravity-cli', 'mcp', 'x.json') } }, { name: 'read_file', args: { Path: join(repo, 'src', 'a.ts') } }] })])
  chat('antigravity-cli', 'c1', [user('nothing named')])
  const s = antigravitySources(home).sort((a, b) => (a.id < b.id ? -1 : 1))
  assert.deepEqual(s.map((x) => [x.id, x.cwd]), [['a1', repo], ['c1', home]])
  assert.equal(s[0]!.rel, `${repo.replace(/[^A-Za-z0-9]/g, '-')}/a1.jsonl`)
  assert.deepEqual(antigravitySources(mkdtempSync(join(tmpdir(), 'tw-agy-none-'))), [])
})

const hook = (more: object) => ({ conversationId: 'c1', workspacePaths: ['/work/repo'], transcriptPath: '/t.jsonl', modelName: 'm', lastUserInput: 'why did we split it', ...more })

test('a hook payload reads like the others: session, folder, prompt and tool', () => {
  const start = claudeHookInput(hook({}))
  assert.deepEqual([start.session_id, start.cwd, start.source, start.prompt], ['c1', '/work/repo', 'startup', 'why did we split it'])
  const read = claudeHookInput(hook({ stepIdx: 4, toolCall: { name: 'read_file', args: { Path: '/work/repo/a.ts' } } }))
  assert.deepEqual([read.tool_name, read.tool_input.file_path], ['Read', '/work/repo/a.ts'])
  const cmd = claudeHookInput(hook({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }))
  assert.deepEqual([cmd.tool_name, cmd.tool_input.command], ['Bash', 'ls'])
})

test('the prompt hook runs once per turn: later model calls in that turn have nothing to do', () => {
  assert.equal(nothingToDo('prompt', claudeHookInput(hook({ invocationNum: 0, lastUserInput: 'why did we split it' }))), false)
  assert.equal(nothingToDo('prompt', claudeHookInput(hook({ invocationNum: 3, lastUserInput: 'why did we split it' }))), true)
})

test('every hook prints valid JSON under Antigravity, because empty output is not safe there', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-agy-hook-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, THENWISE_HOME: join(home, 'data'), THENWISE_SYNC: 'off', ANTIGRAVITY_CONVERSATION_ID: 'c1' }
  const run = (name: string, input: object) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'hook', name], { input: JSON.stringify(input), encoding: 'utf8', env })
  for (const [name, input] of [['prompt', hook({ invocationNum: 0, lastUserInput: 'hello' })], ['read', hook({ toolCall: { name: 'run_command', args: {} } })], ['post', hook({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } })], ['session-end', hook({})]] as const) {
    const r = run(name, input)
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    assert.deepEqual(JSON.parse(r.stdout), {}, name)
  }
  const start = JSON.parse(run('session-start', hook({})).stdout)
  assert.ok('injectSteps' in start || Object.keys(start).length === 0)
  assert.ok(!('hookSpecificOutput' in start) && !('additionalContext' in start))
})

test('the memory server asks for the project when the client offers roots, and scopes to it', async () => {
  const out: string[] = []
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]
  const { Readable } = await import('node:stream')
  await serveStdio(Readable.from(lines.map((l) => `${JSON.stringify(l)}\n`)), { write: (s: string) => out.push(s) }, () => '/none')
  const asked = out.map((l) => JSON.parse(l)).find((m) => m.method === 'roots/list')
  assert.ok(asked, 'the server sent roots/list')
  const early = createServer(() => '/none')
  early.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: {} } } })
  assert.equal(early.pending(), null, 'nothing is asked before the client says it is initialized')
  early.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(early.pending()?.method, 'roots/list')
  early.close()
  const s = createServer(() => '/none')
  s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } })
  s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(s.pending(), null, 'a client without roots is never asked')
  s.close()
})

test('the install line names the plugin/ folder: it holds the built code, and agy ignores #branch', () => {
  for (const f of ['README.md', 'CHANGELOG.md', 'src/setup/doctor.ts', 'src/setup/update.ts']) {
    for (const m of readFileSync(resolve(f), 'utf8').matchAll(/agy plugin install (\S+)/g)) assert.match(m[1]!, /\/tree\/main\/plugin(?![\w/])/, f)
  }
})

test('Antigravity plugin files: one version, native layout, no pre-edit hook, no field its strict schema rejects', () => {
  const read = (f: string) => JSON.parse(readFileSync(resolve(f), 'utf8'))
  const manifest = read('.antigravity-plugin/plugin.json')
  assert.equal(manifest.version, read('package.json').version)
  for (const k of ['hooks', 'mcpServers', 'commands']) assert.ok(!(k in manifest), k)
  const hooks = read('hooks.json').thenwise
  assert.equal(hooks.enabled, true)
  assert.ok(!('PreToolUse' in hooks))
  assert.deepEqual(read('mcp_config.json').mcpServers.thenwise.args, ['./dist/cli.js', 'mcp'])
})

test('Antigravity Stop fires after every model loop: it starts a sync only when fully idle, and at most every ten minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-agy-stop-'))
  const keep = { ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID, THENWISE_SYNC: process.env.THENWISE_SYNC }
  Object.assign(process.env, { ANTIGRAVITY_CONVERSATION_ID: 'c1', THENWISE_SYNC: 'off' })
  // The hook touches this stamp exactly when it lets a sync start.
  const stamp = join(dir, 'hook-state', 'antigravity-sync') // its own stamp: the team stop hooks keep stop-sync
  try {
    const env = { dir, cli: resolve('src/cli.ts') }
    assert.equal(claudeHookInput(hook({ fullyIdle: false })).fullyIdle, false)
    assert.equal(runHook('session-end', claudeHookInput(hook({ fullyIdle: false })), env), '')
    assert.ok(!existsSync(stamp), 'a loop that is not the end of the turn starts nothing')
    runHook('session-end', claudeHookInput(hook({ fullyIdle: true })), env)
    assert.ok(existsSync(stamp), 'the end of a turn starts a sync')
    const old = new Date(Date.now() - 60_000)
    utimesSync(stamp, old, old)
    runHook('session-end', claudeHookInput(hook({ fullyIdle: true })), env)
    assert.equal(statSync(stamp).mtimeMs, old.getTime(), 'a turn a minute later starts nothing')
    const stale = new Date(Date.now() - 11 * 60_000)
    utimesSync(stamp, stale, stale)
    runHook('session-end', claudeHookInput(hook({ fullyIdle: true })), env)
    assert.ok(statSync(stamp).mtimeMs > stale.getTime(), 'ten minutes later the next turn syncs again')
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test("the chat's workspace comes from Antigravity's index, read without leaving files in its folder", async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const home = mkdtempSync(join(tmpdir(), 'tw-agy-idx-'))
  const dir = join(home, '.gemini', 'antigravity-cli')
  const logs = join(dir, 'brain', 'C1', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript_full.jsonl'), `${user('hi')}\n`)
  const db = new DatabaseSync(join(dir, 'conversation_summaries.db'))
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT); INSERT INTO conversation_summaries VALUES ('C1', '${JSON.stringify([pathToFileURL(resolve('/work/repo')).href])}')`)
  db.close()
  const before = readdirSync(dir).sort()
  assert.equal(antigravitySources(home)[0]?.cwd, resolve('/work/repo'))
  assert.deepEqual(readdirSync(dir).sort(), before)
})

test('a slash command typed in Antigravity is not stored as a question; a prompt that starts with a path is', () => {
  assert.deepEqual(convert(user('/compact')), [])
  assert.deepEqual(convert(user('/compact focus on the cache')), [])
  assert.equal(convert(user('/Users/me/repo/a.ts: why is this split'))[0].message.content, '/Users/me/repo/a.ts: why is this split')
})
