import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

import { compactedMark, nothingToDo } from '../src/hooks/entry.ts'
import { runHook } from '../src/hooks/hook.ts'
import { forget } from '../src/privacy/forget.ts'
import { runDoctor } from '../src/setup/doctor.ts'
import { discoverProjects } from '../src/setup/projects.ts'
import { asClaudeTool, claudeHookInput, copilotConverter, copilotSessionCwd } from '../src/ingest/copilot.ts'
import { parseSession } from '../src/ingest/transcript.ts'
import { normPath } from '../src/core/vault-index.ts'
import { World } from './world.ts'

// Event shapes as Copilot CLI 1.0.105 writes them (session-state/<id>/events.jsonl), trimmed to the fields Thenwise reads.
let n = 0
const ev = (type: string, data: object, at = '2026-10-29T12:54:40.000Z') => JSON.stringify({ type, data, id: `e${++n}`, parentId: null, timestamp: at })
function copilotChat(w: World, id: string, prompt: string, cwd = w.proj) {
  const dir = join(w.home, '.copilot/session-state', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nbranch: main\nname: '${prompt.slice(0, 20)}'\n`)
  const lines = [
    ev('session.start', { sessionId: id, copilotVersion: '1.0.105', context: { cwd, branch: 'main' } }),
    ev('hook.start', { hookType: 'sessionStart', input: { initialPrompt: prompt } }),
    ev('user.message', { content: prompt, transformedContent: `<current_datetime>x</current_datetime>\n\n${prompt}` }),
    ev('system.message', { content: 'You are Copilot. (system text is never kept)' }),
    ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c1', name: 'view', arguments: { path: join(cwd, 'src/a.ts') } }], encryptedContent: 'opaque' }),
    ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'a\n' } }),
    ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c2', name: 'apply_patch', arguments: `*** Begin Patch\n*** Update File: ${join(cwd, 'src/a.ts')}\n@@\n-a\n+b\n*** Add File: ${join(cwd, 'src/new.ts')}\n+hi\n*** End Patch\n` }] }),
    ev('tool.execution_complete', { toolCallId: 'c2', success: true, result: { content: 'Modified 1 file(s)' } }),
    ev('assistant.message', { content: '', toolRequests: [{ toolCallId: 'c3', name: 'bash', arguments: { command: 'git commit -m "Split the cache into eight shards"', description: 'commit' } }] }),
    ev('tool.execution_complete', { toolCallId: 'c3', success: true, result: { content: '[main 1a2b3c4] Split the cache into eight shards\n 1 file changed' } }),
    ev('assistant.message', { content: 'Split it so one file stops locking under load.', toolRequests: [] }, '2026-10-29T12:54:52.000Z'),
    ev('user.message', { content: 'skill text pushed into the chat', source: 'skill-pdf' }),
    ev('user.message', { content: 'continue', isAutopilotContinuation: true }),
    JSON.stringify({ type: 'user.message', data: { content: 'a subagent task prompt' }, id: `e${++n}`, parentId: null, timestamp: '2026-10-29T12:54:53.000Z', agentId: 'sub-1' }),
    ev('session.compaction_complete', { success: true, summaryContent: 'Summary: the cache was split into eight shards.', checkpointNumber: 1 }),
    ev('session.shutdown', { shutdownType: 'routine' }),
  ]
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)

  return `${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
}
const rows = (w: World, db: string, sql: string) => new DatabaseSync(w.path(db), { readOnly: true }).prepare(sql).all() as any[]

test('Copilot tools map to Claude Code tools; apply_patch becomes one change per file', () => {
  assert.deepEqual(asClaudeTool('view', { path: '/p/a.ts' }), [{ name: 'Read', input: { file_path: '/p/a.ts' } }])
  assert.deepEqual(asClaudeTool('bash', { command: 'ls', description: 'x' }), [{ name: 'Bash', input: { command: 'ls' } }])
  assert.deepEqual(asClaudeTool('edit', { path: '/p/a.ts', old_str: 'a', new_str: 'b' }), [{ name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } }])
  assert.deepEqual(asClaudeTool('create', { path: '/p/n.ts', file_text: 'x' }), [{ name: 'Write', input: { file_path: '/p/n.ts', content: 'x' } }])
  const patch = asClaudeTool('apply_patch', '*** Begin Patch\n*** Update File: /p/a.ts\n@@\n-a\n+b\n*** Add File: /p/n.ts\n+hi\n*** End Patch\n')
  assert.deepEqual(patch, [{ name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } }, { name: 'Write', input: { file_path: '/p/n.ts', content: 'hi' } }])
  assert.deepEqual(asClaudeTool('thenwise-memory_why', { query: 'q' }), [{ name: 'thenwise-memory_why', input: { query: 'q' } }])
})

