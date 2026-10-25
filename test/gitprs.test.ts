import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { fetchPrs } from '../src/ingest/prs.ts'
import { discoverRepos, githubSlug, repoRoot } from '../src/ingest/repos.ts'
import { statusLines } from '../src/ingest/status.ts'
import { World, diffStores, git } from './world.ts'
import type { TurnSpec } from './world.ts'

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const BASE_PATH = process.env.PATH ?? ''
const DAY = 86400000

const turn = (n: number, extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: `question number ${n} about the exporter`, reply: `answer ${n}`, ...extra })
const count = (w: World, sql: string, db = 'inc.db') => {
  const d = new DatabaseSync(w.path(db), { readOnly: true })
  const n = (d.prepare(sql).get() as any).n as number
  d.close()
  return n
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

/** A `gh` and a `git` on PATH that log every call. gh answers from files; git passes through. */
function shims(w: World, opts: { gh?: boolean } = {}) {
  const bin = join(w.home, 'bin')
  mkdirSync(bin, { recursive: true })
  const env = { ghLog: join(w.home, 'gh.log'), gitLog: join(w.home, 'git.log'), mode: join(w.home, 'gh.mode'), json: join(w.home, 'gh.json') }
  if (opts.gh !== false) {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${env.ghLog}'\ncase "$1" in --version) echo 'gh version 9'; exit 0;; esac\nmode=$(cat '${env.mode}' 2>/dev/null || echo ok)\ncase "$mode" in\n  ok) cat '${env.json}' ;;\n  signedout) echo 'To get started with GitHub CLI, please run: gh auth login' >&2; exit 4 ;;\n  ratelimit) echo 'API rate limit exceeded' >&2; exit 1 ;;\n  hang) exec sleep 30 ;;\n  broken) echo '{"not": json' ;;\nesac\n`)
    chmodSync(join(bin, 'gh'), 0o755)
  }
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${env.gitLog}'\nexec '${REAL_GIT}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  // Without gh, PATH holds only the shims: CI runners ship gh in /usr/bin.
  process.env.PATH = opts.gh === false ? bin : `${bin}:/usr/bin:/bin`
  return { ...env, setMode: (m: string) => writeFileSync(env.mode, m), setJson: (j: unknown) => writeFileSync(env.json, JSON.stringify(j)) }
}
const restore = () => {
  process.env.PATH = BASE_PATH
}
const pr = (sha: string, over: object = {}) => ({ number: 7, title: 'Add b', body: 'Adds b. See src/b.ts.', state: 'MERGED', createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-03T00:00:00Z', mergeCommit: { oid: sha }, url: 'https://github.com/me/proj/pull/7', files: [{ path: 'src/b.ts' }], comments: [], headRefName: 'feat', baseRefName: 'main', ...over })
const withRemote = (w: World, url = 'https://github.com/me/proj.git') => git(w.proj, 'remote', 'add', 'origin', url)

test('S4-H1: a repo is found from the chats working folders, and a worktree maps to its main repo', () => {
  const w = new World({ repos: [] })
  const wt = join(w.home, 'wt-feature')
  git(w.proj, 'worktree', 'add', '-q', '-b', 'feature', wt)
  const real = (p: string | undefined) => realpathSync(p!)
  assert.equal(real(repoRoot(join(wt, 'src'))), real(w.proj))
  assert.equal(real(repoRoot(join(w.proj, 'src'))), real(w.proj))
  assert.equal(repoRoot(join(w.home, 'nowhere')), undefined)
  assert.deepEqual(discoverRepos([], [join(wt, 'src'), join(w.proj, 'src'), w.other, join(w.home, 'gone')]).map((p) => real(p)).sort(), [real(w.other), real(w.proj)].sort())
  assert.deepEqual(discoverRepos([w.other], [w.proj]).map((p) => real(p)), [real(w.other), real(w.proj)])
  w.commit(wt, 'src/wt.ts', 'Work in the worktree')
  w.chat('a', { turns: [turn(1)] })
  w.chat('b', { turns: [turn(2)], cwd: join(wt, 'src') })
  w.archive()
  w.ingest('inc.db')
  w.full('full.db')
  for (const db of ['inc.db', 'full.db']) {
    assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'commit' AND project = 'proj'", db), 2) // the first commit and the one made in the worktree, each once
    assert.equal(count(w, "SELECT count(DISTINCT source) n FROM nodes WHERE kind = 'commit'", db), 1)
  }
  w.destroy()
})

test('S4-H2: gh is called read only per repo, cached for a day, and status shows the last fetch', () => {
  const w = new World({ repos: [], github: [] })
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  withRemote(w)
  const s = shims(w)
  s.setJson([pr(sha)])
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  const t0 = Date.parse('2026-10-24T08:00:00Z')
  const first = w.ingest('inc.db', { prs: undefined, now: t0 })
  assert.equal(first.mode, 'full')
  assert.deepEqual(lines(s.ghLog), [`pr list --repo me/proj --state all --limit 2000 --json ${'number,title,body,state,createdAt,mergedAt,mergeCommit,url,files,comments,reviews,headRefName,baseRefName'}`])
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 1)
  w.ingest('inc.db', { prs: undefined, now: t0 + 3600000 })
  w.ingest('inc.db', { prs: undefined, now: t0 + DAY - 1000 })
  assert.equal(lines(s.ghLog).length, 1, 'inside a day: the cache answers')
  s.setJson([pr(sha), pr(sha, { number: 8, title: 'Other', url: 'https://github.com/me/proj/pull/8', state: 'OPEN', mergeCommit: null, mergedAt: null })])
  w.ingest('inc.db', { prs: undefined, now: t0 + DAY + 1000 })
  assert.equal(lines(s.ghLog).length, 2, 'after a day: asked again')
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 2)
  const status = statusLines(w.cfg, w.path('inc.db')).join('\n')
  assert.match(status, /PRs me\/proj: 2, last fetch 2026-10-25T08:00:01/)
  w.full('full.db', { prs: undefined, now: t0 + DAY + 2000 })
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'", 'full.db'), 2)
  restore()
  w.destroy()
})

test('S4-H3: a PR links to its commit and to the chat that opened it', () => {
  const w = new World({ repos: [], github: [] })
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  withRemote(w)
  const s = shims(w)
  s.setJson([pr(sha)])
  w.chat('a', { turns: [turn(1, { commit: { subject: 'Add b (#7)', sha }, prUrl: 'https://github.com/me/proj/pull/7' }), turn(2, { prompt: 'what did PR #7 change in src/b.ts?' })] })
  w.archive()
  w.ingest('inc.db', { prs: undefined })
  const has = (src: string, dst: string, kind: string) => count(w, `SELECT count(*) n FROM edges WHERE src = '${src}' AND dst = '${dst}' AND kind = '${kind}'`) === 1
  assert.ok(has('pr:proj#7', `commit:proj:${sha}`, 'merged_as'))
  assert.ok(has(`commit:proj:${sha}`, 'pr:proj#7', 'mentions'))
  assert.ok(has('turn:a-0', 'pr:proj#7', 'opened'))
  assert.ok(has('turn:a-0', `commit:proj:${sha}`, 'made'))
  assert.ok(has('turn:a-1', 'pr:proj#7', 'mentions'))
  assert.ok(has('pr:proj#7', `file:${join(w.proj, 'src/b.ts')}`, 'touches'))
  restore()
  w.destroy()
})

test('S4-B1: without gh the PRs are skipped, status says so, and nothing fails', () => {
  const w = new World({ repos: [], github: [] })
  withRemote(w)
  const s = shims(w, { gh: false })
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  const r = w.ingest('inc.db', { prs: undefined })
  assert.deepEqual(r.warnings, [])
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 0)
  assert.match(statusLines(w.cfg, w.path('inc.db')).join('\n'), /PRs skipped: gh is not installed/)
  assert.equal(lines(s.ghLog).length, 0)
  restore()
  w.destroy()
})

test('S4-B2: signed out, rate limited or offline: the cached PRs stay and status says they are stale', () => {
  const w = new World({ repos: [], github: [] })
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  withRemote(w)
  const s = shims(w)
  s.setJson([pr(sha)])
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  const t0 = Date.parse('2026-10-24T08:00:00Z')
  w.ingest('inc.db', { prs: undefined, now: t0 })
  for (const [i, mode] of ['signedout', 'ratelimit'].entries()) {
    s.setMode(mode)
    const r = w.ingest('inc.db', { prs: undefined, now: t0 + (i + 2) * DAY })
    assert.deepEqual(r.warnings, [])
    assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 1, mode)
    const status = statusLines(w.cfg, w.path('inc.db')).join('\n')
    assert.match(status, /PRs me\/proj: 1 cached, stale \(/, mode)
  }
  // Offline is the same failure: gh exits non-zero. The failed ask is not repeated for an hour.
  const calls = lines(s.ghLog).length
  w.ingest('inc.db', { prs: undefined, now: t0 + 3 * DAY + 60000 })
  assert.equal(lines(s.ghLog).length, calls)
  s.setMode('ok')
  w.ingest('inc.db', { prs: undefined, now: t0 + 3 * DAY + 2 * 3600000 })
  assert.match(statusLines(w.cfg, w.path('inc.db')).join('\n'), /PRs me\/proj: 1, last fetch/)
  restore()
  w.destroy()
})

test('S4-B3: a hung gh is given up on, and broken JSON keeps the cache', () => {
  const w = new World({ repos: [], github: [] })
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  withRemote(w)
  const s = shims(w)
  s.setJson([pr(sha)])
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  const t0 = Date.parse('2026-10-24T08:00:00Z')
  w.ingest('inc.db', { prs: undefined, now: t0 })
  s.setMode('hang')
  const began = Date.now()
  const r = w.ingest('inc.db', { prs: undefined, now: t0 + 2 * DAY, ghTimeoutMs: 600 })
  assert.ok(Date.now() - began < 5000, 'gave up quickly')
  assert.deepEqual(r.warnings, [])
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 1)
  assert.match(statusLines(w.cfg, w.path('inc.db')).join('\n'), /stale \(gh took longer than 1 s/)
  s.setMode('broken')
  w.ingest('inc.db', { prs: undefined, now: t0 + 4 * DAY })
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 1)
  assert.match(statusLines(w.cfg, w.path('inc.db')).join('\n'), /PRs me\/proj: 1 cached, stale/)
  restore()
  w.destroy()
})

