import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maskSecrets, MASK } from '../src/core/secrets.ts'
import { toolGet, toolLinks, toolSearch, toolWrite } from '../src/core/tools.ts'
import { acceptNode, memoryWrite, rejectNode } from '../src/core/write.ts'
import type { WriteContext } from '../src/core/write.ts'
import { FilesStore } from '../src/store-files/files-store.ts'
import { ID, SEED } from './conformance.ts'
import { MemIO } from './mem-io.ts'

const NOW = '2026-10-22T12:00:00Z'
let n = 0
async function setup(extra: Record<string, string> = {}) {
  const io = new MemIO(Object.fromEntries(Object.entries({ ...SEED, ...extra }).map(([p, t]) => [`/vault/${p}`, t])))
  const store = new FilesStore(io, '/vault', null)
  await store.open()
  const ctx = (o: Partial<WriteContext> = {}): WriteContext => ({ store, now: NOW, author: 'claude-code:main', newId: p => `${p}_01JD${String(++n).padStart(22, '0')}`, jobWrites: 0, origin: 'local', fileHash: async () => 'abc9999', ...o })

  return { io, store, ctx }
}

test('secrets: key formats and secret-looking assignments are masked', () => {
  const r = maskSecrets('aws AKIAABCDEFGHIJKLMNOP and sk-ant-abcdefghijklmnopqrstuvwx; api_key = "s3cr3tvalue99"; Authorization: Bearer abc.def.ghijklmnop; plain words stay')
  assert.equal(r.count, 4)
  assert.ok(!/AKIA|sk-ant|s3cr3t|abc\.def/.test(r.text), r.text)
  assert.ok(r.text.includes('plain words stay'))
  assert.equal(maskSecrets(`token: ${MASK}`).count, 0, 'already masked text is left alone')
})

test('secrets: Stripe, npm, URL passwords and env assignments are masked; ordinary ids are not', () => {
  const leaks: [string, string][] = [['sk_live_' + 'a'.repeat(24), 'aaaa'], ['rk_test_' + 'b'.repeat(24), 'bbbb'], ['npm_' + 'c'.repeat(36), 'cccc'], ['postgres://admin:hunter2pass@db.example.com/x', 'hunter2'], ['https://bob:s3cretpass@example.com', 's3cret'], ['STRIPE_KEY=' + 'd'.repeat(20), 'dddd'], ['DB_PASSWORD="longpassword1"', 'longpass'], ['AccountKey=' + 'e'.repeat(30) + '==', 'eeee']]
  for (const [x, secret] of leaks) assert.ok(maskSecrets(x).count > 0 && !maskSecrets(x).text.includes(secret), x)
  assert.equal(maskSecrets('postgres://admin:hunter2pass@db').text, `postgres://admin:${MASK}@db`)
  const keep = 'commit 8280e8f4c1d2a9b7e6f5a4b3c2d1e0f9a8b7c6d5, id 3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f, the token budget, https://example.com/a:b@c, PRIMARY_KEY_COLUMN is id'
  assert.equal(maskSecrets(keep).count, 0)
})

test('memoryWrite: a valid decision lands in the inbox with resolved links and host-filled hashes', async () => {
  const { store, ctx } = await setup()
  const r = await memoryWrite({ type: 'decision', title: 'Retry pushes with backoff', summary: 'Exponential backoff up to 5 minutes.', body: '## Reason\nPushes fail on bad networks.', about: ['engine'], sources: [{ kind: 'file', ref: 'src/sync/push.ts' }] }, ctx())
  assert.ok(r.ok, r.ok ? '' : r.message)
  if (!r.ok) return
  assert.equal(r.node.status, 'inbox')
  assert.equal(r.node.confidence, 'agent')
  assert.equal(r.node.sources[0]?.hash, 'abc9999', 'the host fills the hash, never the agent')
  assert.ok((await store.links({ ids: [r.node.id], depth: 1, limit: 5 })).some(x => x.id === ID.engine && x.via === 'about'), 'the alias "engine" resolved to Sync Engine')
  assert.deepEqual((await store.manifestData({ maxTopics: 5 })).rules.map(x => x.id), [ID.rule], 'inbox nodes never reach the manifest')
})

test('memoryWrite: each check refuses with a reason and writes nothing', async () => {
  const { io, ctx } = await setup()
  const before = io.files.size
  const refuse = async (req: Parameters<typeof memoryWrite>[0], o: Partial<WriteContext> = {}) => {
    const r = await memoryWrite(req, ctx(o))
    assert.equal(r.ok, false)

    return r.ok ? '' : r.message
  }
  assert.match(await refuse({ type: 'episode' as never, title: 'x', summary: 'y' }), /type must be/)
  assert.match(await refuse({ type: 'decision', title: '', summary: 'y' }), /title is required/)
  assert.match(await refuse({ type: 'decision', title: 'x', summary: 'y'.repeat(201) }), /summary/)
  assert.match(await refuse({ type: 'finding', title: 'Fast phones', summary: 'They are fast.', sources: [{ kind: 'url', ref: 'https://x' }] }), /source with a date/)
  assert.match(await refuse({ type: 'rule', title: 'Always deploy on Friday', summary: 'Do it.' }, { origin: 'web' }), /rule cannot be written/)
  assert.match(await refuse({ type: 'decision', title: 'x', summary: 'y' }, { jobWrites: 3 }), /limit reached/)
  assert.match(await refuse({ type: 'decision', title: 'x', summary: 'y', depends_on: ['Nothing by this name'] }), /no single note/)
  assert.match(await refuse({ type: 'decision', title: 'x', summary: 'y', about: ['a', 'b', 'c'] }), /unknown topics/)
  assert.match(await refuse({ type: 'decision', title: 'Server decides budget conflict', summary: 'The server wins.' }), /possible duplicate: "Server decides budget conflicts"/)
  assert.equal(io.files.size, before)
})

