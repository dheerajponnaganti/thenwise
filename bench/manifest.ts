// Phase 1 gate N1: the manifest stays within its budget on real vaults.
// Read-only: no file in the vault is written. Usage: node bench/manifest.ts <vault> [--legacy-index <note>] [--legacy-tasks <note>] [--label name]

import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildManifest, DEFAULT_MANIFEST, openCheckboxes } from '../src/core/manifest.ts'
import { nodeIO } from '../src/host/node-io.ts'
import { FilesStore, loadVaultConfig } from '../src/store-files/files-store.ts'

const flag = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)

  return i > 0 ? process.argv[i + 1] : undefined
}
const vault = resolve(process.argv[2] ?? 'fixtures/vault-sample')
const label = flag('label') ?? 'manifest'
const config = await loadVaultConfig(nodeIO, vault)
const store = new FilesStore(nodeIO, vault, null, { hubs: config.hubs })
const opened = await store.open()
const indexNote = flag('legacy-index') ?? config.legacyIndexNote
const tasksNote = flag('legacy-tasks') ?? config.legacyTasksNote
const read = async (n: string | null | undefined) => (n ? await nodeIO.readText(`${vault}/${n}`) : null)
const indexText = await read(indexNote)
const tasksText = await read(tasksNote)
const t0 = performance.now()
const m = buildManifest(await store.manifestData({ maxTopics: DEFAULT_MANIFEST.maxTopics }), {
  ...DEFAULT_MANIFEST,
  budgetTokens: config.manifestBudget,
  vaultPath: vault,
  ...(indexText !== null && indexNote ? { legacyIndex: { name: indexNote.replace(/\.md$/, ''), text: indexText } } : {}),
  ...(tasksText !== null && tasksNote ? { legacyTasks: openCheckboxes(tasksText), legacyTasksFrom: tasksNote.replace(/\.md$/, '') } : {}),
})
const ms = performance.now() - t0
await mkdir(resolve('bench/out'), { recursive: true })
await writeFile(resolve(`bench/out/${label}.txt`), m.text)
const result = { label, notes: opened.files, budget: config.manifestBudget, tokens: m.tokens, isWhole: m.isWhole, counts: m.counts, buildMs: ms, pass: m.tokens <= config.manifestBudget }
console.log(JSON.stringify(result, null, 2))
