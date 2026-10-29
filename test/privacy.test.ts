import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { backup } from '../src/backup/backup.ts'
import { saveNote } from '../src/capture/notes.ts'
import { MASK, MASK_VERSION, maskSecrets } from '../src/core/secrets.ts'
import { loadConfigSafe } from '../src/ingest/config.ts'
import { forget } from '../src/privacy/forget.ts'
import { joinTeam, payloadOf, resolveNote, share, sharedIds } from '../src/teams/client.ts'
import { createTeamServer, invite, openTeamDb } from '../src/teams/server.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const NONET = new URL('./no-net.mjs', import.meta.url).pathname

function chat(dir: string, name: string, cwd: string, prompt: string, extra: unknown[] = []) {
  mkdirSync(dir, { recursive: true })
  const row = (type: string, content: unknown, i: number) => JSON.stringify({ type, uuid: `${name}${i}`, timestamp: `2026-10-02T10:0${i}:00Z`, cwd, sessionId: name, entrypoint: 'cli', message: { role: type, content } })
  const rows = [row('user', prompt, 0), row('assistant', 'ok', 1), ...extra.map((c, i) => row(i % 2 ? 'user' : 'assistant', c, i + 2))]
  writeFileSync(join(dir, `${name}.jsonl`), `${rows.join('\n')}\n`)
}

function world(prompts: Record<string, string> = { a1: 'billing exporter retries zanzibar', a2: 'cache warmer quokka', b1: 'changelog format pelican' }, dataInVault = false) {
  const home = mkdtempSync(join(tmpdir(), 'tw-priv-'))
  const work = join(home, 'work')
  const data = dataInVault ? join(home, 'vault', '.thenwise') : join(home, '.thenwise')
  const proj = (key: string) => join(home, '.claude', 'projects', key)
  for (const [name, prompt] of Object.entries(prompts)) {
    const p = name.startsWith('a') ? 'alpha' : 'beta'
    chat(proj(`-work-${p}`), name, join(work, p), prompt)
  }
  mkdirSync(join(work, 'alpha'), { recursive: true })
  mkdirSync(data, { recursive: true, mode: 0o700 })
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, THENWISE_HOME: data }
  const writeConfig = (extra: Record<string, unknown> = {}) => writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 1, ingest: { roots: [work], repos: [], prs: false }, ...extra }), { mode: 0o600 })
  writeConfig()
  const cli = (args: string[], more: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...more }, encoding: 'utf8', cwd: home })
  const sync = () => (cli(['archive']), cli(['ingest']))
  const cfg = () => loadConfigSafe(home).config!

  return { home, work, data, proj, env, cli, sync, cfg, writeConfig }
}
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
const archived = (data: string) => (existsSync(join(data, 'archive/sessions')) ? walk(join(data, 'archive/sessions')) : [])
const search = (w: ReturnType<typeof world>, words: string) => w.cli(['search', words, '--all']).stdout

// S7-B3 secret types, built from pieces so this file holds no real-looking key.
const SECRETS: Record<string, string> = {
  aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
  awsSecret: `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`,
  ghp: `ghp_${'a1B2c3D4e5'.repeat(4)}`,
  githubPat: `github_pat_${'A1b2C3d4E5'.repeat(5)}`,
  anthropic: `sk-ant-api03-${'abcDEF12_-'.repeat(5)}`,
  openaiProject: `sk-proj-${'abcDEF12_-'.repeat(5)}`,
  stripeLive: `sk_live_${'a1B2c3D4e5F6'}`,
  stripeRestricted: `rk_live_${'a1B2c3D4e5F6'}`,
  npm: `npm_${'a1B2'.repeat(9)}`,
  slack: `xoxb-123456789012-abcdefABCDEF`,
  google: `AIza${'a1B2c3D4e5'.repeat(3)}a1B2c`,
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAqwertyuiop\nasdfghjklzxcvbnm1234\n-----END RSA PRIVATE KEY-----',
  openssh: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----',
  pemCut: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  envLine: 'DATABASE_PASSWORD=hunter2hunter2',
  envExport: 'export STRIPE_SECRET_KEY="abc123def456ghi"',
  postgres: 'postgres://admin:pass1234word@db.internal/app',
  httpsUser: 'https://deploy:pass1234word@example.com/repo.git',
  urlToken: 'https://example.com/hook?token=abcdef123456&x=1',
  urlAccessToken: 'https://example.com/hook?access_token=abcdef123456',
  bearer: 'Authorization: Bearer abcdef1234567890xyz',
  basic: 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==',
  jsonPassword: '{"password": "hunter2hunter2"}',
  jsonClientSecret: '{"client_secret":"abcd1234efgh5678"}',
  azure: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdEFGH1234abcdEFGH1234abcd==;',
  curlUser: 'curl -u admin:hunter2hunter2 https://example.com',
  sendgrid: `SG.${'abcDEF12_-'.repeat(2)}.${'abcDEF12_-'.repeat(4)}`,
  huggingface: `hf_${'abcDEFghij'.repeat(3)}`,
  gitlab: `glpat-${'abcDEF12_-'.repeat(2)}`,
}
// What each secret is reduced to, so the check looks for the sensitive part only.
const CORE: Record<string, string> = { aws: 'IOSFODNN7EXAMPLE', awsSecret: 'wJalrXUtnFEMI', pem: 'qwertyuiop', openssh: 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', pemCut: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', envLine: 'hunter2hunter2', envExport: 'abc123def456ghi', postgres: 'pass1234word', httpsUser: 'pass1234word', urlToken: 'abcdef123456', urlAccessToken: 'abcdef123456', bearer: 'abcdef1234567890xyz', basic: 'dXNlcjpwYXNzd29yZDEyMw', jsonPassword: 'hunter2hunter2', jsonClientSecret: 'abcd1234efgh5678', azure: 'abcdEFGH1234abcdEFGH1234abcd', curlUser: 'hunter2hunter2' }
const core = (k: string) => CORE[k] ?? SECRETS[k]!

