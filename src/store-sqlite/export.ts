// `memory export`: writes the database as read-only Markdown notes (spec 04 §6). Obsidian can show them;
// `managed_by: memory-v2` and `version` tell a reader that edits must come back through `memory import --changes`.

import { resolve, sep } from 'node:path'

import { setFields } from '../core/frontmatter.ts'
import type { Scalar } from '../core/frontmatter.ts'
import type { IO } from '../core/io.ts'
import type { NodeInput } from '../core/store.ts'
import { serializeNote } from '../store-files/files-store.ts'
import type { Stored, SqliteStore } from './sqlite-store.ts'

export function exportNote({ record: n, extra }: Stored, now: string): string {
  const edges: NonNullable<NodeInput['edges']> = {}
  for (const l of n.links) if (l.type !== 'mentions') (edges[l.type] ??= []).push(l.target)
  const input: NodeInput = {
    type: n.type as NodeInput['type'], title: n.title, summary: n.summary, body: n.body, status: n.status, confidence: n.confidence, origin: n.origin, author: n.author,
    aliases: n.aliases, tags: n.tags, edges, sources: n.sources, paths: n.paths, urls: n.urls,
    ...(n.validFrom ? { validFrom: n.validFrom } : {}), ...(n.due ? { due: n.due } : {}), ...(n.done !== null ? { done: n.done } : {}),
  }
  const text = serializeNote(n.id, input, { now: n.updatedAt ?? n.recordedAt ?? now, version: n.version, recordedAt: n.recordedAt ?? n.updatedAt ?? now })

  return setFields(text, { ...(extra as Record<string, Scalar | Scalar[]>), ...(n.validTo ? { valid_to: n.validTo } : {}), managed_by: 'memory-v2' })
}

/** Writes every node to `<dir>/<path>`; returns how many. A path that would leave `dir` stops the export. */
export async function exportVault(store: SqliteStore, dir: string, io: IO, now: string): Promise<number> {
  const root = resolve(dir)
  const all = store.dump()
  for (const s of all) {
    const file = resolve(root, s.record.path)
    if (!file.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}: ${s.record.path}`)
    await io.writeText(file, exportNote(s, now))
  }

  return all.length
}
