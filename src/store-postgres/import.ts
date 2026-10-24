// `memory import <vault> --postgres`: loads a Markdown vault into a Postgres scope (spec 04 §6).
// The vault is parsed by the Files index, so ids, links and hubs resolve exactly as in Files mode.

import { resolve } from 'node:path'

import type { Pool } from 'pg'

import type { IO } from '../core/io.ts'
import { DEFAULT_CONFIG } from '../core/vault-index.ts'
import { nodeIO } from '../host/node-io.ts'
import { FilesStore } from '../store-files/files-store.ts'
import { PgStore } from './pg-store.ts'
import type { PgStoreOptions, Scope } from './pg-store.ts'

export async function importVault(pool: Pool, scope: Scope, vault: string, opts: PgStoreOptions & { io?: IO } = {}): Promise<{ files: number; notes: number; edges: number; unresolved: number }> {
  const files = new FilesStore(opts.io ?? nodeIO, opts.io ? vault : resolve(vault), null, { hubs: opts.hubs ?? DEFAULT_CONFIG.hubs })
  const opened = await files.open()
  const loaded = await new PgStore(pool, scope, opts).importIndex(files.index)

  return { files: opened.files, ...loaded }
}
