// `thenwise connect`: each tool's config gets one entry, nothing else in the file changes, and the entry starts a real server.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { apply, plan, TOOLS } from '../src/setup/connect.ts'

const home = () => mkdtempSync(join(tmpdir(), 'tw-connect-'))
const command: [string, string[]] = ['/n/node', ['/p/cli.js', 'mcp']]
const opts = (h: string) => ({ home: h, env: {}, command })

test('connect adds one entry per tool, and a second run changes nothing', () => {
  for (const tool of TOOLS) {
    const h = home()
    const first = plan(tool, opts(h))
    assert.equal(first.note, 'connected', tool)
    apply(first)
    assert.ok(readFileSync(first.file, 'utf8').includes('/p/cli.js'), tool)
    const again = plan(tool, opts(h))
    assert.equal(again.next, null, tool)
    assert.equal(again.note, 'already connected', tool)
  }
})

test('connect keeps everything else in a config file, and remove takes back only its entry', () => {
  const h = home()
  const file = join(h, '.cursor', 'mcp.json')
  mkdirSync(join(h, '.cursor'))
  writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }))
  apply(plan('cursor', opts(h)))
  const on = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(on.theme, 'dark')
  assert.deepEqual(on.mcpServers.other, { command: 'x' })
  assert.equal(on.mcpServers.thenwise.env.THENWISE_PROJECT, '${workspaceFolder}')
  apply(plan('cursor', { ...opts(h), remove: true }))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'dark', mcpServers: { other: { command: 'x' } } })
})

test('codex: the TOML stays as written around our block, comments included', () => {
  const h = home()
  const file = join(h, '.codex', 'config.toml')
  mkdirSync(join(h, '.codex'))
  const before = '# my settings\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "y"\n'
  writeFileSync(file, before)
  apply(plan('codex', opts(h)))
  const on = readFileSync(file, 'utf8')
  assert.ok(on.startsWith(before.trimEnd()))
  assert.match(on, /\[mcp_servers\.thenwise\]\ncommand = "\/n\/node"\nargs = \["\/p\/cli\.js", "mcp"\]/)
  apply(plan('codex', { ...opts(h), remove: true }))
  assert.equal(readFileSync(file, 'utf8').trimEnd(), before.trimEnd())
})

test('#115: connect codex and --remove keep the next table\'s comments, indented tables and CRLF line endings', () => {
  const ours = '[mcp_servers.thenwise]\ncommand = "/old/node"\nargs = ["/old/cli.js", "mcp"]\n'
  const cases = [
    // [what is in the file, what remove leaves]
    [`model = "x"\n\n${ours}\n# keep: my other server below\n[mcp_servers.other]\ncommand = "y"\n`, 'model = "x"\n\n# keep: my other server below\n[mcp_servers.other]\ncommand = "y"\n'],
    [`${ours}\n  [mcp_servers.other]\n  command = "y"\n  args = ["z"]\n`, '  [mcp_servers.other]\n  command = "y"\n  args = ["z"]\n'],
    [`model = "x"\n\n${ours}[mcp_servers.thenwise.env]\nA = "1"\n\n# trailing note\n`, 'model = "x"\n\n# trailing note\n'],
    // An older Thenwise appended a second table to CRLF files.
    [`model = "x"\n\n${ours}\n${ours}`, 'model = "x"\n'],
  ]
  for (const crlf of [false, true]) {
    for (const [input, removed] of cases) {
      const eol = (t: string) => (crlf ? t.replace(/\n/g, '\r\n') : t)
      const h = home()
      const file = join(h, '.codex', 'config.toml')
      mkdirSync(join(h, '.codex'))
      writeFileSync(file, eol(input!))
      const label = JSON.stringify({ crlf, input })
      apply(plan('codex', opts(h)))
      const on = readFileSync(file, 'utf8')
      assert.equal(on.match(/\[mcp_servers\.thenwise\]/g)?.length, 1, label)
      assert.ok(on.includes(eol('[mcp_servers.thenwise]\ncommand = "/n/node"\n')), label)
      assert.equal(on.includes('/old/'), false, label)
      assert.equal(/(^|[^\r])\n/.test(on), !crlf, `line endings kept: ${label}`)
      for (const keep of ['# keep', '[mcp_servers.other]', 'args = ["z"]', '# trailing note']) assert.equal(on.includes(keep), input!.includes(keep), `${keep}: ${label}`)
      assert.equal(plan('codex', opts(h)).next, null, `a second connect changes nothing: ${label}`)
      apply(plan('codex', { ...opts(h), remove: true }))
      assert.equal(readFileSync(file, 'utf8'), eol(removed!), `remove: ${label}`)
      assert.equal(plan('codex', { ...opts(h), remove: true }).next, null, label)
    }
  }
})

test('a config with comments is left alone, and the entry is shown to add by hand', () => {
  const h = home()
  const file = join(h, '.gemini', 'settings.json')
  mkdirSync(join(h, '.gemini'))
  const before = '{\n  // mine\n  "a": 1\n}\n'
  writeFileSync(file, before)
  const p = plan('gemini', opts(h))
  assert.equal(p.next, null)
  assert.match(p.note, /left alone/)
  assert.match(p.snippet, /mcpServers/)
  apply(p)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a custom data folder travels with the entry', () => {
  for (const tool of TOOLS) assert.ok(plan(tool, { home: home(), env: { THENWISE_HOME: '/data/tw' }, command }).next!.includes('/data/tw'), tool)
})

test('the CLI writes the entry, a dry run writes nothing, and the entry starts the memory server', () => {
  const h = home()
  const env = { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: join(h, 'data'), XDG_CONFIG_HOME: join(h, 'xdg') }
  const run = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', resolve('src/cli.ts'), 'connect', ...a], { encoding: 'utf8', env })
  const dry = run('cursor', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.throws(() => readFileSync(join(h, '.cursor', 'mcp.json')))
  assert.equal(run('nothing').status, 2)
  const real = run('cursor')
  assert.equal(real.status, 0, real.stderr)
  const entry = JSON.parse(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8')).mcpServers.thenwise
  const init = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
  const server = spawnSync(entry.command, ['--no-warnings', ...entry.args], { input: init, encoding: 'utf8', env: { ...env, ...entry.env }, timeout: 15000 })
  assert.match(server.stdout, /memory_why/)
})

test('connect says which tools Thenwise already remembers: Codex chats join at each sync, Cursor chats do not yet', () => {
  const said = (tool: string) => {
    const h = home()
    const r = spawnSync(process.execPath, [resolve('src/cli.ts'), 'connect', tool], { encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, THENWISE_HOME: join(h, '.memory') } })
    assert.equal(r.status, 0, r.stderr)

    return r.stdout
  }
  assert.match(said('codex'), /its own chats join this memory at each sync/)
  assert.match(said('antigravity'), /its own chats join this memory at each sync/)
  assert.match(said('cursor'), /its own chats are not remembered yet/)
})

test('antigravity writes its own config file, shared by its CLI, app and IDE, not the Gemini one', () => {
  const h = home()
  const p = plan('antigravity', opts(h))
  assert.equal(p.file, join(h, '.gemini', 'config', 'mcp_config.json'))
  apply(p)
  assert.deepEqual(JSON.parse(readFileSync(p.file, 'utf8')).mcpServers.thenwise.args, ['/p/cli.js', 'mcp'])
})
