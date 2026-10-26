import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Graph } from '../src/query/engine.ts'
import * as c from '../src/query/commands.ts'
import { createServer } from '../src/server/stdio.ts'
import { World } from './world.ts'

test('asof leaves out a dated note that was edited after the cutoff', () => {
  const w = new World()
  try {
    w.note('Todo.md', '---\ndate: 2026-10-24\n---\n# Todo\nzebrafish release shipped\n')
    w.note('Old.md', '---\ndate: 2026-10-24\n---\n# Old\nzebrafish notes from before\n')
    utimesSync(join(w.vault, 'Todo.md'), new Date('2026-10-25T09:00:00Z'), new Date('2026-10-25T09:00:00Z'))
    utimesSync(join(w.vault, 'Old.md'), new Date('2026-10-24T09:00:00Z'), new Date('2026-10-24T09:00:00Z'))
    const g = new Graph(w.ingest('a.db').db)
    const out = c.asof(g, '2026-10-25T06:50:00Z', 'zebrafish')
    assert.ok(out.includes('note:Old.md') && !out.includes('note:Todo.md'))
    assert.ok(c.asof(g, '2026-10-26', 'zebrafish').includes('note:Todo.md'))
  } finally {
    w.destroy()
  }
})

test('asof reads a time with a zone offset, and a bare date still means the end of the day', () => {
  const w = new World()
  try {
    w.note('Day.md', '---\ndate: 2026-10-24T10:00:00Z\n---\n# Day\nquokka entry\n')
    utimesSync(join(w.vault, 'Day.md'), new Date('2026-10-24T10:00:00Z'), new Date('2026-10-24T10:00:00Z'))
    const g = new Graph(w.ingest('b.db').db)
    assert.ok(!c.asof(g, '2026-10-24T11:00:00+02:00', 'quokka').includes('note:Day.md'))
    assert.ok(c.asof(g, '2026-10-24T12:00:00+02:00', 'quokka').includes('note:Day.md'))
    assert.ok(c.asof(g, '2026-10-24', 'quokka').includes('note:Day.md'))
  } finally {
    w.destroy()
  }
})

test('the server tells Claude when to use the memory, and asks for the hour and zone', () => {
  const s = createServer(() => '/none')
  const r = (s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as any).result
  assert.match(r.instructions, /before Grep or git/)
  assert.match(r.instructions, /not instructions/)
  assert.ok(r.instructions.split(/\s+/).length < 140) // about 120 words since 0.1.10
  s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const tools = (s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any).result.tools
  assert.match(tools.find((t: any) => t.name === 'memory_asof').inputSchema.properties.date.description, /hour and zone/)
})