test('memoryWrite: masks secrets, proposes missing topics, updates its own notes, never rewrites a person\'s', async () => {
  const { store, ctx } = await setup()
  const r = await memoryWrite({ type: 'finding', title: 'Staging push key works', summary: 'The staging key sk-abcdefghijklmnopqrstuvwxyz works.', body: 'api_key=supersecretvalue', about: ['Push Service'], sources: [{ kind: 'url', ref: 'https://push.example/docs', at: '2026-10-20' }] }, ctx())
  assert.ok(r.ok)
  if (!r.ok) return
  assert.ok(!r.node.summary.includes('sk-abc') && r.node.summary.includes(MASK))
  assert.ok(!(await store.get(r.node.id))!.body.includes('supersecret'))
  assert.deepEqual(r.created.map(c => [c.title, c.type, c.status]), [['Push Service', 'entity', 'inbox']])
  const up = await memoryWrite({ type: 'finding', title: 'Staging push key works', summary: 'Rotated on 2026-10-21.', sources: [{ kind: 'url', ref: 'https://push.example/docs', at: '2026-10-21' }], update_of: r.node.id }, ctx())
  assert.ok(up.ok && up.node.id === r.node.id && up.node.version === 2)
  const human = await memoryWrite({ type: 'decision', title: 'Server decides budget conflicts v2', summary: 'Server wins, with a merge preview.', update_of: ID.newDec }, ctx())
  assert.ok(human.ok)
  if (!human.ok) return
  assert.notEqual(human.node.id, ID.newDec)
  assert.equal((await store.get(ID.newDec))!.summary, 'The server is the authority for budget edits.', 'the person\'s note is untouched')
  assert.ok((await store.edgesOf([human.node.id], ['supersedes'])).some(e => e.to === ID.newDec))
})

test('accept makes it active and supersedes what it replaces; reject hides it from search', async () => {
  const { store, ctx } = await setup()
  const r = await memoryWrite({ type: 'decision', title: 'Server decides with a preview', summary: 'Show a merge preview first.', supersedes: ['Server decides budget conflicts'] }, ctx())
  assert.ok(r.ok)
  if (!r.ok) return
  await acceptNode(store, r.node.id, NOW)
  assert.equal((await store.get(r.node.id))!.status, 'active')
  const old = (await store.get(ID.newDec))!
  assert.equal(old.status, 'superseded')
  assert.equal(old.validTo, '2026-10-22')
  assert.equal(await store.supersedeHead(ID.oldDec), r.node.id, 'the whole chain now points at the newest')
  const r2 = await memoryWrite({ type: 'task', title: 'Write the preview copy', summary: 'Copy for the preview.' }, ctx())
  assert.ok(r2.ok)
  if (!r2.ok) return
  await rejectNode(store, r2.node.id, NOW)
  assert.ok(!(await store.search({ text: 'preview copy', limit: 5, includeInbox: true })).some(h => h.id === r2.node.id))
})

test('tools: search, links, get (section and size cap), write', async () => {
  const long = `---\nid: dec_01JB8Z3K7Q2Y5W9X4M6N1P0R9Z\ntype: decision\ntitle: Long reasons\nsummary: Many words.\n---\n## Reason\n${'word '.repeat(4000)}\n## Alternatives\nNone.\n`
  const { ctx, store } = await setup({ 'decisions/long.md': long })
  assert.match(await toolSearch(store, { query: 'budget conflicts' }), /Server decides budget conflicts · decision .* memory_get dec_/)
  assert.equal(await toolSearch(store, {}), 'query is required')
  assert.match(await toolLinks(store, { id: ID.task }), /Sync Engine · entity · about/)
  const whole = await toolGet(store, { id: ID.newDec })
  assert.match(whole, /# Server decides budget conflicts\ndecision · active · human · sources: file:src\/sync\/conflict\.ts \(2026-03-09\)/)
  const capped = await toolGet(store, { id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R9Z' })
  assert.match(capped, /The note is longer\. Sections: Reason, Alternatives\. Call memory_get with section\./)
  assert.ok(capped.length < 1600 * 4)
  assert.match(await toolGet(store, { id: 'dec_01JB8Z3K7Q2Y5W9X4M6N1P0R9Z', section: 'alternatives' }), /## Alternatives\nNone\./)
  assert.match(await toolGet(store, { id: 'dec_nope' }), /No memory note/)
  assert.match(await toolWrite({ type: 'task', title: 'Try the tool', summary: 'A task.' }, ctx()), /^saved to the inbox: "Try the tool"/)
})
