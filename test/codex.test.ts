// Codex chats in one memory with Claude Code's: its rollout files in the transcript shape, its hook payloads, its plugin files.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { claudeHookInput } from '../src/ingest/copilot.ts'
import { codexConverter, codexSources } from '../src/ingest/codex.ts'
import { parseSession } from '../src/ingest/transcript.ts'
import { updateNotice } from '../src/setup/update.ts'

const line = (type: string, payload: object, ordinal = 1) => JSON.stringify({ timestamp: '2026-11-01T10:00:00.000Z', ordinal, type, payload })
const msg = (role: string, ...content: object[]) => line('response_item', { type: 'message', role, content })
const done = (item: object) => line('event_msg', { type: 'item_completed', item })
const convert = (...lines: string[]) => {
  const f = codexConverter('t1', '/work/repo')

  return lines.flatMap((l) => f(l)).map((o) => JSON.parse(o))
}
const meta = (id: string, cwd: string, more = {}) => line('session_meta', { id, cwd, source: 'cli', thread_source: 'user', ...more }, 0)

test('a typed prompt and a reply are kept, and the context Codex injects is not a prompt', () => {
  const rows = convert(
    msg('developer', { type: 'input_text', text: '<permissions instructions>...' }),
    msg('user', { type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd></environment_context>' }, { type: 'input_text', text: 'why is the cache sharded' }),
    msg('user', { type: 'input_text', text: '<skill>\nbody</skill>' }),
    msg('user', { type: 'input_text', text: '# AGENTS.md instructions for /x\nrules' }),
    msg('assistant', { type: 'output_text', text: 'Friday peaks.' }),
    line('response_item', { type: 'reasoning', encrypted_content: 'abc' }),
    line('token_usage_record', { usage: {} }),
  )
  assert.deepEqual(rows.map((r) => [r.type, r.message.content]), [['user', 'why is the cache sharded'], ['assistant', [{ type: 'text', text: 'Friday peaks.' }]]])
  assert.equal(rows[0].entrypoint, 'codex-cli')
  assert.equal(rows[0].cwd, '/work/repo')
})

test('finished items become the tools that link files, reads resolved against their folder', () => {
  const rows = convert(
    done({ type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'sed -n 1,9p src/a.ts'], cwd: '/work/repo', parsed_cmd: [{ type: 'read', path: 'src/a.ts' }], aggregated_output: 'text', exit_code: 0 }),
    done({ type: 'CommandExecution', id: 'c2', command: ['/bin/zsh', '-lc', 'npm test'], cwd: '/work/repo', parsed_cmd: [{ type: 'unknown', cmd: 'npm test' }], aggregated_output: 'boom', exit_code: 1 }),
    done({ type: 'FileChange', id: 'f1', changes: { '/work/repo/new.ts': { type: 'add', content: 'x' }, '/work/repo/old.ts': { type: 'update', unified_diff: '--- a\n+++ b\n-before\n+after\n' } } }),
    done({ type: 'McpToolCall', id: 'm1', server: 'docs', tool: 'find', arguments: { q: 'x' } }),
    done({ type: 'Reasoning', id: 'r1' }),
  )
  const uses = rows.flatMap((r) => (r.type === 'assistant' ? r.message.content : []))
  assert.deepEqual(uses[0].input, { file_path: join('/work/repo', 'src/a.ts') })
  assert.equal(uses[1].input.command, 'npm test')
  assert.deepEqual([uses[2].name, uses[2].input.content], ['Write', 'x'])
  assert.deepEqual([uses[3].name, uses[3].input.old_string, uses[3].input.new_string], ['Edit', 'before', 'after'])
  assert.equal(uses[4].name, 'mcp__docs__find')
  assert.equal(rows.find((r) => r.type === 'user' && r.message.content[0].tool_use_id === 'c2').message.content[0].is_error, true)
})

test('current Codex writes its folder as a file URL: reads, changes, the chat folder and its project all come out as plain paths', () => {
  const folder = resolve('/work/repo')
  const url = pathToFileURL(folder).href
  const rows = convert(
    line('turn_context', { cwd: url }),
    done({ type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'cat notes.md'], cwd: url, parsed_cmd: [{ type: 'read', path: 'notes.md' }], aggregated_output: 'x', exit_code: 0 }),
    done({ type: 'FileChange', id: 'f1', changes: { [pathToFileURL(join(folder, 'new.ts')).href]: { type: 'add', content: 'x' } } }),
    msg('user', { type: 'input_text', text: 'hi' }),
  )
  const uses = rows.flatMap((r) => (r.type === 'assistant' ? r.message.content : []))
  assert.equal(uses[0].input.file_path, join(folder, 'notes.md'))
  assert.equal(uses[1].input.file_path, join(folder, 'new.ts'))
  assert.equal(rows.at(-1).cwd, folder)
  assert.doesNotMatch(JSON.stringify(rows), /file:/)
  const home = mkdtempSync(join(tmpdir(), 'tw-codex-url-'))
  const saved = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(home, 'codex')
  try {
    const day = join(home, 'codex', 'sessions', '2026', '11', '01')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), `${meta('T-url', url)}\n`)
    writeFileSync(join(day, 'rollout-b.jsonl'), `${meta('T-remote', 'file://other-host/x')}\n`)
    // On Windows a file URL with a host is a network share (\\\\other-host\\x); elsewhere it names no local file and stays out.
    const remote = process.platform === 'win32' ? [['T-remote', '\\\\other-host\\x']] : []
    assert.deepEqual(codexSources(home).map((x) => [x.id, x.cwd]), [['T-url', folder], ...remote])
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  }
})