const KEEP = [
  'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 fixed the bug',
  'session 123e4567-e89b-12d3-a456-426614174000 started',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg== shown',
  'the token budget is 4000 and the token limit resets',
  'the password field is required on the form',
  'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'max_tokens: 4096 and the secret sauce recipe',
]

test('S7-B3: every secret type is masked, including a secret split over two lines', () => {
  for (const [k, v] of Object.entries(SECRETS)) {
    const r = maskSecrets(`before ${v} after`)
    assert.ok(r.count > 0 && !r.text.includes(core(k)), `${k} leaked: ${r.text}`)
  }
  for (const text of ['password:\nhunter2hunter2', 'api_key =\n   abcdef123456xyz', 'DB_PASSWORD=\nhunter2hunter2']) {
    const r = maskSecrets(text)
    assert.ok(!/hunter2|abcdef12/.test(r.text), `split secret leaked: ${r.text}`)
  }
  assert.equal(maskSecrets(MASK).count, 0)
  assert.ok(MASK_VERSION >= 3)
})

test('S7-B3: Twilio keys, wrapped keys and keys glued to word characters are masked', () => {
  const twilio = `SK${'0a1b2c3d'.repeat(4)}`
  const ghp = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  const cases = [`sid ${twilio} ok`, `${ghp}_v2`, `foo_${ghp}`, `token:\n${ghp.slice(0, 40)}\n    ${ghp.slice(40)}\n\nnext line`]
  for (const c of cases) {
    const r = maskSecrets(c)
    assert.ok(r.count >= 1 && r.text.includes(MASK), c)
    assert.ok(!r.text.includes(twilio) && !r.text.includes('a1B2c3D4e5'), r.text)
  }
  assert.equal(maskSecrets(cases[3]!).text, `token:\n${MASK}\n\nnext line`)
})

test('S7-B4: prose and base64 are not swallowed by the wrapped-key or unanchored patterns', () => {
  const prose = 'the prefix sk-\nabcdefghijklmnopqrstuvwxyz is a word'
  const b64 = `data:image/png;base64,${'QUJD'.repeat(10)}AIza${'QUJD'.repeat(12)}`
  const names = 'network_test_environment_config, task-runner-configuration-file, disk-image-builder-service-name'
  assert.equal(maskSecrets(prose).text, prose)
  assert.equal(maskSecrets(b64).text, b64)
  assert.equal(maskSecrets(names).text, names)
})

test('S7-B4: git SHAs, UUIDs, base64 images, prose and file hashes stay readable', () => {
  for (const k of KEEP) assert.deepEqual(maskSecrets(k), { text: k, count: 0 }, k)
})