test('a Copilot hook payload reads as Claude Code input; Claude Code input is unchanged', () => {
  const read = claudeHookInput({ toolName: 'view', toolArgs: '{"path":"/p/a.ts"}', cwd: '/p' })
  assert.equal(read.tool_name, 'Read')
  assert.equal(read.tool_input.file_path, '/p/a.ts')
  assert.equal(nothingToDo('read', read), false)
  // What Copilot sends with a Claude-format hooks file (recorded live): Claude's tool name, Copilot's argument name.
  const renamed = claudeHookInput({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { path: '/p/a.ts' } })
  assert.equal(renamed.tool_input.file_path, '/p/a.ts')
  assert.equal(nothingToDo('read', renamed), false)
  assert.equal(claudeHookInput({ sessionId: 'x' }).session_id, 'x')
  assert.equal(claudeHookInput({ hook_event_name: 'SessionStart', source: 'new' }).source, 'startup', 'Copilot\'s new session starts like startup')
  const claude = { tool_name: 'Read', tool_input: { file_path: '/p/a.ts' }, session_id: 's' }
  assert.deepEqual(claudeHookInput(claude), claude)
  assert.deepEqual(claudeHookInput({ prompt: 'hi' }), { prompt: 'hi' })
})

test('#98: a mask version bump keeps the turns a Copilot chat lost', () => {
  const w = new World()
  try {
    const rel = copilotChat(w, 'cp-m', 'why do we split the cache?')
    const file = join(w.home, '.copilot/session-state/cp-m/events.jsonl')
    const first = readFileSync(file, 'utf8')
    const archived = () => gunzipSync(readFileSync(join(w.memDir, 'archive/sessions', `${rel}.gz`))).toString('utf8')
    writeFileSync(file, `${first}${ev('user.message', { content: 'a prompt about zebras' })}\n${ev('assistant.message', { content: 'zebra reply', toolRequests: [] })}\n`)
    w.archive()
    writeFileSync(file, first.split('\n').slice(0, 3).join('\n') + '\n')
    w.archive()
    assert.match(archived(), /zebras/)

    // Text an older mask missed: a newer mask version must reach it in the kept copy.
    const key = 'sk-ant-api03-' + 'k'.repeat(90)
    const gz = join(w.memDir, 'archive/sessions', `${rel}.gz`)
    const plant = () => writeFileSync(gz, gzipSync(archived().replace('zebra reply', `zebra reply ${key}`)))
    plant()

    // A newer mask version: the shorter source must not replace the kept copy.
    const mf = join(w.memDir, 'archive/manifest.json')
    const manifest = JSON.parse(readFileSync(mf, 'utf8'))
    const mask = manifest[rel].mask
    manifest[rel].mask = mask - 1
    writeFileSync(mf, JSON.stringify(manifest))
    assert.equal(w.archive().remasked, 1)
    assert.match(archived(), /zebras/)
    assert.equal(JSON.parse(readFileSync(mf, 'utf8'))[rel].mask, mask)
    assert.ok(!archived().includes(key), 'the kept copy is masked again')

    // The source changes but still holds fewer turns: the kept copy is masked again in the same pass.
    const again = JSON.parse(readFileSync(mf, 'utf8'))
    again[rel].mask = mask - 1
    writeFileSync(mf, JSON.stringify(again))
    plant()
    writeFileSync(file, first.split('\n').slice(0, 4).join('\n') + '\n')
    assert.equal(w.archive().remasked, 1)
    assert.match(archived(), /zebras/)
    assert.equal(JSON.parse(readFileSync(mf, 'utf8'))[rel].mask, mask)
    assert.ok(!archived().includes(key))
  } finally {
    w.destroy()
  }
})