test('older files: shell and patch calls are read, and code mode exec and wait add nothing', () => {
  const rows = convert(
    line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{"cmd":"ls"}' }),
    line('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b', input: '*** Begin Patch\n*** Update File: x.ts\n-a\n+b\n*** End Patch' }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'tools.foo()' }),
    line('response_item', { type: 'custom_tool_call_output', name: 'exec', call_id: 'c', output: 'hidden' }),
    line('response_item', { type: 'function_call', name: 'wait', call_id: 'd', arguments: '{}' }),
  )
  assert.deepEqual(rows.flatMap((r) => r.message.content.map((b: any) => b.name)), ['Bash', 'Edit'])
})

test('a plain compaction summary is kept, and an encrypted one has nothing to keep', () => {
  assert.equal(convert(line('compacted', { message: 'We chose shards.' }))[0].isCompactSummary, true)
  assert.deepEqual(convert(line('compacted', { message: '', replacement_history: [{ type: 'compaction', encrypted_content: 'x' }] })), [])
})

test('a broken line stays as text, and a folder change follows the chat', () => {
  const f = codexConverter('t1', '/one')
  assert.deepEqual(f('not json'), ['not json'])
  f(line('turn_context', { cwd: '/two' }))
  assert.equal(JSON.parse(f(msg('user', { type: 'input_text', text: 'hi' }))[0]!).cwd, '/two')
})

