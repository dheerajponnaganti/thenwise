// Timing of the incremental update (S3). Never writes in the owner's data folder.
//   node bench/incremental.ts owner               the owner's archive, read only (symlinks into a temp data folder)
//   node bench/incremental.ts synthetic [--chats 5000] [--projects 40]
// Prints the full rebuild, an update after one new chat, an update after one chat grew, an update with nothing new,
// and whether the updated store equals a full rebuild.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

import { loadConfig } from '../src/ingest/config.ts'
import type { Config } from '../src/ingest/config.ts'
import { dumpHash, ingest } from '../src/ingest/ingest.ts'
import { chatText, tick } from '../test/world.ts'
import type { ChatSpec } from '../test/world.ts'

const mode = process.argv[2]
const arg = (name: string, d: number) => (process.argv.includes(`--${name}`) ? Number(process.argv[process.argv.indexOf(`--${name}`) + 1]) : d)
const tmp = mkdtempSync(join(tmpdir(), 'thenwise-bench-'))
const rss = () => `${Math.round(process.memoryUsage().rss / 1e6)} MB`
const time = <T>(label: string, f: () => T): T => {
  const t = Date.now()
  const r = f()
  console.log(`${label.padEnd(44)} ${((Date.now() - t) / 1000).toFixed(2)} s   (rss ${rss()})`)
  return r
}
const put = (cfg: Config, key: string, id: string, spec: ChatSpec, cwd: string) => {
  const file = join(cfg.memDir, 'archive/sessions', key, `${id}.jsonl.gz`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, gzipSync(chatText(id, spec, cwd)))
}

let cfg: Config
let cwd: string
let key: string
if (mode === 'owner') {
  cfg = loadConfig(homedir())
  const real = join(cfg.memDir, 'archive/sessions')
  cfg.memDir = join(tmp, 'data')
  mkdirSync(join(cfg.memDir, 'archive/sessions'), { recursive: true })
  let n = 0
  for (const k of readdirSync(real)) {
    mkdirSync(join(cfg.memDir, 'archive/sessions', k))
    for (const f of readdirSync(join(real, k))) if (f.endsWith('.jsonl.gz')) (symlinkSync(join(real, k, f), join(cfg.memDir, 'archive/sessions', k, f)), n++)
  }
  console.log(`owner archive: ${n} chat files, linked read only into ${cfg.memDir}`)
  cwd = join(homedir(), 'memory-v2')
  key = '-Users-dheeraj-memory-v2'
} else if (mode === 'synthetic') {
  const chats = arg('chats', 5000)
  const projects = arg('projects', 40)
  const home = join(tmp, 'home')
  mkdirSync(join(home, '.thenwise'), { recursive: true })
  const roots: string[] = []
  for (let p = 0; p < projects; p++) {
    const r = join(home, `p${p}`)
    mkdirSync(join(r, 'src'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r })
    writeFileSync(join(r, 'src/a.ts'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: r })
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', `Start p${p}`], { cwd: r })
    roots.push(r)
  }
  writeFileSync(join(home, '.thenwise/config.json'), JSON.stringify({ ingest: { roots, repos: [], github_repos: [], vaults: [] } }))
  cfg = loadConfig(home)
  const WORDS = 'billing exporter retries queue backoff cache warmer schema migration release rollback timeout shard index replica checkpoint latency budget widget sync token session merge deploy'.split(' ')
  let seed = 7
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')
  const t0 = Date.now()
  for (let i = 0; i < chats; i++) {
    const p = i % projects
    const turns = Array.from({ length: 6 + Math.floor(rnd() * 6) }, (_, k) => ({ prompt: `${words(12)} number ${i}-${k}`, reply: `${words(60)}\n\n${words(60)}`, reads: [join(roots[p]!, `src/f${Math.floor(rnd() * 30)}.ts`)] }))
    put(cfg, `-home-p${p}`, `s${i}`, { turns }, roots[p]!)
  }
  console.log(`synthetic: ${chats} chats in ${projects} projects written in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  cwd = roots[0]!
  key = '-home-p0'
} else {
  console.error('usage: node bench/incremental.ts owner | synthetic [--chats N] [--projects N]')
  process.exit(2)
}

writeFileSync(join(tmp, 'prs.json'), '[]')
const opts = { prs: join(tmp, 'prs.json'), db: join(tmp, 'graph.db') }
const full = time('full rebuild', () => ingest(cfg, { ...opts, full: true }))
console.log(`  ${full.sessionsIn} chats in scope, ${full.filesRead} files read`)
time('update, nothing new', () => ingest(cfg, opts))
put(cfg, key, 'brand-new', { turns: [{ prompt: 'a brand new question about the exporter backoff', reply: 'We chose jittered backoff because retries were bunching up.', reads: [join(cwd, 'src/a.ts')] }, { prompt: 'and the queue', reply: 'The queue is fine.' }] }, cwd)
const one = time('update after one new chat', () => ingest(cfg, opts))
console.log(`  mode ${one.mode}, ${one.filesRead} files read`)
put(cfg, key, 'brand-new', { turns: [{ prompt: 'a brand new question about the exporter backoff', reply: 'We chose jittered backoff because retries were bunching up.', reads: [join(cwd, 'src/a.ts')] }, { prompt: 'and the queue', reply: 'The queue is fine.' }, { prompt: 'one more turn', reply: 'Added later.', at: tick() }] }, cwd)
const grew = time('update after that chat grew by a turn', () => ingest(cfg, opts))
console.log(`  mode ${grew.mode}, ${grew.filesRead} files read`)
time('update, nothing new', () => ingest(cfg, opts))
const f2 = time('full rebuild again (to compare)', () => ingest(cfg, { ...opts, db: join(tmp, 'graph2.db'), full: true }))
console.log(`updated store equals a full rebuild: ${dumpHash(opts.db) === dumpHash(join(tmp, 'graph2.db'))} (${f2.mode})`)
rmSync(tmp, { recursive: true, force: true })