test('Copilot CLI chats are archived masked in Claude Code shape, then ingested; update equals rebuild', () => {
  const w = new World()
  try {
    const key = 'sk-ant-api03-' + 'x'.repeat(90)
    const rel = copilotChat(w, 'cp-1', `why do we split the cache? my key is ${key}`)
    const r = w.archive()
    assert.equal(r.archived, 1)
    const text = gunzipSync(readFileSync(join(w.memDir, 'archive/sessions', `${rel}.gz`))).toString('utf8')
    assert.ok(!text.includes(key), 'the key is masked')
    assert.ok(!/opaque|system text|hook\.start/.test(text), 'hooks, system text and encrypted reasoning are left out')
    const s = parseSession(text, 'cp-1', w.home)
    assert.equal(s.entrypoint, 'copilot-cli')
    assert.equal(s.cwd, w.proj)
    assert.equal(s.turns.length, 1)
    const t = s.turns[0]!
    assert.ok(t.reads.has(normPath(join(w.proj, 'src/a.ts'))))
    assert.deepEqual([...t.edits].sort(), [normPath(join(w.proj, 'src/a.ts')), normPath(join(w.proj, 'src/new.ts'))])
    assert.deepEqual(t.commitMsgs.map((c) => c.subject), ['Split the cache into eight shards'])
    assert.ok(t.commitShas.has('1a2b3c4'))
    assert.match(t.reply.join(' '), /stops locking under load/)
    assert.equal(s.turns.length, 1, 'skill, autopilot and subagent messages are not prompts')
    assert.deepEqual(s.summaries.map((m) => m.text), ['Summary: the cache was split into eight shards.'])

    const { a, b } = w.both()
    assert.equal(a, b)
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM nodes WHERE kind = 'session' AND id = 'ses:cp-1'")[0].n, 1)
    // A second run with nothing new reads nothing.
    assert.equal(w.archive().archived, 0)
  } finally {
    w.destroy()
  }
})

test('a Copilot /rewind drops the withdrawn turn from the archive and the store; a file that loses turns any other way keeps them', () => {
  const w = new World()
  try {
    const rel = copilotChat(w, 'cp-r', 'why do we split the cache?')
    const file = join(w.home, '.copilot/session-state/cp-r/events.jsonl')
    const first = readFileSync(file, 'utf8')
    const archived = () => gunzipSync(readFileSync(join(w.memDir, 'archive/sessions', `${rel}.gz`))).toString('utf8')
    const withdrawn = ev('user.message', { content: 'a withdrawn prompt about zebras' })
    const reply = ev('assistant.message', { content: 'zebra reply', toolRequests: [] })
    writeFileSync(file, `${first}${withdrawn}\n${reply}\n`)
    w.archive()
    w.both()
    assert.match(archived(), /zebras/)
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM nodes WHERE text LIKE '%zebra%'")[0].n > 0, true)

    // Shorter with no rewind marker: what was archived stays.
    writeFileSync(file, first.split('\n').slice(0, 3).join('\n') + '\n')
    assert.equal(w.archive().archived, 0)
    assert.match(archived(), /zebras/)

    // A rewind: the turn goes from the archive, then from the store, and update still equals rebuild.
    writeFileSync(file, `${first}${ev('session.info', { message: 'Rewound the conversation.', infoType: 'rewind' })}\n`)
    assert.equal(w.archive().archived, 1)
    assert.doesNotMatch(archived(), /zebra/)
    const { a, b } = w.both()
    assert.equal(a, b)
    assert.equal(rows(w, 'inc.db', "SELECT count(*) n FROM nodes WHERE text LIKE '%zebra%'")[0].n, 0)
  } finally {
    w.destroy()
  }
})

test('every Copilot tool that names a file or runs a command reads as its Claude Code twin', () => {
  assert.deepEqual(asClaudeTool('powershell', { command: 'git commit -m "x"' }), [{ name: 'Bash', input: { command: 'git commit -m "x"' } }])
  assert.deepEqual(asClaudeTool('str_replace_editor', { command: 'view', path: '/p/a.ts' }), [{ name: 'Read', input: { file_path: '/p/a.ts' } }])
  assert.deepEqual(asClaudeTool('str_replace_editor', { command: 'create', path: '/p/a.ts', file_text: 'x' }), [{ name: 'Write', input: { file_path: '/p/a.ts', content: 'x' } }])
  assert.deepEqual(asClaudeTool('str_replace_editor', { command: 'str_replace', path: '/p/a.ts', old_str: 'a', new_str: 'b' }), [{ name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } }])
  assert.equal(asClaudeTool('rg', { pattern: 'x' })[0]!.name, 'Grep')
  assert.equal(asClaudeTool('glob', { pattern: 'x' })[0]!.name, 'Glob')
  // A patch reaching a hook under the name Edit still names its file.
  const hook = claudeHookInput({ tool_name: 'Edit', tool_input: '*** Begin Patch\n*** Update File: /p/a.ts\n@@\n-a\n+b\n*** End Patch\n', session_id: 's' })
  assert.equal(hook.tool_name, 'Edit')
  assert.equal(hook.tool_input.file_path, '/p/a.ts')
})