test('S7-H1: planted secrets are masked in the archive, store, tool results and hook output', () => {
  const w = world({ a1: 'secrets test zanzibar' })
  const all = Object.values(SECRETS)
  const tool = [
    [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${SECRETS.stripeLive} && ${SECRETS.curlUser}` } }],
    [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `${SECRETS.envLine}\n${SECRETS.pem}\n${SECRETS.postgres}` }] }],
    [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: join(w.work, 'alpha/.env') } }],
    [{ type: 'tool_result', tool_use_id: 't2', content: `diff --git a/.env b/.env\n+${SECRETS.envExport}\n+${SECRETS.ghp}\n+${SECRETS.jsonClientSecret}` }],
  ]
  chat(w.proj('-work-alpha'), 'a1', join(w.work, 'alpha'), `please use ${all.join(' ')} and ${KEEP.join(' ')} zanzibar`, tool)
  w.sync()
  const blob = [...archived(w.data).map((f) => gunzipSync(readFileSync(f)).toString('utf8')), search(w, 'zanzibar'), w.cli(['trace', '.env', '--all']).stdout, w.cli(['resume', 'zanzibar', '--all']).stdout].join('\n')
  for (const k of Object.keys(SECRETS)) assert.ok(!blob.includes(core(k)), `${k} reached the archive or the output: ...${blob.slice(Math.max(0, blob.indexOf(core(k)) - 80), blob.indexOf(core(k)) + 40)}`)
  for (const k of KEEP) assert.ok(blob.includes(k.slice(0, 30)) || !k.includes('base64'), k)
  const hook = spawnSync(process.execPath, [CLI, 'hook', 'read'], { env: w.env, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Read', session_id: 's', cwd: join(w.work, 'alpha'), tool_input: { file_path: join(w.work, 'alpha/.env') } }) })
  for (const k of Object.keys(SECRETS)) assert.ok(!hook.stdout.includes(core(k)))
  const db = readFileSync(join(w.data, 'graph.db')).toString('latin1')
  for (const k of ['aws', 'ghp', 'anthropic', 'stripeLive', 'jwt']) assert.ok(!db.includes(core(k)), `${k} in graph.db`)
})

test('S7-B5: setup, archive, ingest, search, the MCP server and hooks make no outside connection', async () => {
  const w = world()
  const log = join(w.home, 'nonet.log')
  const env = { NONET_LOG: log, NODE_OPTIONS: `--import=${NONET}` }
  const run = (args: string[], input = '') => spawnSync(process.execPath, [CLI, ...args], { env: { ...w.env, ...env }, encoding: 'utf8', input, cwd: w.home })
  assert.equal(run(['setup', '--yes']).status, 0)
  assert.equal(run(['archive']).status, 0)
  assert.equal(run(['ingest']).status, 0)
  assert.match(run(['search', 'zanzibar', '--all']).stdout, /zanzibar/)
  const hook = run(['hook', 'session-start'], JSON.stringify({ source: 'startup', cwd: join(w.work, 'alpha'), session_id: 'x' }))
  assert.equal(hook.status, 0)
  const mcp = run(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  assert.match(mcp.stdout, /"id":2/)
  await new Promise((r) => setTimeout(r, 1500)) // the detached sync from the hook
  assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '', 'a connection left the machine')
  // The guard itself works: a non-local connect is refused and logged.
  const probe = spawnSync(process.execPath, ['-e', "require('node:net').connect(80,'192.0.2.1').on('error',()=>{})"], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.notEqual(probe.status, 0)
  assert.match(readFileSync(log, 'utf8'), /192\.0\.2\.1/)
})

test('S7-B6: forgetting something that does not exist says so and exits 0', () => {
  const w = world()
  w.sync()
  const r = w.cli(['forget', 'no-such-session', '--yes'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Nothing found/)
  assert.equal(archived(w.data).length, 3)
})

test('S7-H2: forget a session removes it everywhere Thenwise can reach and names what it cannot', () => {
  const w = world()
  w.sync()
  mkdirSync(join(w.data, 'hook-state'), { recursive: true })
  writeFileSync(join(w.data, 'hook-state', 'a1.json'), '[]')
  assert.match(search(w, 'zanzibar'), /zanzibar/)
  const ask = w.cli(['forget', 'a1'])
  assert.equal(ask.status, 1)
  assert.match(ask.stdout, /Will forget 1 chat/)
  assert.equal(archived(w.data).length, 3, 'without --yes nothing is removed')
  const r = w.cli(['forget', 'a1', '--yes'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Forgot 1 chat/)
  assert.match(r.stdout, /archive: 1 item removed, 1 manifest entry/)
  assert.match(r.stdout, /hook state: 1 file/)
  assert.match(r.stdout, /store: 1 session removed/)
  for (const gone of ['git history', 'iCloud or Time Machine', 'teammates', "Claude Code's own chat files"]) assert.match(r.stdout, new RegExp(gone))
  assert.equal(archived(w.data).length, 2)
  assert.ok(!JSON.parse(readFileSync(join(w.data, 'archive/manifest.json'), 'utf8'))['-work-alpha/a1.jsonl'])
  assert.ok(!existsSync(join(w.data, 'hook-state', 'a1.json')))
  assert.match(search(w, 'zanzibar'), /not recorded/)
  assert.match(search(w, 'quokka'), /quokka/)
  assert.ok(existsSync(join(w.proj('-work-alpha'), 'a1.jsonl')), "Claude Code's own file is untouched")
})

test('S7-H2: forget unshares team notes made from the chat, and clears them from a vault backup', async () => {
  const w = world()
  w.sync()
  const srv = tmpdirOf('tw-srv-')
  const app = createTeamServer({ dir: srv })
  const { port } = await app.listen()
  const db = openTeamDb(srv)
  const token = invite(db, 'dee')
  db.close()
  await joinTeam(w.data, `http://127.0.0.1:${port}`, token)
  const note = { id: 'n1', type: 'decision' as const, title: 'zanzibar rule', summary: 'use zanzibar', status: 'active' as const, valid_from: '2026-10-02', valid_to: '', supersedes: '', sources: ['session a1'], created: '2026-10-02', project: '', path: '' }
  saveNote(w.data, note)
  await share(w.data, 'n1', payloadOf(resolveNote(w.data, join(w.home, '.claude'), 'n1')).payload)
  assert.deepEqual(sharedIds(w.data), ['n1'])
  const vault = join(w.home, 'vault')
  const copies = join(w.home, 'copies')
  mkdirSync(join(vault, '_thenwise'), { recursive: true })
  mkdirSync(copies)
  writeFileSync(join(vault, '_thenwise', 'zanzibar.md'), 'zanzibar note')
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'folders', folders: [copies] } })
  assert.ok(backup(w.cfg()).ok)
  assert.ok(existsSync(join(copies, 'vault/_thenwise/zanzibar.md')))
  const lines: string[] = []
  const code = await forget(w.cfg(), 'a1', { yes: true, print: (l) => lines.push(l), rewriteVault: () => rmFile(join(vault, '_thenwise', 'zanzibar.md')) })
  await app.close()
  assert.equal(code, 0)
  assert.deepEqual(sharedIds(w.data), [])
  assert.ok(!existsSync(join(copies, 'vault/_thenwise/zanzibar.md')), 'the backup copy is gone')
  assert.match(lines.join('\n'), /team: 1 shared note unshared/)
})

