import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { logger } from '../src/core/log.ts'
import { anonymize, buildReport, formUrl, issueRepo, reportCommand, toMarkdown, URL_MAX } from '../src/report/report.ts'
import { createServer } from '../src/server/stdio.ts'
import { tempDir } from './mcp-fixture.ts'

delete process.env.THENWISE_LOG
// Every server and child process here logs into a temp folder, never the real one.
process.env.THENWISE_HOME = tempDir()
after(() => delete process.env.THENWISE_HOME)

function home() {
  const h = tempDir()
  const dir = join(h, '.thenwise')
  mkdirSync(join(h, 'work', 'zanzibar-app'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  process.env.THENWISE_HOME = dir
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ingest: { roots: [join(h, 'work', 'zanzibar-app')] } }))
  logger('mcp', dir).error('tool_failed', { tool: 'memory_search', code: 'E4F2', err: `ENOENT: no such file '${join(h, 'work', 'zanzibar-app', 'notes.md')}'`, stack: 'at term (/opt/thenwise/dist/query/engine.js:262:9)' })
  logger('hook', dir).warn('query_failed', { msg: 'resume did not answer for zanzibar-app' })

  return { h, dir }
}

test('R-H1 R-B1: the report holds every section, and no project name, path or token', async () => {
  const { h, dir } = home()
  const r = await buildReport({ what: 'Search failed in zanzibar-app with key ghp_abcdefghijklmnopqrstuvwxyz0123456789', code: 'E4F2', dir, home: h })
  const md = toMarkdown(r)
  for (const s of ['What happened', 'Error code', 'Versions', 'Doctor', 'Store', 'Settings', 'Recent errors and warnings']) assert.match(md, new RegExp(`### ${s}`))
  assert.match(md, /tool_failed/)
  assert.match(md, /dist\/query\/engine\.js:262:9/) // a stack keeps Thenwise's own file
  assert.doesNotMatch(md, /zanzibar|ghp_|\/work\//)
  assert.match(r.settings, /projects 1/)
})

test('anonymize keeps source files, hides other paths and names', () => {
  assert.equal(anonymize("at x (~/code/memory-v2/src/query/engine.ts:12) open '/Users/a/acme/x.md'", ['acme']), "at x (src/query/engine.ts:12) open '<path>'")
  assert.equal(anonymize('at y (file:///C:/tw/dist/cli.js:3:1) and C:\\Users\\a\\x.md', []), 'at y (dist/cli.js:3:1) and <path>')
  assert.equal(anonymize('memory is off for acme-site', ['acme-site', 'acme']), 'memory is off for project-1')
})

test('R-H4: a long report link drops the oldest log lines first', () => {
  const r = { title: 't', kind: 'bug' as const, what: 'w', code: '', versions: 'v', doctor: 'd', store: 's', settings: 'x', logs: Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(80)}`) }
  const { url, trimmed } = formUrl(r)
  assert.ok(url.length <= URL_MAX)
  assert.ok(trimmed > 0)
  assert.match(decodeURIComponent(url), /line 199/)
  assert.doesNotMatch(decodeURIComponent(url), /line 0 /)
  assert.match(url, /template=bug\.yml/)
  assert.match(url, new RegExp(`^https://github\\.com/${issueRepo()}/issues/new\\?`))
  assert.match(issueRepo(), /^[\w-]+\/thenwise$/)
})

test('R-B2: with no action, or no yes, nothing is sent and the report stays in a file', async () => {
  const { dir } = home()
  const said: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void said.push(a.join(' '))
  try {
    assert.equal(await reportCommand(['--what', 'it broke'], dir), 0)
    assert.equal(await reportCommand(['--what', 'it broke', '--send'], dir), 1) // tests have no terminal, so no --yes means no
  } finally {
    console.log = orig
  }
  assert.match(said.join('\n'), /Nothing was sent/)
  assert.match(said.join('\n'), /Not sent: add --yes/)
  const file = /Saved to (\S+)/.exec(said.join('\n'))![1]!
  assert.ok(existsSync(file))
  assert.match(readFileSync(file, 'utf8'), /it broke/)
})

test('the report nudge shows on the first failure of a session only', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'graph.db'), 'not a database at all')
  process.env.THENWISE_HOME = dir
  const s = createServer(() => join(dir, 'graph.db'))
  s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const say = (id: number) => (s.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } }) as any).result.content[0].text as string
  assert.match(say(2), /\/thenwise:report/)
  assert.doesNotMatch(say(3), /\/thenwise:report/)
})
