import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertField, parseFrontMatter } from '../src/core/frontmatter.ts'
import { resolveLinks, supersedeHeads, adjacency, findHubs } from '../src/core/graph.ts'
import { isValidId, newId, seededRandom } from '../src/core/ids.ts'
import { docTerms, Lexicon } from '../src/core/lexicon.ts'
import { parseNote, parseSource, wikilinks } from '../src/core/note.ts'
import { tokenize } from '../src/core/tokenize.ts'

test('front matter: flat keys, flow and block lists, scalars, comments', () => {
  const fm = parseFrontMatter(
    [
      '---',
      'title: Use "quotes" fine',
      'version: 3',
      'done: false',
      'valid_to: null',
      'empty:',
      'aliases: [budget sync, "money, sync", \'it\'\'s\']',
      'about: ["[[Sync Engine]]"]',
      'sources:',
      '  - "file:src/a.ts@abc 2026-01-02"',
      '  - url:https://x.org/a#frag 2026-01-03',
      'note: kept # a comment',
      '---',
      'Body line',
    ].join('\n'),
  )
  assert.deepEqual(fm.issues, [])
  assert.equal(fm.data.title, 'Use "quotes" fine')
  assert.equal(fm.data.version, 3)
  assert.equal(fm.data.done, false)
  assert.equal(fm.data.valid_to, null)
  assert.equal(fm.data.empty, null)
  assert.deepEqual(fm.data.aliases, ['budget sync', 'money, sync', "it's"])
  assert.deepEqual(fm.data.about, ['[[Sync Engine]]'])
  assert.deepEqual(fm.data.sources, ['file:src/a.ts@abc 2026-01-02', 'url:https://x.org/a#frag 2026-01-03'])
  assert.equal(fm.data.note, 'kept')
  assert.equal(fm.body, 'Body line')
})

test('front matter: nested values and an unclosed block are reported, not guessed', () => {
  const nested = parseFrontMatter('---\nowner:\n  name: x\n---\n')
  assert.match(nested.issues.join(), /nested/)
  const open = parseFrontMatter('---\ntitle: x\nno end')
  assert.equal(open.hasFrontMatter, false)
  assert.match(open.issues.join(), /closing/)
})

test('insertField adds one line and keeps every other byte', () => {
  const withFm = '---\ntitle: A\n---\n\nBody\r\n  spaced  \n'
  assert.equal(insertField(withFm, 'id', 'dec_X'), '---\nid: dec_X\ntitle: A\n---\n\nBody\r\n  spaced  \n')
  assert.equal(insertField('Plain note\n', 'id', 'not_X'), '---\nid: not_X\n---\nPlain note\n')
})

test('sources: kind, ref, hash and date; @ inside a URL is not a hash', () => {
  assert.deepEqual(parseSource('file:src/sync/engine.ts@3f2a1bc 2026-03-09'), { kind: 'file', ref: 'src/sync/engine.ts', hash: '3f2a1bc', at: '2026-03-09' })
  assert.deepEqual(parseSource('url:https://medium.com/@sam/post 2025-11-03'), { kind: 'url', ref: 'https://medium.com/@sam/post', hash: null, at: '2025-11-03' })
  assert.deepEqual(parseSource('human:lena'), { kind: 'human', ref: 'lena', hash: null, at: null })
  assert.equal(parseSource('nonsense'), null)
  assert.equal(parseSource('ftp:thing'), null)
})

test('wikilinks: labels and headings stripped; code ignored', () => {
  assert.deepEqual(wikilinks('See [[Sync Engine|the engine]] and [[Budget#Rules]] and ![[Chart]] `[[no]]`\n```\n[[nope]]\n```'), ['Sync Engine', 'Budget', 'Chart'])
})

test('parseNote: a typed decision and a plain hand note', () => {
  const d = parseNote(
    'decisions/use-x.md',
    '---\ntype: decision\ntitle: Use X\nsummary: Because Y.\nstatus: superseded\nvalid_to: 2026-05-01\nabout: ["[[Sync Engine]]"]\nsupersedes: []\nsources:\n  - "file:src/a.ts@abc 2026-01-02"\n---\n## Reason\nSee [[Other]].\n',
  )
  assert.equal(d.type, 'decision')
  assert.equal(d.status, 'superseded')
  assert.equal(d.validTo, '2026-05-01')
  assert.deepEqual(d.links, [
    { type: 'about', target: 'Sync Engine' },
    { type: 'mentions', target: 'Other' },
  ])
  assert.deepEqual(d.headings, ['Reason'])
  const h = parseNote('meetings/Kickoff 2026.md', 'Notes from the kickoff. [[Home]]\n')
  assert.equal(h.type, 'note')
  assert.equal(h.title, 'Kickoff 2026')
  assert.equal(h.confidence, 'imported')
  assert.equal(h.hasFrontMatter, false)
  const bad = parseNote('x.md', '---\ntype: decison\nstatus: done\n---\n')
  assert.equal(bad.type, 'note')
  assert.equal(bad.issues.length, 2)
})