test('sources: chats join their project; subagents and imports stay out; a thread counts once', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-codex-'))
  const saved = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(home, 'codex')
  try {
    const day = join(home, 'codex', 'sessions', '2026', '11', '01')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(home, 'codex', 'archived_sessions'))
    const put = (dir: string, name: string, first: string) => writeFileSync(join(dir, `rollout-${name}.jsonl`), `${first}\n`)
    put(day, 'a', meta('T-main', '/work/repo'))
    put(day, 'b', meta('T-sub', '/work/repo', { thread_source: 'subagent' }))
    put(day, 'c', meta('T-spawn', '/work/repo', { source: { subagent: { thread_spawn: {} } } }))
    put(day, 'd', meta('11111111-2222-3333-4444-555555555555', '/work/repo'))
    put(day, 'old', meta('T-rev', '/work/repo'))
    utimesSync(join(day, 'rollout-old.jsonl'), 1000, 1000)
    put(join(home, 'codex', 'archived_sessions'), 'new', meta('T-rev', '/work/other'))
    put(day, 'e', 'not json')
    writeFileSync(join(home, 'codex', 'external_agent_session_imports.json'), '{"imports":{"/x":"11111111-2222-3333-4444-555555555555"}}')
    const s = codexSources(home).sort((a, b) => (a.id < b.id ? -1 : 1))
    assert.deepEqual(s.map((x) => [x.id, x.cwd, x.rel]), [['T-main', '/work/repo', '-work-repo/T-main.jsonl'], ['T-rev', '/work/other', '-work-other/T-rev.jsonl']])
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  }
})

test('a Codex hook payload reads like the others: a patch names its file', () => {
  const i = claudeHookInput({ session_id: 's', cwd: '/w', hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: x.ts\n-a\n+b\n*** End Patch' } })
  assert.equal(i.tool_name, 'Edit')
  assert.equal(i.tool_input.file_path, 'x.ts')
  const b = claudeHookInput({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.equal(b.tool_input.command, 'ls')
})

test('Codex plugin files: one version, no pre-edit hook, the server starts in the plugin folder', () => {
  const read = (f: string) => JSON.parse(readFileSync(resolve(f), 'utf8'))
  assert.equal(read('.codex-plugin/plugin.json').version, read('package.json').version)
  assert.equal(read('.codex-plugin/plugin.json').hooks, './hooks/codex.json')
  assert.ok(!('PreToolUse' in read('hooks/codex.json').hooks))
  const server = read('.mcp.codex.json').mcpServers.thenwise
  assert.equal(server.cwd, '.')
  assert.ok(server.env_vars.includes('PWD') && server.env_vars.includes('THENWISE_HOME'))
})

test('under Codex the update notice names Codex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-codex-up-'))
  writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ latest: '9.9.9', ran: '0.1.0', checked: Date.now() }))
  const saved = process.env.PLUGIN_ROOT
  process.env.PLUGIN_ROOT = '/p'
  try {
    assert.match(updateNotice({ memDir: dir, updateCheck: true } as never, '0.1.0'), /codex plugin marketplace upgrade thenwise/)
  } finally {
    if (saved === undefined) delete process.env.PLUGIN_ROOT
    else process.env.PLUGIN_ROOT = saved
  }
})

test('a completed memory tool call or file change is a finished step, never the step a chat stopped in (live check, 2026-11-04)', () => {
  const lines = [
    msg('user', { type: 'input_text', text: 'call memory_resume' }),
    done({ type: 'FileChange', id: 'f1', changes: { '/work/repo/a.ts': { type: 'add', content: 'x' } } }),
    done({ type: 'McpToolCall', id: 'm1', server: 'thenwise', tool: 'memory_resume', arguments: {} }),
  ]
  const f = codexConverter('t1', '/work/repo')
  const s = parseSession(lines.flatMap((l) => f(l)), 't1', '/home/u')
  assert.equal(s.openCall, undefined)
})

test('one command that reads two files finishes both reads (live check, 2026-11-04)', () => {
  const lines = [
    msg('user', { type: 'input_text', text: 'look at the cache' }),
    done({ type: 'CommandExecution', id: 'c1', cwd: '/work/repo', command: ['bash', '-lc', 'cat src/a.ts src/b.ts'], parsed_cmd: [{ type: 'read', path: 'src/a.ts' }, { type: 'read', path: 'src/b.ts' }], aggregated_output: 'x', exit_code: 0 }),
  ]
  const f = codexConverter('t1', '/work/repo')
  const s = parseSession(lines.flatMap((l) => f(l)), 't1', '/home/u')
  assert.equal(s.openCall, undefined)
  assert.equal(s.turns[0]!.reads.size, 2)
})
