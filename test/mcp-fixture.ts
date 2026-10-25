// A small synthetic graph for the MCP and hook tests. Nothing here comes from a real transcript.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildPassageIndex } from '../src/query/passages.ts'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'thenwise-s56-'))
}

/** Writes a graph.db into `dir` (made if needed). `extra` adds one more turn so a second version differs. */
export function writeGraph(dir: string, extra = '', cwd = '/x/p'): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'graph.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, at TEXT, until TEXT, project TEXT, source TEXT, extra TEXT);
CREATE TABLE edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, at TEXT, extra TEXT, PRIMARY KEY(src, dst, kind));`)
  const node = (id: string, kind: string, title: string, text: string, at: string, source = '', ex: object = {}, until = '') => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)').run(id, kind, title, text, at, until, 'p', source, JSON.stringify(ex))
  const edge = (src: string, dst: string, kind: string) => db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(src, dst, kind, '', '{}')
  node('ses:s1', 'session', 'work', 'work', '2026-10-05T09:00:00Z', '', { cwd }, '2026-10-07T12:00:00Z')
  node('turn:t1', 'turn', 'single file cache', 'We tried a single cache file for the storage layer. It failed under load and we reverted it.', '2026-10-05T10:00:00Z', 'ses:s1', { deadEnd: 'It failed under load and we reverted it.' })
  node('turn:t2', 'turn', 'storage chat', 'Decision: use eight cache shards because one big file got slow. Telugu: నమస్తే. Emoji: 🚀.', '2026-10-06T10:00:00Z', 'ses:s1')
  node('sum:s1a', 'summary', 'summary', 'The cache work moved to shards. Next: measure the shard size.', '2026-10-07T11:00:00Z', 'ses:s1')
  node('pr:proj#7', 'pr', 'Add cache module', 'Adds the cache module in src/cache.ts because the old one failed.', '2026-10-02T00:00:00Z', 'https://example.test/pull/7', { state: 'OPEN', url: 'https://example.test/pull/7' })
  node('commit:proj:abcdef1234567', 'commit', 'Rework cache', 'Reworks the cache module', '2026-10-12T00:00:00Z', '/x/p', { sha: 'abcdef1234567' })
  node('file:/x/p/src/cache.ts', 'file', 'cache.ts', '', '', '', { aliases: ['src/cache.ts'] })
  edge('pr:proj#7', 'file:/x/p/src/cache.ts', 'touches')
  edge('commit:proj:abcdef1234567', 'file:/x/p/src/cache.ts', 'changed')
  edge('turn:t1', 'ses:s1', 'part_of')
  edge('turn:t2', 'ses:s1', 'part_of')
  edge('sum:s1a', 'ses:s1', 'part_of')
  edge('turn:t1', 'file:/x/p/src/cache.ts', 'read')
  if (extra) node('turn:t9', 'turn', extra, `${extra} is a brand new topic about zebras.`, '2026-10-08T10:00:00Z', 'ses:s1')
  buildPassageIndex(db)
  db.close()

  return file
}
