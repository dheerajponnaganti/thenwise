// S4-B6: time ingest on a repository with many commits (default 100,000), built in a temp folder with `git fast-import`.
//   node bench/commits.ts [--commits 100000]

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { loadConfig } from '../src/ingest/config.ts'
import { dumpHash, ingest } from '../src/ingest/ingest.ts'
import { chatText } from '../test/world.ts'

const n = process.argv.includes('--commits') ? Number(process.argv[process.argv.indexOf('--commits') + 1]) : 100000
const tmp = mkdtempSync(join(tmpdir(), 'thenwise-commits-'))
const home = join(tmp, 'home')
const repo = join(home, 'big')
mkdirSync(repo, { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
const t = (label: string, f: () => unknown) => {
  const t0 = Date.now()
  const r = f()
  console.log(`${label.padEnd(36)} ${((Date.now() - t0) / 1000).toFixed(2)} s`)
  return r
}

t(`build a repo of ${n} commits`, () => {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) {
    const msg = `Change number ${i} to module ${i % 97}`
    lines.push('commit refs/heads/main', `mark :${i}`, `committer T <t@t> ${1700000000 + i * 60} +0000`, `data ${Buffer.byteLength(msg)}`, msg)
    if (i > 1) lines.push(`from :${i - 1}`)
    const body = `v${i}\n`
    lines.push(`M 100644 inline src/m${i % 97}.ts`, `data ${Buffer.byteLength(body)}`, body)
  }
  const r = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, input: `${lines.join('\n')}\n`, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(String(r.stderr))
})

mkdirSync(join(home, '.thenwise/archive/sessions/-big'), { recursive: true })
writeFileSync(join(home, '.thenwise/config.json'), JSON.stringify({ ingest: { roots: [repo], repos: [], github_repos: [], vaults: [] } }))
const cfg = loadConfig(home)
writeFileSync(join(cfg.memDir, 'archive/sessions/-big/s1.jsonl.gz'), gzipSync(chatText('s1', { turns: [{ prompt: 'what changed in module 5?', reply: 'See the log.' }] }, repo)))
writeFileSync(join(tmp, 'prs.json'), '[]')
const opts = { prs: join(tmp, 'prs.json'), db: join(tmp, 'g.db') }
const full = t('full ingest', () => ingest(cfg, { ...opts, full: true })) as { mode: string }
t('update, nothing new', () => ingest(cfg, opts))
execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'One more commit'], { cwd: repo })
const one = t('update after one new commit', () => ingest(cfg, opts)) as { mode: string }
console.log(`modes: ${full.mode}, ${one.mode}`)
ingest(cfg, { ...opts, db: join(tmp, 'g2.db'), full: true })
console.log(`updated store equals a full rebuild: ${dumpHash(opts.db) === dumpHash(join(tmp, 'g2.db'))}`)
rmSync(tmp, { recursive: true, force: true })