test('a Windows Copilot chat links its commits like any other', () => {
  const lines = [
    { type: 'user', uuid: 'u', timestamp: '2026-10-01T10:00:00Z', cwd: 'C:/p', message: { role: 'user', content: 'commit' } },
    { type: 'assistant', uuid: 'a', timestamp: '2026-10-01T10:00:01Z', cwd: 'C:/p', message: { role: 'assistant', content: asClaudeTool('powershell', { command: 'git commit -m "Windows commit"' }).map((t) => ({ type: 'tool_use', id: 't', ...t })) } },
  ]
  assert.deepEqual(parseSession(lines.map((l) => JSON.stringify(l)).join('\n'), 's', 'C:/h').turns[0]!.commitMsgs.map((c) => c.subject), ['Windows commit'])
})

test('a Copilot chat marked [no-memory] is never kept', () => {
  const w = new World()
  try {
    copilotChat(w, 'cp-2', '[no-memory] try something private')
    const r = w.archive()
    assert.equal(r.archived, 0)
    assert.equal(r.excludedChats, 1)
  } finally {
    w.destroy()
  }
})

test('a folder only Copilot has worked in is found as a project', () => {
  const w = new World()
  try {
    const solo = join(w.home, 'copilot-only')
    copilotChat(w, 'cp-3', 'hello', solo)
    const found = discoverProjects(join(w.home, '.claude'))
    assert.ok(found.some((p) => p.folder === solo && p.chats === 1))
  } finally {
    w.destroy()
  }
})

test('answers from a Copilot chat say so', () => {
  const w = new World()
  try {
    copilotChat(w, 'cp-4', 'why do we split the cache into shards?')
    w.archive()
    w.ingest('inc.db')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), 'search', 'split the cache shards', '--db', w.path('inc.db'), '--all'], { encoding: 'utf8', env: { ...process.env, HOME: w.home, THENWISE_HOME: w.memDir } })
    assert.match(r.stdout, / · Copilot chat /)
  } finally {
    w.destroy()
  }
})

test('after Copilot compacts a chat, the next prompt carries the resume brief once; Claude Code is left to its own path', () => {
  const w = new World()
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, THENWISE_HOME: process.env.THENWISE_HOME, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT }
  try {
    copilotChat(w, 'cp-5', 'split the cache into eight shards')
    Object.assign(process.env, { HOME: w.home, USERPROFILE: w.home, THENWISE_HOME: w.memDir })
    const env = { dir: w.memDir, cli: resolve('src/cli.ts') }
    const input = { hook_event_name: 'PreCompact', session_id: 'cp-5', cwd: w.proj }

    delete process.env.COPILOT_PLUGIN_ROOT
    assert.equal(runHook('compact', input, env), '')
    assert.ok(!existsSync(compactedMark(w.memDir, 'cp-5')), 'Claude Code gets no mark')

    process.env.COPILOT_PLUGIN_ROOT = '/plugin'
    assert.equal(runHook('compact', input, env), '')
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cp-5', cwd: w.proj, prompt: 'carry on' }
    assert.equal(nothingToDo('prompt', prompt), false, 'a plain prompt still runs the hook when a resume is pending')
    const out = JSON.parse(runHook('prompt', prompt, env))
    assert.match(out.additionalContext, /split the cache into eight shards/)
    assert.match(out.additionalContext, /stops locking under load/)
    assert.ok(!existsSync(compactedMark(w.memDir, 'cp-5')))
    assert.equal(nothingToDo('prompt', prompt), true, 'only once')
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    w.destroy()
  }
})

