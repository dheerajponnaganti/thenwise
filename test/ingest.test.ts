import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

import { archive } from '../src/ingest/archive.ts'
import { loadConfig } from '../src/ingest/config.ts'
import { dumpHash, ingest, report } from '../src/ingest/ingest.ts'

// Everything here is synthetic: fake keys, fake prompts, a throwaway git repo.
const KEYS = ['AKIAIOSFODNN7EXAMPLE', `ghp_${'a1B2c3D4e5'.repeat(4)}`, `sk-ant-api03-${'Zz9Yy8Xx7W'.repeat(3)}`, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'hunter2hunter2']
const line = (o: object) => JSON.stringify(o)
const j = (...a: object[]) => `${a.map(line).join('\n')}\n`
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]))
}
const hashTree = (dir: string) => Object.fromEntries(allFiles(dir).sort().map((f) => [f, sha256(readFileSync(f))]))

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memv2-ingest-'))
  const proj = join(home, 'proj')
  mkdirSync(join(proj, 'src'), { recursive: true })
  git(proj, 'init', '-q', '-b', 'main')
  writeFileSync(join(proj, 'src/a.ts'), 'a\n')
  git(proj, 'add', '.')
  git(proj, 'commit', '-q', '-m', 'Add a', '-m', 'Decision: keep a tiny\nWhy: fewer moving parts\nDead-end: a big framework')
  writeFileSync(join(proj, 'src/b.ts'), 'b\n')
  git(proj, 'add', '.')
  git(proj, 'commit', '-q', '-m', 'Add b (#7)')
  const sha = git(proj, 'rev-parse', 'HEAD')
  const short = sha.slice(0, 7)

  writeFileSync(join(home, 'prs.json'), JSON.stringify([
    { number: 7, title: 'Add b', body: 'Adds b. See src/a.ts.', state: 'MERGED', createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-03T00:00:00Z', mergeCommit: { oid: sha }, url: 'https://github.com/me/proj/pull/7', files: [{ path: 'src/b.ts' }], comments: [] },
    { number: 8, title: 'Other', body: 'Unrelated', state: 'OPEN', createdAt: '2026-10-04T00:00:00Z', mergedAt: null, files: [], comments: [] },
  ]))

  const vault = join(home, 'vault')
  mkdirSync(join(vault, '.obsidian'), { recursive: true })
  writeFileSync(join(vault, '.obsidian/skip.md'), 'hidden')
  writeFileSync(join(vault, 'Plan.md'), '---\ndate: 2026-10-01\n---\n# The plan\nSee [[Details]] and [[Second title]]. Landed in PR #7.\n')
  writeFileSync(join(vault, 'Details.md'), 'Details about src/a.ts.\n')
  writeFileSync(join(vault, 'other.md'), '---\ntitle: Second title\n---\nbody\n')
  writeFileSync(join(proj, 'CLAUDE.md'), '# Rules\n- Never add a co-author line\n```\n- not a rule\n```\n')

  mkdirSync(join(home, '.memory'), { recursive: true })
  writeFileSync(join(home, '.memory/config.json'), JSON.stringify({ ingest: { roots: [proj], repos: [proj], github_repos: ['me/proj'], vaults: [vault] } }))

  const dir = join(home, '.claude/projects/-home-proj')
  mkdirSync(dir, { recursive: true })
  const u = (uuid: string, content: unknown, at: string, extra: object = {}) => ({ type: 'user', uuid, timestamp: at, cwd: proj, sessionId: 's', entrypoint: 'cli', message: { role: 'user', content }, ...extra })
  const a = (uuid: string, content: unknown, at: string) => ({ type: 'assistant', uuid, timestamp: at, cwd: proj, message: { role: 'assistant', content } })
  const s1 = j(
    u('u1', 'fix the a file', '2026-10-02T10:00:00Z'),
    a('a1', [{ type: 'text', text: 'Editing it.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(proj, 'src/a.ts'), new_string: `token ${KEYS[1]}` } }], '2026-10-02T10:00:01Z'),
    u('r1', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `done AWS ${KEYS[0]} and ${KEYS[2]}` }] }], '2026-10-02T10:00:02Z'),
    u('meta', '<command-name>x</command-name>', '2026-10-02T10:00:03Z'),
    u('u2', `ship it. password = ${KEYS[4]}`, '2026-10-02T10:01:00Z'),
    a('a2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `git commit -m 'Add b (#7)' # jwt ${KEYS[3]}` } }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'gh pr create --title x' } }], '2026-10-02T10:01:01Z'),
    u('r2', [{ type: 'tool_result', tool_use_id: 't2', content: `[main ${short}] Add b (#7)\n 1 file changed` }, { type: 'tool_result', tool_use_id: 't3', content: 'https://github.com/me/proj/pull/7\n' }], '2026-10-02T10:01:02Z'),
    a('a3', [{ type: 'text', text: 'Committed and opened the PR.' }], '2026-10-02T10:01:03Z'),
  ) + 'this is not json {{ token=abcdefgh12345678\n'
  const s2 = j(
    u('c1', 'This session is being continued. read the full transcript at: /h/.claude/projects/-home-proj/s1.jsonl', '2026-10-03T09:00:00Z', { isCompactSummary: true }),
    u('u3', `what about PR #7 and commit ${short}?`, '2026-10-03T09:01:00Z'),
    a('a4', [{ type: 'text', text: 'See src/b.ts.' }], '2026-10-03T09:01:05Z'),
  )
  writeFileSync(join(dir, 's1.jsonl'), s1)
  writeFileSync(join(dir, 's2.jsonl'), s2)
  mkdirSync(join(dir, 's2/subagents'), { recursive: true })
  writeFileSync(join(dir, 's2/subagents/agent-1.jsonl'), j(u('x', 'sub', '2026-10-03T09:02:00Z')))
  const cdate = git(proj, 'log', '-1', '--format=%aI', 'HEAD~1')
  const before = new Date(Date.parse(cdate) - 60000).toISOString()
  writeFileSync(join(dir, 's3.jsonl'), j(
    u('m1', 'commit the first one', before),
    a('m2', [{ type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'git add -A && git commit -q -m "Add a"' } }], before),
  ))
  writeFileSync(join(dir, 'sdk.jsonl'), j({ ...u('k1', 'automated question', '2026-10-03T00:00:00Z'), entrypoint: 'sdk-cli' }))
  // An interactive test chat in the real project, recognised by the marker in its prompts.
  writeFileSync(join(dir, 'mk.jsonl'), j(u('mk1', 'what is the latest release? [memory-eval]', '2026-10-03T00:00:00Z')))
  const evalKey = join(home, '.claude/projects/-home-proj-eval-ws-grep')
  mkdirSync(evalKey, { recursive: true })
  writeFileSync(join(evalKey, 'e1.jsonl'), j(u('e1', 'an eval question', '2026-10-03T00:00:00Z')))
  const other = join(home, '.claude/projects/-home-other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'o1.jsonl'), j({ ...u('o', 'cook dinner', '2026-10-03T00:00:00Z'), cwd: join(home, 'recipes') }))
  const tmpKey = join(home, '.claude/projects/-private-tmp-x')
  mkdirSync(tmpKey, { recursive: true })
  writeFileSync(join(tmpKey, 't.jsonl'), j(u('t', 'scratch', '2026-10-03T00:00:00Z')))

  return { home, proj, vault, dir, short, cfg: loadConfig(home), prs: join(home, 'prs.json') }
}

test('archive masks every field, nested tool results and unparsable lines; modes are private', () => {
  const f = fixture()
  const r = archive(f.cfg)
  assert.equal(r.excluded, 1)
  assert.equal(r.seen, 7)
  const out = join(f.home, '.memory/archive/sessions/-home-proj/s1.jsonl.gz')
  const text = gunzipSync(readFileSync(out)).toString('utf8')
  for (const k of KEYS) assert.ok(!text.includes(k), `leaked ${k}`)
  assert.ok(text.includes('[secret masked]'))
  assert.ok(text.includes('this is not json'))
  assert.deepEqual(r.unparsed, [{ rel: '-home-proj/s1.jsonl', line: 9 }])
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(statSync(join(f.home, '.memory/archive/sessions/-home-proj')).mode & 0o777, 0o700)
  assert.ok(readdirSync(join(f.home, '.memory/archive/sessions/-home-proj/s2/subagents')).includes('agent-1.jsonl.gz'))
  assert.throws(() => readdirSync(join(f.home, '.memory/archive/sessions/-private-tmp-x')))
})

test('archive is incremental, keeps the longer copy, and never touches sources', () => {
  const f = fixture()
  const before = hashTree(join(f.home, '.claude'))
  const first = archive(f.cfg)
  assert.equal(first.archived, 7)
  const again = archive(f.cfg)
  assert.equal(again.archived, 0)
  assert.equal(again.skipped, 7)
  assert.deepEqual(hashTree(join(f.home, '.claude')), before)

  appendFileSync(join(f.dir, 's2.jsonl'), line({ type: 'user', uuid: 'u9', timestamp: '2026-10-03T10:00:00Z', message: { content: 'one more prompt' } }) + '\n')
  const grown = archive(f.cfg)
  assert.equal(grown.archived, 1)
  assert.equal(grown.skipped, 6)
  const man = JSON.parse(readFileSync(join(f.home, '.memory/archive/manifest.json'), 'utf8'))
  assert.equal(man['-home-proj/s2.jsonl'].sha256.length, 64)

  // A file masked by older patterns is masked again from its archived copy.
  const s1 = join(f.home, '.memory/archive/sessions/-home-proj/s1.jsonl.gz')
  writeFileSync(s1, gzipSync(gunzipSync(readFileSync(s1)).toString() + 'STRIPE_SECRET_KEY=sk_live_' + 'q'.repeat(24) + '\n'))
  man['-home-proj/s1.jsonl'].mask = 1
  writeFileSync(join(f.home, '.memory/archive/manifest.json'), JSON.stringify(man))
  assert.equal(archive(f.cfg).remasked, 1)
  assert.ok(!gunzipSync(readFileSync(s1)).toString().includes('qqqq'))
  assert.equal(archive(f.cfg).remasked, 0)

  // A session present only in the Phase A raw copy is still archived; the longer copy wins.
  const raw = join(f.home, '.memory/archive/claude-projects/-home-proj')
  mkdirSync(raw, { recursive: true })
  writeFileSync(join(raw, 'gone.jsonl'), j({ type: 'user', uuid: 'g', message: { content: 'old' } }))
  writeFileSync(join(raw, 's1.jsonl'), 'short\n')
  const withRaw = archive(f.cfg)
  assert.equal(withRaw.archived, 1)
  assert.ok(readdirSync(join(f.home, '.memory/archive/sessions/-home-proj')).includes('gone.jsonl.gz'))
  assert.ok(gunzipSync(readFileSync(join(f.home, '.memory/archive/sessions/-home-proj/s1.jsonl.gz'))).toString().includes('fix the a file'))
})

test('ingest links sessions, commits, PRs, notes and rules; out-of-scope sessions stay out', () => {
  const f = fixture()
  archive(f.cfg)
  const r = ingest(f.cfg, { prs: f.prs, db: join(f.home, 'g.db') })
  assert.equal(r.sessionsIn, 3)
  assert.equal(r.sessionsOut, 1)
  assert.equal(r.excludedEntrypoint, 1)
  assert.equal(r.excludedEval, 1) // the eval-ws folder chat; the marked test chat never reaches the archive
  const db = new DatabaseSync(join(f.home, 'g.db'), { readOnly: true })
  const has = (src: string, dst: string, kind: string) => db.prepare('SELECT 1 FROM edges WHERE src=? AND dst=? AND kind=?').get(src, dst, kind) !== undefined
  const sha = git(f.proj, 'rev-parse', 'HEAD')
  assert.ok(has('ses:s2', 'ses:s1', 'continued_from'))
  assert.ok(has('turn:u2', `commit:proj:${sha}`, 'made'))
  assert.ok(has('turn:u2', 'pr:proj#7', 'opened'))
  const first = git(f.proj, 'rev-parse', 'HEAD~1')
  assert.ok(has('turn:m1', `commit:proj:${first}`, 'made'))
  assert.equal(JSON.parse(db.prepare("SELECT extra FROM edges WHERE src='turn:m1' AND kind='made'").get()!.extra as string).why, 'subject match')
  assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE id IN ('ses:sdk','ses:e1','ses:mk')").get()!.n, 0)
  assert.ok(has('turn:u1', `file:${join(f.proj, 'src/a.ts')}`, 'edited'))
  assert.ok(has('turn:u1', 'ses:s1', 'part_of'))
  assert.ok(has('pr:proj#7', `commit:proj:${sha}`, 'merged_as'))
  assert.ok(has('pr:proj#7', `file:${join(f.proj, 'src/b.ts')}`, 'touches'))
  assert.ok(has(`commit:proj:${sha}`, `file:${join(f.proj, 'src/b.ts')}`, 'changed'))
  assert.ok(has('note:Plan.md', 'note:Details.md', 'links_to'))
  assert.ok(has('note:Plan.md', 'note:other.md', 'links_to')) // by title
  assert.ok(has('note:Plan.md', 'pr:proj#7', 'mentions'))
  assert.ok(has('note:Details.md', `file:${join(f.proj, 'src/a.ts')}`, 'mentions')) // repo-relative path resolves
  assert.ok(has('turn:u3', 'pr:proj#7', 'mentions'))
  assert.ok(has('turn:u3', `commit:proj:${sha}`, 'mentions'))
  assert.ok(!has('turn:u1', 'pr:proj#8', 'mentions'))
  assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE id = 'ses:o1'").get()!.n, 0)
  assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE id LIKE 'note:.obsidian%'").get()!.n, 0)
  const rules = db.prepare("SELECT title FROM nodes WHERE kind = 'rule'").all()
  assert.deepEqual(rules.map((x) => x.title), ['Never add a co-author line'])
  const c = JSON.parse(db.prepare('SELECT extra FROM nodes WHERE id = ?').get(`commit:proj:${git(f.proj, 'rev-parse', 'HEAD~1')}`)!.extra as string)
  assert.deepEqual(c.trailers, { decision: ['keep a tiny'], why: ['fewer moving parts'], 'dead-end': ['a big framework'] })
  assert.equal(db.prepare("SELECT count(*) n FROM nodes_fts WHERE nodes_fts MATCH 'framework'").get()!.n, 2) // the commit and the active note made from its trailer
  const rep = report(join(f.home, 'g.db'))
  assert.match(rep, /sessions in scope: 3, out of scope: 1/)
  assert.match(rep, /continuation chains: 1/)
  db.close()
})

test('ingest is deterministic: two fresh builds have the same dump hash', () => {
  const f = fixture()
  archive(f.cfg)
  ingest(f.cfg, { prs: f.prs, db: join(f.home, 'one.db') })
  ingest(f.cfg, { prs: f.prs, db: join(f.home, 'two.db') })
  assert.equal(dumpHash(join(f.home, 'one.db')), dumpHash(join(f.home, 'two.db')))
})

test('--until drops everything dated after the cutoff', () => {
  const f = fixture()
  archive(f.cfg)
  const until = '2026-10-02T10:00:30Z'
  const db0 = join(f.home, 'cut.db')
  ingest(f.cfg, { prs: f.prs, db: db0, until })
  const db = new DatabaseSync(db0, { readOnly: true })
  const ms = Date.parse(until)
  for (const r of db.prepare("SELECT id, kind, at FROM nodes WHERE kind IN ('turn','summary','session','commit','pr','note') AND at != ''").all()) assert.ok(Date.parse(r.at as string) <= ms, `${r.id} ${r.at}`)
  const ids = db.prepare('SELECT id FROM nodes').all().map((r) => r.id)
  assert.ok(ids.includes('turn:u1'))
  assert.ok(!ids.includes('turn:u2') && !ids.includes('ses:s2') && !ids.includes('pr:proj#8'))
  assert.equal(db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'commit'").get()!.n, 0)
  assert.equal(db.prepare("SELECT until FROM nodes WHERE id = 'pr:proj#7'").get()!.until, '')
  assert.equal(db.prepare("SELECT max(until) m FROM nodes WHERE kind = 'session'").get()!.m as string <= until, true)
  db.close()
})

test('--memory-from reads auto-memory from the given projects folder', () => {
  const f = fixture()
  archive(f.cfg)
  mkdirSync(join(f.home, 'snap/-home-proj/memory'), { recursive: true })
  writeFileSync(join(f.home, 'snap/-home-proj/memory/m.md'), '---\nname: Old fact\n---\nbody\n')
  mkdirSync(join(f.dir, 'memory'))
  writeFileSync(join(f.dir, 'memory/new.md'), 'written after the cutoff\n')
  ingest(f.cfg, { prs: f.prs, db: join(f.home, 'm.db'), memoryFrom: join(f.home, 'snap') })
  const db = new DatabaseSync(join(f.home, 'm.db'), { readOnly: true })
  assert.deepEqual(db.prepare("SELECT id FROM nodes WHERE kind = 'memory'").all().map((r) => r.id), ['mem:-home-proj/m.md'])
  db.close()
})

test('a dated log note splits into one section per dated heading', async () => {
  const { datedSections } = await import('../src/ingest/ingest.ts')
  const body = 'Intro line.\n\n## 2026-10-14\n- renamed /upgrade to /refine\n\n## 2026-10-13\n- renamed /better to /upgrade\n\n## Notes\nplain heading stays in the section above'
  const s = datedSections(body)
  assert.equal(s.length, 2)
  assert.equal(s.preamble.trim(), 'Intro line.')
  assert.deepEqual(s.map((x) => x.date), ['2026-10-14', '2026-10-13'])
  assert.match(s[1]!.body, /\/better to \/upgrade[\s\S]*plain heading/)
  assert.equal(datedSections('## 2026-10-13\nonly one').length, 1)
})