test('S4-B4: no remote, two remotes, a shallow clone, a detached head and a deleted repo do not crash', () => {
  const w = new World({ repos: [], github: [] })
  const s = shims(w)
  s.setJson([])
  // no remote: proj has none yet
  assert.equal(githubSlug(w.proj), undefined)
  // two remotes, origin elsewhere: the GitHub one is used
  git(w.other, 'remote', 'add', 'origin', 'https://gitlab.com/x/other.git')
  git(w.other, 'remote', 'add', 'upstream', 'git@github.com:me/other.git')
  assert.equal(githubSlug(w.other), 'me/other')
  git(w.other, 'remote', 'add', 'fork', 'https://github.com/zed/other')
  assert.equal(githubSlug(w.other), 'me/other')
  git(w.other, 'remote', 'rename', 'upstream', 'origin2')
  git(w.other, 'remote', 'rename', 'origin', 'gitlab')
  git(w.other, 'remote', 'add', 'origin', 'https://github.com/me/main-one.git')
  assert.equal(githubSlug(w.other), 'me/main-one')
  // shallow clone
  const shallow = join(w.home, 'shallow')
  git(w.home, 'clone', '-q', '--depth', '1', `file://${w.proj}`, shallow)
  w.commit(w.proj, 'src/z.ts', 'One more')
  // detached head
  const detached = join(w.home, 'detached')
  git(w.home, 'clone', '-q', `file://${w.proj}`, detached)
  git(detached, 'checkout', '-q', '--detach', 'HEAD~1')
  // a repo that is deleted after the first ingest, with a commit only it has
  const doomed = join(w.home, 'doomed')
  git(w.home, 'clone', '-q', `file://${w.proj}`, doomed)
  w.commit(doomed, 'src/only.ts', 'Only in the doomed repo')
  for (const [i, cwd] of [w.proj, w.other, shallow, detached, doomed].entries()) w.chat(`r${i}`, { turns: [turn(i)], cwd }, `-home-r${i}`)
  w.cfg.roots.push(shallow, detached, doomed)
  w.archive()
  const first = w.ingest('inc.db', { prs: undefined })
  assert.deepEqual(first.warnings, [])
  // Clones share their commits with proj: a commit belongs to the first repo that has it.
  const titled = (t: string) => count(w, `SELECT count(*) n FROM nodes WHERE kind = 'commit' AND title = '${t}'`)
  assert.equal(titled('One more'), 1)
  assert.equal(titled('Only in the doomed repo'), 1)
  rmSync(doomed, { recursive: true, force: true })
  const { r, a, b } = w.both({ prs: undefined })
  assert.equal(a, b, diffStores(w.path('inc.db'), w.path('full.db')))
  assert.equal(titled('Only in the doomed repo'), 0)
  assert.equal(titled('One more'), 1)
  assert.equal(r.mode, 'update')
  restore()
  w.destroy()
})

