import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import * as c from '../src/query/commands.ts'
import { Graph } from '../src/query/engine.ts'
import { World } from './world.ts'

test('a chat turn in an answer says what it changed: files edited, the commit it made; a turn that changed nothing says nothing', () => {
  const w = new World()
  try {
    const sha = w.commit(w.proj, 'src/cache.ts', 'Split the cache into shards', '', new Date(Date.now() - 60e3).toISOString())
    w.chat('s1', {
      turns: [
        { prompt: 'try a mutex pool in front of the walrus cache', reply: 'Tried the mutex pool, it made contention worse, so I reverted it.', edits: [join(w.proj, 'src/cache.ts'), join(w.proj, 'src/pool.ts')], commit: { subject: 'Split the cache into shards', sha } },
        { prompt: 'what did the walrus benchmark say', reply: 'The walrus benchmark was flat.' },
      ],
    })
    w.archive()
    const g = new Graph(w.ingest('a.db').db)
    const out = c.tried(g, 'walrus mutex pool')
    assert.match(out, /did: edited src\/cache\.ts, src\/pool\.ts; commit [0-9a-f]{7} "Split the cache into shards"/)
    const quiet = c.search(g, 'walrus benchmark flat')
    const block = quiet.split(/\n\n/).find((b) => b.includes('turn:s1-1'))!
    assert.ok(block && !block.includes('did:'), 'a turn that changed nothing gets no line')
  } finally {
    w.destroy()
  }
})

test('a chat run in a subfolder names its edits from the checkout top, as the test hints do', () => {
  const w = new World()
  try {
    w.chat('s2', { cwd: join(w.proj, 'src'), turns: [{ prompt: 'fix the otter cache test', reply: 'Fixed the otter cache test.', edits: [join(w.proj, 'test/cache.test.ts'), join(w.proj, 'src/pool.ts')] }] })
    w.archive()
    const did = /did: edited (.+)/.exec(c.search(new Graph(w.ingest('a.db').db), 'otter cache test'))?.[1]
    assert.deepEqual(did?.split(', ').sort(), ['src/pool.ts', 'test/cache.test.ts'])
  } finally {
    w.destroy()
  }
})