test('S7-H3: forget a project folder removes every chat of that project and no other', () => {
  const w = world()
  w.sync()
  const r = w.cli(['forget', join(w.work, 'alpha'), '--yes'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Forgot 2 chats/)
  assert.deepEqual(archived(w.data).map((f) => f.split('/').slice(-2).join('/')), ['-work-beta/b1.jsonl.gz'])
  assert.match(search(w, 'zanzibar'), /not recorded/)
  assert.match(search(w, 'quokka'), /not recorded/)
  assert.match(search(w, 'pelican'), /pelican/)
  w.sync()
  assert.equal(archived(w.data).length, 1, 'a later sync leaves the project out')
})

test('S7-B7: forget waits for a running sync, and the item is gone after both end', async () => {
  const w = world()
  w.sync()
  const holder = spawn('sleep', ['2'])
  writeFileSync(join(w.data, 'sync.lock'), String(holder.pid))
  const t = Date.now()
  const child = spawn(process.execPath, [CLI, 'forget', 'a1', '--yes'], { env: w.env, cwd: w.home })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  await new Promise((r) => setTimeout(r, 700))
  assert.doesNotMatch(out, /Forgot/, 'forget has not run while the sync holds the lock')
  assert.equal(archived(w.data).length, 3)
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0)
  assert.ok(Date.now() - t >= 1500)
  assert.match(out, /Forgot 1 chat/)
  assert.equal(archived(w.data).length, 2)
  assert.ok(!existsSync(join(w.data, 'sync.lock')))
})

