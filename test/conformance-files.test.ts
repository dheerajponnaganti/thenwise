import { FilesStore } from '../src/store-files/files-store.ts'
import { runConformance } from './conformance.ts'
import { MemIO } from './mem-io.ts'

runConformance('files', async seed => {
  const io = new MemIO(Object.fromEntries(Object.entries(seed).map(([p, t]) => [`/vault/${p}`, t])))
  const store = new FilesStore(io, '/vault', '/cache/index.json')
  await store.open()

  return { store }
})