test('S4-B4: a configured repo that is gone gives a warning, not a crash, and the update equals a full rebuild', () => {
  const w = new World({ repos: [], github: [] })
  const gone = join(w.home, 'gone-repo')
  mkdirSync(gone)
  w.cfg.repos.push(gone)
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  const { r, a, b } = w.both({ prs: undefined })
  assert.equal(a, b)
  assert.ok(r.warnings.some((x) => x.includes('git log failed')))
  w.destroy()
})

test('S4-B5: every gh and git call is read only', () => {
  const w = new World({ repos: [], github: [] })
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  withRemote(w)
  const s = shims(w)
  s.setJson([pr(sha)])
  w.chat('a', { turns: [turn(1, { commit: { subject: 'Add b (#7)', sha } })] })
  w.archive()
  const t0 = Date.parse('2026-10-24T08:00:00Z')
  // The shim also sees this test's own setup calls; only the calls made while ingest and status run are checked.
  const ours: string[] = []
  const during = (f: () => unknown) => {
    const before = lines(s.gitLog).length
    f()
    ours.push(...lines(s.gitLog).slice(before))
  }
  during(() => w.ingest('inc.db', { prs: undefined, now: t0 }))
  w.commit(w.proj, 'src/c.ts', 'Another')
  w.chat('b', { turns: [turn(2)] })
  w.archive()
  during(() => w.ingest('inc.db', { prs: undefined, now: t0 + 2 * DAY }))
  during(() => w.full('full.db', { prs: undefined, now: t0 + 2 * DAY }))
  during(() => statusLines(w.cfg, w.path('inc.db')))
  const gh = lines(s.ghLog)
  assert.ok(gh.length >= 2)
  for (const call of gh) assert.match(call, /^(pr list --repo [\w.-]+\/[\w.-]+ --state all --limit \d+ --json [\w,]+|--version)$/, call)
  const readOnly = new Set(['log', 'rev-list', 'config', 'rev-parse', 'remote', 'cat-file', 'symbolic-ref', 'show', 'diff', 'status', 'worktree'])
  const seen = new Set<string>()
  for (const call of ours) {
    const args = call.split(' ')
    // `-C <dir> -c key=value <subcommand> ...`
    let i = 0
    while (args[i] === '-C' || args[i] === '-c') i += 2
    seen.add(args[i]!)
    assert.ok(readOnly.has(args[i]!), `unexpected git call: ${call}`)
  }
  assert.ok(seen.has('log') && seen.has('rev-list') && seen.has('config'))
  restore()
  w.destroy()
})

test('S4: --prs <file> still works without gh', () => {
  const w = new World({ repos: [], github: ['me/proj'] })
  w.cfg.repos.push(w.proj)
  const sha = w.commit(w.proj, 'src/b.ts', 'Add b (#7)')
  writeFileSync(w.prs, JSON.stringify([pr(sha)]))
  const s = shims(w, { gh: false })
  w.chat('a', { turns: [turn(1)] })
  w.archive()
  w.ingest('inc.db')
  assert.equal(count(w, "SELECT count(*) n FROM nodes WHERE kind = 'pr'"), 1)
  assert.equal(lines(s.ghLog).length, 0)
  restore()
  w.destroy()
})

test('fetchPrs: a repo without a GitHub remote is never asked', () => {
  const w = new World({ repos: [], github: [] })
  const s = shims(w)
  s.setJson([])
  const f = fetchPrs(w.cfg, [w.proj, w.other])
  assert.deepEqual(f.inputs, [])
  assert.equal(lines(s.ghLog).length, 0)
  restore()
  w.destroy()
})
