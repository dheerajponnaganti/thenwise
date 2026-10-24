import { after, before, describe } from 'node:test'

import { importVault } from '../src/store-postgres/import.ts'
import { PgStore } from '../src/store-postgres/pg-store.ts'
import { runConformance } from './conformance.ts'
import { MemIO } from './mem-io.ts'
import { pgSkip } from './pg-cluster.ts'
import { pgFixture, SCOPE_A } from './pg-helpers.ts'
import type { PgFixture } from './pg-helpers.ts'

describe('postgres store', { skip: pgSkip }, () => {
  let fx: PgFixture
  before(async () => {
    fx = await pgFixture()
  })
  after(() => fx?.stop())

  runConformance('postgres', async seed => {
    const db = await fx.fresh()
    const io = new MemIO(Object.fromEntries(Object.entries(seed).map(([p, t]) => [`/vault/${p}`, t])))
    await importVault(db.pool, SCOPE_A, '/vault', { io })

    return { store: new PgStore(db.pool, SCOPE_A), close: db.close }
  })
})
