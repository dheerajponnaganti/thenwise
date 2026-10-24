// Shared setup for the Postgres tests: one throwaway cluster per test file, a migrated template database, a fresh copy per test.

import pg from 'pg'

import { migrate } from '../src/store-postgres/migrate.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import type { PgStoreOptions, Scope } from '../src/store-postgres/pg-store.ts'
import { importVault } from '../src/store-postgres/import.ts'
import { startCluster } from './pg-cluster.ts'
import type { PgCluster } from './pg-cluster.ts'
import { MemIO } from './mem-io.ts'

export interface PgFixture {
  cluster: PgCluster
  /** A new migrated database and a pool on it (as the superuser). Closed with `close`. */
  fresh(): Promise<{ db: string; pool: pg.Pool; close(): Promise<void> }>
  stop(): Promise<void>
}

export async function pgFixture(): Promise<PgFixture> {
  const cluster = await startCluster()
  try {
    const tpl = await cluster.createDb()
    const pool = new pg.Pool(cluster.config(tpl))
    await migrate(pool)
    await pool.end()

    return {
      cluster,
      async fresh() {
        const db = await cluster.createDb(tpl)
        const p = new pg.Pool(cluster.config(db))

        return {
          db,
          pool: p,
          async close() {
            await p.end()
            await cluster.dropDb(db)
          },
        }
      },
      stop: () => cluster.stop(),
    }
  } catch (e) {
    await cluster.stop()
    throw e
  }
}

export const SCOPE_A: Scope = { kind: 'project', key: 'a' }
export const SCOPE_B: Scope = { kind: 'project', key: 'b' }

/** Imports a seed vault (path to Markdown) into a scope through the same path the CLI uses. */
export async function seedScope(pool: pg.Pool, scope: Scope, seed: Record<string, string>, opts: PgStoreOptions = {}): Promise<PgStore> {
  const io = new MemIO(Object.fromEntries(Object.entries(seed).map(([p, t]) => [`/vault/${p}`, t])))
  await importVault(pool, scope, '/vault', { io, ...opts })

  return new PgStore(pool, scope, opts)
}