test('S7-B8: a forgotten chat does not come back on the next sync', () => {
  const w = world()
  w.sync()
  assert.equal(w.cli(['forget', 'a1', '--yes']).status, 0)
  assert.ok(existsSync(join(w.data, 'forgotten.json')))
  // The chat file grows in Claude Code's own folder.
  appendFileSync(join(w.proj('-work-alpha'), 'a1.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'a19', timestamp: '2026-10-03T10:00:00Z', cwd: join(w.work, 'alpha'), sessionId: 'a1', entrypoint: 'cli', message: { role: 'user', content: 'more zanzibar' } })}\n`)
  w.sync()
  w.cli(['ingest', '--full'])
  assert.ok(!archived(w.data).some((f) => f.includes('a1.jsonl')))
  assert.match(search(w, 'zanzibar'), /not recorded/)
  assert.match(search(w, 'quokka'), /quokka/)
})

test('S7-B10: the data folder, archive, store and team file are readable by the user only', async () => {
  const w = world()
  w.sync()
  spawnSync(process.execPath, [CLI, 'hook', 'session-start'], { env: w.env, input: JSON.stringify({ source: 'resume', cwd: join(w.work, 'alpha') }) })
  spawnSync(process.execPath, [CLI, 'hook', 'read'], { env: w.env, input: JSON.stringify({ tool_name: 'Read', session_id: 's1', cwd: join(w.work, 'alpha'), tool_input: { file_path: join(w.work, 'alpha/x.ts') } }) })
  w.cli(['forget', 'a1', '--yes'])
  writeFileSync(join(w.data, 'team.json'), '{}', { mode: 0o644 })
  await new Promise((r) => setTimeout(r, 800))
  spawnSync(process.execPath, [CLI, 'hook', 'sync-run'], { env: w.env }) // a sync tightens what it finds
  const bad: string[] = []
  const check = (p: string) => {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return
    if ((st.mode & 0o077) !== 0) bad.push(`${p} ${(st.mode & 0o777).toString(8)}`)
    if (st.isDirectory()) for (const e of readdirSync(p)) check(join(p, e))
  }
  check(w.data)
  assert.deepEqual(bad, [])
})

test('S7b-H1: backup to git commits the vault in its own repo and pushes only when asked', () => {
  const w = world()
  const vault = join(w.home, 'vault')
  mkdirSync(join(vault, '_thenwise'), { recursive: true })
  writeFileSync(join(vault, '_thenwise', 'a.md'), 'note')
  const remote = join(w.home, 'remote.git')
  assert.equal(spawnSync('git', ['init', '--bare', '-q', remote]).status, 0)
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'git' } })
  const r = w.cli(['backup'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /made a git repo/)
  assert.match(r.stdout, /not pushed/)
  const log = (d: string) => spawnSync('git', ['-C', d, 'log', '--oneline'], { encoding: 'utf8' })
  assert.match(log(vault).stdout, /Thenwise backup/)
  spawnSync('git', ['-C', vault, 'remote', 'add', 'origin', remote])
  assert.equal(w.cli(['backup']).status, 0)
  const refs = () => spawnSync('git', ['-C', remote, 'for-each-ref'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(refs(), '', 'nothing pushed while push is off')
  writeFileSync(join(vault, '_thenwise', 'b.md'), 'second')
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'git', push: true } })
  const p = w.cli(['backup'])
  assert.equal(p.status, 0, p.stderr + p.stdout)
  assert.match(p.stdout, /pushed to origin/)
  assert.match(refs(), /refs\/heads\//)
})

test('S7b-H2: backup to listed folders copies the vault, and runs at most once a day with --daily', () => {
  const w = world()
  const vault = join(w.home, 'vault')
  const [c1, c2] = [join(w.home, 'c1'), join(w.home, 'c2')]
  mkdirSync(join(vault, 'sub'), { recursive: true })
  mkdirSync(c1)
  mkdirSync(c2)
  writeFileSync(join(vault, 'sub', 'a.md'), 'note')
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'folders', folders: [c1, c2] } })
  const r = w.cli(['backup'])
  assert.equal(r.status, 0, r.stderr)
  for (const c of [c1, c2]) assert.equal(readFileSync(join(c, 'vault/sub/a.md'), 'utf8'), 'note')
  writeFileSync(join(vault, 'sub', 'b.md'), 'later')
  assert.equal(w.cli(['backup', '--daily']).stdout, '', 'done today: no second run')
  assert.ok(!existsSync(join(c1, 'vault/sub/b.md')))
  assert.equal(w.cli(['backup']).status, 0)
  assert.ok(existsSync(join(c1, 'vault/sub/b.md')))
})

