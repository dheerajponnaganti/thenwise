// `thenwise off [--project <path>]` and `thenwise on [...]`: pause or resume archiving, everywhere or for one project folder.

import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { expandHome, resolveDataDir } from '../core/home.ts'
import { normPath } from '../core/vault-index.ts'
import { readConfigFile, saveConfig } from '../ingest/config.ts'

export function switchCommand(on: boolean, argv: string[], home: string = homedir()): number {
  const memDir = resolveDataDir(home)
  const read = readConfigFile(memDir)
  if (!read.raw || read.errors.length) {
    for (const e of read.errors) console.error(`error: ${e}`)

    return 2
  }
  const i = argv.indexOf('--project')
  if (i >= 0 && !argv[i + 1]) {
    console.error('usage: thenwise off|on [--project <path>]')

    return 2
  }
  const raw = read.raw
  if (i < 0) {
    saveConfig(memDir, { ...raw, off: !on })
    console.log(on ? 'Thenwise is on everywhere (projects paused one by one stay paused).' : 'Thenwise is off everywhere. Nothing is archived until you run: thenwise on')

    return 0
  }
  const path = normPath(resolve(expandHome(argv[i + 1]!, home)))
  const rest = ((raw.off_projects ?? []) as string[]).filter((p) => normPath(p) !== path)
  saveConfig(memDir, { ...raw, off_projects: on ? rest : [...rest, path] })
  console.log(on ? `Thenwise is on for ${path}.` : `Thenwise is off for ${path}. Nothing from it is archived until you run: thenwise on --project ${path}`)

  return 0
}