test('tokenize: paths whole, camelCase split, stopwords dropped', () => {
  const t = tokenize('Why does the syncEngine retry in src/sync/engine.ts?')
  assert.ok(t.includes('src/sync/engine.ts'))
  assert.ok(t.includes('syncengine') && t.includes('sync') && t.includes('engine'))
  assert.ok(!t.includes('the') && !t.includes('does') && !t.includes('why'))
})

test('lexicon: title matches outrank body matches; remove undoes add exactly', () => {
  const lx = new Lexicon()
  lx.add('a', docTerms({ title: 'Conflict resolution', body: 'notes' }))
  lx.add('b', docTerms({ title: 'Release notes', body: 'we discussed conflict once' }))
  lx.add('c', docTerms({ title: 'Unrelated', body: 'nothing here' }))
  const first = lx.search('conflict', 5)
  assert.equal(first[0]?.id, 'a')
  assert.equal(first.length, 2)
  lx.remove('b')
  lx.add('b', docTerms({ title: 'Release notes', body: 'we discussed conflict once' }))
  assert.deepEqual(lx.search('conflict', 5), first)
  lx.remove('a')
  lx.remove('b')
  lx.remove('c')
  assert.equal(lx.size, 0)
  assert.deepEqual(lx.search('conflict', 5), [])
})

test('links resolve by title, then alias, then file name; ambiguity and misses are reported', () => {
  const nodes = [
    { id: 'n1', path: 'entities/sync-engine.md', title: 'Sync Engine', aliases: ['engine'], links: [] },
    { id: 'n2', path: 'decisions/a.md', title: 'A', aliases: ['dup'], links: [{ type: 'about' as const, target: 'sync engine' }, { type: 'mentions' as const, target: 'engine' }, { type: 'mentions' as const, target: 'sync-engine' }, { type: 'mentions' as const, target: 'Missing' }, { type: 'mentions' as const, target: 'dup' }] },
    { id: 'n3', path: 'decisions/b.md', title: 'B', aliases: ['dup'], links: [] },
  ]
  const { edges, unresolved } = resolveLinks(nodes)
  // "engine" (alias) and "sync-engine" (file name) both reach n1 as mentions: one edge.
  assert.deepEqual(edges, [
    { type: 'about', from: 'n2', to: 'n1' },
    { type: 'mentions', from: 'n2', to: 'n1' },
  ])
  assert.deepEqual(unresolved.map(u => [u.target, u.reason]), [
    ['Missing', 'missing'],
    ['dup', 'ambiguous'],
  ])
})

test('supersede heads follow the chain; loops are caught', () => {
  const { head } = supersedeHeads([
    { type: 'supersedes', from: 'v2', to: 'v1' },
    { type: 'supersedes', from: 'v3', to: 'v2' },
  ])
  assert.equal(head.get('v1'), 'v3')
  assert.equal(head.get('v2'), 'v3')
  const loop = supersedeHeads([
    { type: 'supersedes', from: 'x', to: 'y' },
    { type: 'supersedes', from: 'y', to: 'x' },
  ])
  assert.deepEqual(loop.cycles.sort(), ['x', 'y'])
})

test('hubs: degree at or above max(minDegree, percentile)', () => {
  const edges = Array.from({ length: 30 }, (_, i) => ({ type: 'mentions' as const, from: 'home', to: `n${i}` }))
  const ids = ['home', ...edges.map(e => e.to)]
  assert.deepEqual([...findHubs(ids, adjacency(edges), { exclude: [], minDegree: 20, percentile: 95 })], ['home'])
  assert.deepEqual([...findHubs(ids, adjacency(edges), { exclude: ['n3'], minDegree: 50, percentile: 95 })], ['n3'])
})

test('ids: format, and seeded ids repeat', () => {
  const a = newId('dec', 1_760_000_000_000, seededRandom('x'))
  assert.ok(isValidId(a), a)
  assert.equal(a, newId('dec', 1_760_000_000_000, seededRandom('x')))
  assert.notEqual(a, newId('dec', 1_760_000_000_000, seededRandom('y')))
  // One generator used twice in the same millisecond still gives two different ids.
  const gen = seededRandom('batch')
  assert.notEqual(newId('not', 1, gen), newId('not', 1, gen))
  assert.ok(!isValidId('dec_short'))
})
