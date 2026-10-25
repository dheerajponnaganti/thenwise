// Fresh-install check: build, pack, install the tarball, then run the installed CLI against a fixture history
// in a temporary HOME. Never touches the real home. Usage: node bench/fresh/check.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = mkdtempSync(join(tmpdir(), 'thenwise-fresh-'))
const home = join(tmp, 'home')
const times = []
let failed = 0

const run = (label, cmd, args, opts = {}) => {
  const t = Date.now()
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm', ...opts })
  times.push([label, Date.now() - t])
  return r
}
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}
const must = (label, r) => {
  if (r.status !== 0) (console.error(`${label} failed:\n${r.stdout}\n${r.stderr}`), process.exit(1))
}

console.log(`node ${process.version} on ${process.platform}, temp ${tmp}`)

must('build', run('build', 'npm', ['run', 'build'], { cwd: repo }))
const packed = run('pack', 'npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: repo })
must('pack', packed)
const tarball = join(tmp, packed.stdout.trim().split(/\r?\n/).pop())
const inst = join(tmp, 'install')
mkdirSync(inst)
writeFileSync(join(inst, 'package.json'), '{"private":true}')
// --omit=optional leaves pg out: local use must not need it.
must('install', run('install', 'npm', ['install', '--omit=optional', '--no-audit', '--no-fund', tarball], { cwd: inst }))
const cli = join(inst, 'node_modules', 'thenwise', 'dist', 'cli.js')
check('pg is not installed', !existsSync(join(inst, 'node_modules', 'pg')))

// Fixture: two projects, one excluded chat, one secret.
const SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234'
const work = join(home, 'work')
const line = (type, uuid, at, cwd, content) => JSON.stringify({ type, uuid, timestamp: at, cwd, sessionId: 's', entrypoint: 'cli', message: { role: type, content } })
const chat = (cwd, turns) => turns.map(([t, text], i) => line(t, `u${i}`, `2026-10-02T10:0${i}:00Z`, cwd, text)).join('\n') + '\n'
const sessions = {
  '-work-alpha/a1.jsonl': ['alpha', [['user', 'How should the billing exporter handle retries?'], ['assistant', [{ type: 'text', text: 'Decision: use exponential backoff with jitter for the billing exporter retries.' }]], ['user', `Here is my key ${SECRET} please keep it out of the notes`]]],
  '-work-alpha/a2.jsonl': ['alpha', [['user', 'Why did the nightly cache warmer fail?'], ['assistant', [{ type: 'text', text: 'The cache warmer failed because the TTL was shorter than the job interval.' }]]]],
  '-work-beta/b1.jsonl': ['beta', [['user', 'Pick a format for the changelog generator output'], ['assistant', [{ type: 'text', text: 'Decision: the changelog generator writes plain Markdown.' }]]]],
  '-work-beta/b2.jsonl': ['beta', [['user', 'zebra quokka canary prompt [no-memory]'], ['assistant', [{ type: 'text', text: 'zebra quokka answer' }]]]],
}
for (const [rel, [proj, turns]] of Object.entries(sessions)) {
  const file = join(home, '.claude', 'projects', ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, chat(join(work, proj), turns))
}
mkdirSync(join(home, '.thenwise'), { recursive: true })
writeFileSync(join(home, '.thenwise', 'config.json'), JSON.stringify({ ingest: { roots: [join(work, 'alpha'), join(work, 'beta')], repos: [], github_repos: [], vaults: [] } }))

const env = { ...process.env, HOME: home, USERPROFILE: home }
delete env.THENWISE_HOME
delete env.MEMORY_HOME
const cliRun = (label, ...args) => run(label, process.execPath, [cli, ...args], { env, cwd: tmp })
const ok = (label, r) => (check(`${label} exits 0`, r.status === 0, `(status ${r.status})\n${r.stdout}\n${r.stderr}`), r.stdout)

const archived = ok('archive', cliRun('archive', 'archive'))
check('archive counts the chats', /sessions seen/.test(archived), archived)
ok('ingest', cliRun('ingest', 'ingest'))
const found = ok('search', cliRun('search', 'search', 'exponential backoff billing'))
check('search finds the known phrase', /exponential backoff/i.test(found), found)
const cur = ok('current', cliRun('current', 'current', 'changelog generator'))
check('current finds the changelog decision', /changelog/i.test(cur), cur)
const past = ok('asof', cliRun('asof', 'asof', '2026-10-03', 'cache warmer'))
check('asof answers', /cache warmer|TTL/i.test(past), past)
check('excluded chat is absent from search', !/quokka answer/i.test(ok('search excluded', cliRun('search excluded', 'search', 'zebra quokka'))))

const data = join(home, '.thenwise')
const files = []
const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))))
walk(join(data, 'archive'))
const gz = files.filter((f) => f.endsWith('.gz'))
const text = gz.map((f) => gunzipSync(readFileSync(f)).toString()).join('\n')
check('archive holds the chats but not the marked one', gz.length === 3 && !gz.some((f) => f.endsWith('b2.jsonl.gz')), `${gz.length} archived chats`)
check('secret is masked in the archive', !text.includes('FAKEFAKEFAKE') && text.includes('[secret masked]'))
// The archive is a masked backup of every chat except the ones carrying an exclude marker.
check('excluded chat is absent from the graph', !readFileSync(join(data, 'graph.db')).includes('quokka'))
check('data folder is <HOME>/.thenwise', existsSync(join(data, 'graph.db')) && !existsSync(join(home, '.memory')))

ok('setup', cliRun('setup', 'setup', '--yes', '--no-sync'))
check('setup keeps a versioned config', JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')).version === 1)
check('doctor runs and names its checks', /data folder/.test(cliRun('doctor', 'doctor').stdout))

console.log('\ntimings:')
for (const [l, ms] of times) console.log(`  ${l.padEnd(18)} ${(ms / 1000).toFixed(2)} s`)
rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