test('S7b-B1: a missing or read-only target gives a clear error and leaves the vault untouched', () => {
  const w = world()
  const vault = join(w.home, 'vault')
  mkdirSync(vault)
  writeFileSync(join(vault, 'a.md'), 'note')
  const ro = join(w.home, 'ro')
  mkdirSync(ro)
  chmodSync(ro, 0o500)
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'folders', folders: [join(w.home, 'missing'), ro] } })
  const before = readdirSync(vault)
  const r = w.cli(['backup'])
  chmodSync(ro, 0o700)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /missing does not exist/)
  if (process.getuid?.() !== 0) assert.match(r.stdout, /ro is read-only/)
  assert.deepEqual(readdirSync(vault), before)
  assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), 'note')
})

test('S7b-B2 S7-B9: a backup never holds the archive or the store, and a pushed vault holds no chat text', () => {
  const w = world(undefined, true) // the data folder sits inside the vault: the worst case for leaks
  w.sync()
  const vault = join(w.home, 'vault')
  writeFileSync(join(vault, 'note.md'), 'a plain note')
  const remote = join(w.home, '..', `${w.home.split('/').pop()}-remote.git`)
  assert.equal(spawnSync('git', ['init', '--bare', '-q', remote]).status, 0)
  const copies = join(w.home, '..', `${w.home.split('/').pop()}-copies`)
  mkdirSync(copies)
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'folders', folders: [copies] } })
  assert.equal(w.cli(['backup']).status, 0)
  const names = walk(copies).map((f) => f.slice(copies.length))
  assert.ok(names.some((n) => n.endsWith('note.md')))
  assert.deepEqual(names.filter((n) => /archive|graph\.db|\.jsonl|\/\.thenwise\//.test(n)), [])
  w.writeConfig({ vault: { path: vault }, backup: { kind: 'git', push: true } })
  spawnSync('git', ['-C', vault, 'init', '-q'])
  spawnSync('git', ['-C', vault, 'remote', 'add', 'origin', remote])
  mkdirSync(join(vault, '_thenwise'), { recursive: true })
  writeFileSync(join(vault, '_thenwise', 'Index.md'), '# Index')
  const r = w.cli(['backup'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const tracked = spawnSync('git', ['-C', vault, 'ls-files'], { encoding: 'utf8' }).stdout
  assert.doesNotMatch(tracked, /archive|graph\.db|\.jsonl|\.thenwise/)
  assert.match(tracked, /_thenwise\/Index\.md/)
  assert.doesNotMatch(tracked, /note\.md/, "the user's own notes are never committed")
  const dry = spawnSync('git', ['-C', vault, 'push', '--dry-run', 'origin', 'HEAD'], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  const pushed = spawnSync('git', ['-C', remote, 'grep', '-i', 'zanzibar', 'HEAD'], { encoding: 'utf8' })
  assert.notEqual(pushed.status, 0, 'no chat text on the remote')
})

test('Uninstall stops a running sync and lists what to delete by hand', async () => {
  const w = world()
  // Uninstall only signals the sync worker (`thenwise hook sync-run`), not any process that mentions Thenwise.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'thenwise-notes.md'])
  writeFileSync(join(w.data, 'sync.lock'), String(other.pid))
  assert.match(w.cli(['uninstall']).stdout, /No background sync is running/)
  assert.equal(other.exitCode, null, 'an unrelated process keeps running')
  other.kill()
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'hook', 'sync-run'])
  writeFileSync(join(w.data, 'sync.lock'), String(holder.pid))
  w.writeConfig({ vault: { path: join(w.home, 'vault') }, backup: { kind: 'folders', folders: [join(w.home, 'c1')] } })
  const r = w.cli(['uninstall'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Stopped the background sync/)
  for (const s of [w.data, '_thenwise', 'c1', 'Not deleted']) assert.ok(r.stdout.includes(s), s)
  await new Promise((res) => holder.on('close', res))
  assert.ok(existsSync(w.data), 'nothing was deleted')
})

function tmpdirOf(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}
function rmFile(p: string) {
  spawnSync('rm', ['-f', p])
}

test('gap 2: prose keeps its words, function calls are not secrets, Bearer values are masked', () => {
  for (const t of ['the token expiration is short', 'secret management and password validation', 'const token = getToken()', 'token = makeToken(']) assert.equal(maskSecrets(t).text, t)
  const pw = 'hunter2' + 'hunter2'
  assert.ok(!maskSecrets(`Authorization: Bearer ${pw}`).text.includes(pw))
  assert.ok(!maskSecrets(`Bearer ${pw}`).text.includes(pw))
  assert.ok(!maskSecrets(`authorization basic ${pw}`).text.includes(pw))
  assert.ok(MASK_VERSION >= 5)
})
