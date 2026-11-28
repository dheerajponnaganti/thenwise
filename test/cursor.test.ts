// Cursor chats in one memory with Claude Code's: its agent transcripts in the transcript shape, joined to the right project.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'

import { claudeHookInput, projectKey } from '../src/ingest/copilot.ts'
import { cursorConverter, cursorKey, cursorSources, cursorTool, folderOfKey, promptTime, spelledBack } from '../src/ingest/cursor.ts'
import { parseSession } from '../src/ingest/transcript.ts'

const prompt = (text: string, when = 'Saturday, Nov 28, 2026, 3:42 PM (UTC+5:30)') =>
  JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>${when}</timestamp>\n<user_query>\n${text}\n</user_query>` }] } })
const reply = (...content: object[]) => JSON.stringify({ role: 'assistant', message: { content } })
const tool = (name: string, input: object) => ({ type: 'tool_use', name, input })
const convert = (...lines: string[]) => {
  const f = cursorConverter('c1', '/work/repo')

  return lines.flatMap((l) => f(l)).map((o) => JSON.parse(o))
}

test('the typed prompt is kept without Cursor tags, and every row carries the prompt time', () => {
  const rows = convert(prompt('why is the cache sharded'), reply({ type: 'text', text: 'Friday peaks.' }), JSON.stringify({ type: 'turn_ended', status: 'success' }))
  assert.deepEqual(rows.map((r) => [r.type, r.message.content]), [['user', 'why is the cache sharded'], ['assistant', [{ type: 'text', text: 'Friday peaks.' }]]])
  assert.equal(rows[0].entrypoint, 'cursor')
  assert.equal(rows[0].cwd, '/work/repo')
  assert.equal(rows[0].timestamp, '2026-11-28T10:12:00.000Z')
  assert.equal(rows[1].timestamp, rows[0].timestamp)
})

test('prompt times: offsets either way, noon and midnight, and no tag at all', () => {
  assert.equal(promptTime('<timestamp>Monday, Jan 5, 2026, 12:07 AM (UTC-4)</timestamp>'), '2026-01-05T04:07:00.000Z')
  assert.equal(promptTime('<timestamp>Monday, Jan 5, 2026, 12:07 PM (UTC)</timestamp>'), '2026-01-05T12:07:00.000Z')
  assert.equal(promptTime('just text'), undefined)
})

test('Cursor tools become the Claude Code tools that link files: Read, StrReplace, Write and Shell', () => {
  const rows = convert(
    prompt('fix add'),
    reply({ type: 'text', text: 'Reading.' }, tool('Read', { path: '/work/repo/math.js' })),
    reply(tool('StrReplace', { path: '/work/repo/math.js', old_string: 'a + b', new_string: 'a - b' })),
    reply(tool('Write', { path: '/work/repo/new.js', contents: 'x' })),
    reply(tool('Shell', { command: 'node math.test.mjs', description: 'run' })),
  )
  const uses = rows.filter((r) => r.type === 'assistant').flatMap((r) => r.message.content.filter((c: any) => c.type === 'tool_use'))
  assert.deepEqual(uses.map((u: any) => [u.name, u.input]), [
    ['Read', { file_path: '/work/repo/math.js' }],
    ['Edit', { file_path: '/work/repo/math.js', old_string: 'a + b', new_string: 'a - b' }],
    ['Write', { file_path: '/work/repo/new.js', content: 'x' }],
    ['Bash', { command: 'node math.test.mjs' }],
  ])
  // each call gets its result row at once, so none reads as the step the chat stopped in
  const results = rows.filter((r) => r.type === 'user' && Array.isArray(r.message.content)).flatMap((r) => r.message.content.map((c: any) => c.tool_use_id))
  assert.deepEqual(results, uses.map((u: any) => u.id))
  assert.deepEqual(cursorTool('Grep', { pattern: 'x' }), { name: 'Grep', input: { pattern: 'x' } })
})

test('a broken line stays as text, and a parsed chat holds its prompt, reads, edits and commands', () => {
  const lines = convert(prompt('fix add'), reply(tool('Read', { path: '/work/repo/math.js' })), reply(tool('StrReplace', { path: '/work/repo/math.js', old_string: 'a', new_string: 'b' })), reply(tool('Shell', { command: 'node /work/repo/math.test.mjs' })), reply({ type: 'text', text: 'Done.' }))
  assert.deepEqual(cursorConverter('c1', '/w')('not json'), ['not json'])
  const s = parseSession(lines.map((l) => JSON.stringify(l)), 'c1', '/home/u')
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0]!.prompt, 'fix add')
  assert.ok(s.turns[0]!.reads.has('/work/repo/math.js'))
  assert.ok(s.turns[0]!.edits.has('/work/repo/math.js'))
  assert.ok(s.turns[0]!.ran.has('/work/repo/math.test.mjs')) // ran holds the paths a command names
})

test("Cursor's lossy folder key comes back as the exact folder, dots, spaces and dashes included", () => {
  // The long path, as Cursor keys the folder it opened: Windows CI's temp folder is a short name (RUNNER~1) no listing shows.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-cursor-key-')))
  const folder = join(root, 'my.app v2', 'web-ui')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(root, 'my-app-v2'), { recursive: true }) // a sibling whose key is a prefix match of nothing here
  assert.equal(cursorKey(folder), cursorKey(root) + '-my-app-v2-web-ui')
  assert.equal(folderOfKey(cursorKey(folder)), folder)
  assert.equal(folderOfKey(cursorKey(join(root, 'gone'))), '')
})

test('a key whose folder is gone is spelled back as a path on this system, drive included on Windows', () => {
  assert.equal(spelledBack('C-Users-dev-repo'), sep === '\\' ? 'C:\\Users\\dev\\repo' : '/C/Users/dev/repo')
  assert.equal(spelledBack('Users-dev-repo'), sep === '\\' ? 'Users\\dev\\repo' : '/Users/dev/repo')
})

test('sources: each transcript joins its folder as Claude Code keys it; a no-folder chat joins home; other files stay out', () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-cursor-home-')))
  const folder = join(home, 'code', 'proj.a')
  mkdirSync(folder, { recursive: true })
  const put = (key: string, id: string, name = `${id}.jsonl`) => {
    const d = join(home, '.cursor', 'projects', key, 'agent-transcripts', id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, name), prompt('hi') + '\n')
  }
  put(cursorKey(folder), '2f4691c6-7300-4674-b634-5b1d9dfa7575')
  put('empty-window', '0a1b2c3d-0000-0000-0000-000000000000')
  put(cursorKey(folder), 'notes', 'notes.jsonl') // not a chat id
  put(cursorKey(folder), 'aaaaaaaa-0000-0000-0000-000000000000', 'other.jsonl') // no <id>.jsonl inside
  const got = cursorSources(home).sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(got.map((s) => [s.id, s.cwd, s.rel]), [
    ['0a1b2c3d-0000-0000-0000-000000000000', home, `${projectKey(home)}/0a1b2c3d-0000-0000-0000-000000000000.jsonl`],
    ['2f4691c6-7300-4674-b634-5b1d9dfa7575', folder, `${projectKey(folder)}/2f4691c6-7300-4674-b634-5b1d9dfa7575.jsonl`],
  ])
})

// ---- hooks: Cursor sends one payload of its own to every hook, whichever file registered it ----

const cli = resolve('src/cli.ts')
const cursorPayload = (event: string, more: object = {}) => ({ conversation_id: 'cur-1', session_id: 'cur-1', generation_id: 'g', model: 'm', hook_event_name: event, cursor_version: '2026.11.22-e9042b2', workspace_roots: ['/work/repo'], user_email: 'someone@example.com', transcript_path: null, ...more })
const hookRun = (name: string, payload: unknown, dir: string, raw = false) =>
  spawnSync(process.execPath, [cli, 'hook', name], { input: raw ? String(payload) : JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, THENWISE_HOME: dir, HOME: dir, THENWISE_SYNC: 'off', CLAUDE_PLUGIN_ROOT: '/somewhere' } })

test('a Cursor payload reads like Claude Code: folder from the workspace, events and tools renamed, the email dropped', () => {
  const start = claudeHookInput(cursorPayload('sessionStart'))
  assert.equal(start.hook_event_name, 'SessionStart')
  assert.equal(start.source, 'startup')
  assert.equal(start.cwd, '/work/repo')
  assert.equal(start.session_id, 'cur-1')
  assert.equal(start.user_email, undefined)
  assert.ok(!JSON.stringify(start).includes('someone@example.com'))
  const shell = claudeHookInput(cursorPayload('postToolUseFailure', { tool_name: 'Shell', tool_input: { command: 'npm test', cwd: '' }, cwd: '' }))
  assert.deepEqual([shell.hook_event_name, shell.tool_name, shell.tool_input, shell.cwd], ['PostToolUseFailure', 'Bash', { command: 'npm test' }, '/work/repo'])
  const read = claudeHookInput(cursorPayload('postToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/repo/a.ts' } }))
  assert.deepEqual([read.tool_name, read.tool_input], ['Read', { file_path: '/work/repo/a.ts' }])
})

test('Cursor gets its own reply shape and always JSON: a guide at the start, {} when there is nothing to say, a BOM read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cursor-hook-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ exclude_projects: ['*'] }))
  const a = hookRun('session-start', cursorPayload('sessionStart'), dir)
  assert.equal(a.status, 0)
  const out = JSON.parse(a.stdout)
  assert.match(out.additional_context, /memory_\* tools/)
  assert.equal(out.hookSpecificOutput, undefined, 'never the Claude Code shape, though CLAUDE_PLUGIN_ROOT is set')
  assert.equal(out.systemMessage, undefined)
  const b = hookRun('post', cursorPayload('postToolUse', { tool_name: 'Write', tool_input: { file_path: '/work/repo/x.js' } }), dir)
  assert.deepEqual(JSON.parse(b.stdout), {})
  const c = hookRun('stop', cursorPayload('stop', { status: 'completed' }), dir)
  assert.deepEqual(JSON.parse(c.stdout), {})
  const d = hookRun('session-start', '﻿' + JSON.stringify(cursorPayload('sessionStart', { session_id: 'cur-bom', conversation_id: 'cur-bom' })), dir, true)
  assert.match(JSON.parse(d.stdout).additional_context, /memory_\* tools/)
})

test('two Thenwise installs in Cursor run every hook: the second session start of a session says nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cursor-twice-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ exclude_projects: ['*'] }))
  const first = JSON.parse(hookRun('session-start', cursorPayload('sessionStart', { session_id: 'cur-2', conversation_id: 'cur-2' }), dir).stdout)
  const second = JSON.parse(hookRun('session-start', cursorPayload('sessionStart', { session_id: 'cur-2', conversation_id: 'cur-2' }), dir).stdout)
  assert.match(first.additional_context, /memory_\* tools/)
  assert.deepEqual(second, {})
})

test('the Cursor plugin entry: its manifest names a Cursor-format hooks file with no permission hook, and ships in plugin/', async () => {
  const manifest = JSON.parse(readFileSync('.cursor-plugin/plugin.json', 'utf8'))
  assert.equal(manifest.hooks, './hooks/cursor.json')
  assert.equal(manifest.version, JSON.parse(readFileSync('package.json', 'utf8')).version)
  const { version, hooks } = JSON.parse(readFileSync('hooks/cursor.json', 'utf8'))
  assert.equal(version, 1)
  assert.ok(Object.keys(hooks).every((e) => !/^(pre|before)/.test(e)), 'a broken install must never block a Cursor action')
  for (const h of Object.values(hooks).flat() as any[]) assert.match(h.command, /^node "\$\{CURSOR_PLUGIN_ROOT\}\/dist\/cli\.js" hook [a-z-]+$/)
  // @ts-expect-error a plain script with no types
  const { PLUGIN_FILES } = await import('../scripts/plugin-folder.mjs')
  assert.ok(PLUGIN_FILES.includes('.cursor-plugin'))
})

test('doctor sees a Cursor install, and notes when Cursor also loads Claude Code\'s copy, so each hook runs twice', async () => {
  const { runDoctor } = await import('../src/setup/doctor.ts')
  const home = mkdtempSync(join(tmpdir(), 'tw-cursor-doc-'))
  mkdirSync(join(home, '.cursor/plugins/cache/thenwise/thenwise'), { recursive: true })
  const find = async (name: string) => (await runDoctor(home, { gh: () => true, mcp: () => true })).find((c) => c.name === name)
  assert.equal((await find('plugin'))!.ok, true)
  assert.equal(await find('cursor'), undefined, 'one install: nothing to say')
  mkdirSync(join(home, '.claude/plugins'), { recursive: true })
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'thenwise@thenwise': [{}] } }))
  const both = (await find('cursor')) as { ok: boolean; warn?: boolean; detail: string }
  assert.equal(both.ok, true)
  assert.equal(both.warn, true)
  assert.match(both.detail, /runs twice/)
})

test('#153: the memory server ignores a ${workspaceFolder} the Cursor CLI never filled in', async () => {
  const { filled } = await import('../src/server/stdio.ts')
  assert.equal(filled('${workspaceFolder}'), undefined)
  assert.equal(filled('/work/${env:HOME}/x'), undefined)
  assert.equal(filled('/work/repo'), '/work/repo')
  assert.equal(filled(undefined), undefined)
})

test('a Cursor shell run that failed reads as a failed test: the hook records it, masked, and the chat reader marks that call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-cursor-runs-'))
  const run = (event: string, id: string, more: object = {}) =>
    hookRun('post', cursorPayload(event, { tool_name: 'Shell', tool_input: { command: 'npm test', cwd: '' }, tool_use_id: id, ...more }), dir)
  assert.equal(run('postToolUseFailure', 't1', { error_message: 'AssertionError: 0 == 4 token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', failure_type: 'error' }).status, 0)
  run('postToolUseFailure', 't1', { error_message: 'AssertionError: 0 == 4', failure_type: 'error' }) // a second install, same run
  run('postToolUse', 't2', { tool_output: 'ok' })
  const kept = readFileSync(join(dir, 'cursor-runs', 'cur-1.jsonl'), 'utf8')
  assert.ok(!kept.includes('npm test'), 'the command is kept only as a hash')
  assert.ok(!kept.includes('ghp_abcdefghij'), 'the error is masked')
  const f = cursorConverter('cur-1', '/work/repo', dir)
  const lines = [prompt('fix add'), reply(tool('Shell', { command: 'npm test' })), reply(tool('StrReplace', { path: '/work/repo/a.js', old_string: 'a', new_string: 'b' })), reply(tool('Shell', { command: 'npm test' }))].flatMap(f)
  const results = lines.map((l) => JSON.parse(l)).filter((r) => r.type === 'user' && Array.isArray(r.message.content)).map((r) => r.message.content[0])
  assert.deepEqual(results.map((r) => r.is_error === true), [true, false, false], 'the first run failed, the later one passed')
  assert.match(results[0].content, /AssertionError/)
  const s = parseSession(lines, 'cur-1', dir)
  assert.deepEqual(s.turns[0]!.tests.map((t) => t.failed), [true, false])
})
