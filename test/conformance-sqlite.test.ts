import { importVault } from '../src/store-sqlite/import.ts'
import { SqliteStore } from '../src/store-sqlite/sqlite-store.ts'
import { runConformance } from './conformance.ts'

runConformance('sqlite', async seed => {
  const store = new SqliteStore(':memory:')
  importVault(store, seed)

  return { store, close: async () => store.close() }
})