test('Copilot CLI has its own manifest and hooks file: exec with args and no shell, and no preToolUse hook that could deny an edit', () => {
  const manifest = JSON.parse(readFileSync(resolve('.plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.hooks, 'hooks/copilot.json')
  assert.equal(manifest.version, JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version)
  const { hooks } = JSON.parse(readFileSync(resolve('hooks/copilot.json'), 'utf8'))
  // Copilot denies the tool call when a preToolUse hook errors, and an exec hook cannot guard itself with "|| exit 0".
  assert.equal(hooks.preToolUse, undefined)
  const entries = Object.values(hooks).flat() as any[]
  assert.ok(entries.length >= 5)
  for (const h of entries) {
    assert.equal(h.exec, 'node')
    assert.deepEqual(h.args.slice(0, 2), ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', 'hook'])
    assert.equal(h.command, undefined, 'no shell string')
    assert.ok(h.timeoutSec > 0 && h.timeoutSec <= 3)
  }
  // Claude Code keeps the file main shipped: its own tool names, the args form.
  const claude = JSON.parse(readFileSync(resolve('hooks/hooks.json'), 'utf8')).hooks
  assert.equal(claude.PreToolUse[0].matcher, '^(Write|Edit|MultiEdit)$')
  assert.deepEqual(claude.SessionStart[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', 'hook', 'session-start'])
})

test('a Copilot hook payload in its own casing reaches the same hooks: view gives a file hint, apply_patch a plan snapshot', () => {
  const w = new World()
  const keep = { HOME: process.env.HOME, THENWISE_HOME: process.env.THENWISE_HOME, COPILOT_PLUGIN_ROOT: process.env.COPILOT_PLUGIN_ROOT }
  try {
    Object.assign(process.env, { HOME: w.home, THENWISE_HOME: w.memDir, COPILOT_PLUGIN_ROOT: '/plugin' })
    const env = { dir: w.memDir, cli: resolve('src/cli.ts') }
    // Recorded live on Copilot CLI 1.0.105 with hooks/copilot.json: camelCase fields, toolArgs as JSON text or patch text.
    const start = JSON.parse(runHook('session-start', claudeHookInput({ sessionId: 'cp-9', timestamp: 1, cwd: w.proj, source: 'new' }), env))
    assert.match(start.additionalContext, /Thenwise memory runs from \/plugin/)
    assert.match(start.additionalContext, /memory_\* tools/)
    assert.equal(start.hookSpecificOutput, undefined)
    const read = claudeHookInput({ sessionId: 'cp-9', cwd: w.proj, toolName: 'view', toolArgs: JSON.stringify({ path: join(w.proj, 'src/a.ts') }), toolResult: { resultType: 'success', textResultForLlm: 'a' } })
    assert.equal(nothingToDo('read', read), false)
    assert.equal(runHook('read', read, env), '', 'no store yet, so no hint and no error')
    const post = claudeHookInput({ sessionId: 'cp-9', cwd: w.proj, toolName: 'apply_patch', toolArgs: `*** Begin Patch\n*** Add File: ${join(w.proj, 'probe.txt')}\n+probe\n*** End Patch\n` })
    assert.equal(post.tool_name, 'Write')
    assert.equal(post.tool_input.file_path, join(w.proj, 'probe.txt'))
    assert.equal(runHook('post', post, env), '')
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    w.destroy()
  }
})

test('doctor sees a plugin installed through Copilot CLI alone, and names both install routes when none is found', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-cop-'))
  mkdirSync(join(home, '.copilot/installed-plugins/thenwise/thenwise'), { recursive: true })
  const plugin = (cs: { name: string; ok: boolean; detail: string }[]) => cs.find((c) => c.name === 'plugin')!
  assert.equal(plugin(await runDoctor(home, { gh: () => true, mcp: () => true })).ok, true)
  const none = plugin(await runDoctor(mkdtempSync(join(tmpdir(), 'tw-cop-')), { gh: () => true, mcp: () => true }))
  assert.equal(none.ok, false)
  assert.match(none.detail, /\/plugin install thenwise/)
  assert.match(none.detail, /copilot plugin install thenwise@thenwise/)
})

test('forget removes a Copilot chat from the archive and keeps it out, and says where Copilot keeps its own copies', async () => {
  const w = new World()
  try {
    const rel = copilotChat(w, 'cp-7', 'forget me: the zebra plan')
    assert.equal(w.archive().archived, 1)
    const gz = join(w.memDir, 'archive/sessions', `${rel}.gz`)
    assert.ok(existsSync(gz))
    const lines: string[] = []
    assert.equal(await forget(w.cfg, 'cp-7', { yes: true, print: (l) => lines.push(l), rewriteVault: () => {} }), 0)
    assert.ok(!existsSync(gz))
    assert.match(lines.join('\n'), /Copilot CLI's own chat files in .*session-state/)
    assert.match(lines.join('\n'), /copies Copilot keeps on GitHub/)
    assert.equal(w.archive().archived, 0, 'the tombstone keeps it out')
    assert.ok(!existsSync(gz))
    assert.ok(existsSync(join(w.home, '.copilot/session-state/cp-7/events.jsonl')), "Copilot's own file is never touched")
  } finally {
    w.destroy()
  }
})

test('the memory tools find the project of the running Copilot session, not the plugin folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'tw-copilot-cwd-'))
  const saved = process.env.COPILOT_HOME
  process.env.COPILOT_HOME = join(home, 'copilot')
  try {
    mkdirSync(join(home, 'copilot', 'session-state', 's1'), { recursive: true })
    writeFileSync(join(home, 'copilot', 'session-state', 's1', 'workspace.yaml'), 'id: s1\ncwd: /work/repo\n')
    assert.equal(copilotSessionCwd(home, 's1'), '/work/repo')
    assert.equal(copilotSessionCwd(home, 'missing'), '')
    assert.equal(copilotSessionCwd(home, undefined), '')
    assert.equal(copilotSessionCwd(home, '../s1'), '')
  } finally {
    if (saved === undefined) delete process.env.COPILOT_HOME
    else process.env.COPILOT_HOME = saved
  }
})

test('a subagent event marked only by parentToolCallId stays out, and a task summary is kept', () => {
  const f = copilotConverter('s', '/w')
  assert.deepEqual(f(ev('assistant.message', { content: 'subagent says', parentToolCallId: 'c1' })), [])
  assert.match(f(ev('session.task_complete', { summary: 'Shipped the fix.' }))[0]!, /Shipped the fix\./)
})

test('#77: a Copilot shell command that exits nonzero is a failed tool result, though Copilot marks the call a success', () => {
  const f = copilotConverter('s', '/w')
  const result = (data: object) => JSON.parse(f(ev('tool.execution_complete', { toolCallId: 'c9', ...data }))[0]!).message.content[0].is_error
  assert.equal(result({ success: true, shellExecution: { exitCode: 1 }, result: { content: '1 failing' } }), true)
  assert.equal(result({ success: true, shellExecution: { exitCode: 0 }, result: { content: 'ok' } }), false)
  assert.equal(result({ success: true, result: { content: 'a' } }), false, 'a tool with no shell result stays as Copilot says')
  assert.equal(result({ success: false, result: { content: 'denied' } }), true)
})

test('a chat with prompts that yields nothing is logged, so a changed file format is not silent', () => {
  const w = new World()
  try {
    const dir = join(w.home, '.copilot/session-state/cp-new')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspace.yaml'), `id: cp-new\ncwd: ${w.proj}\n`)
    writeFileSync(join(dir, 'events.jsonl'), `${ev('user.message', { contentV2: [{ text: 'the format moved' }] })}\n`)
    process.env.THENWISE_LOG = 'info' // the test runner turns logging off
    w.archive()
    process.env.THENWISE_LOG = 'off'
    assert.match(readFileSync(join(w.memDir, 'logs', 'thenwise.log'), 'utf8'), /chat_not_understood/)
  } finally {
    w.destroy()
  }
})

test("every /thenwise: command finds the CLI in Copilot too, where nothing fills in ${CLAUDE_PLUGIN_ROOT}", async () => {
  // @ts-expect-error a plain script with no types
  const { copilotCommand } = await import('../scripts/plugin-folder.mjs')
  const line = 'node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js"'
  for (const f of readdirSync(resolve('commands'))) {
    const text: string = copilotCommand(readFileSync(resolve('commands', f), 'utf8'))
    for (const [, cmd] of text.matchAll(/(?:`|^)([^`\n]*dist\/cli\.js[^`\n]*)/gm)) assert.ok(cmd!.startsWith(line), `${f}: ${cmd}`)
  }
  if (process.platform === 'win32') return // Copilot's shell on Windows is PowerShell: covered with the Windows work
  const where = (env: Record<string, string>) => execFileSync('sh', ['-c', `echo "\${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise"`], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' }).trim()
  assert.equal(where({ HOME: '/h', COPILOT_HOME: '/c' }), '/c/installed-plugins/thenwise/thenwise')
  assert.equal(where({ HOME: '/h' }), '/h/.copilot/installed-plugins/thenwise/thenwise')
})
