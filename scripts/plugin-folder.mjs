#!/usr/bin/env node
// Fills plugin/ with what every tool installs: the manifests, hooks, commands, skills and the built dist/. The marketplace
// names this folder as the plugin's source, so one clone of main installs it. Run it in the release PR, then commit plugin/.
// Between releases plugin/ stays as released, so a fresh install never pairs new hooks with an old build.
// Usage: npm run plugin:folder
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

// What the plugin reads at run time, relative to the repo root. dist/ comes from the build; package.json makes it ESM.
export const PLUGIN_FILES = [
  '.claude-plugin/plugin.json',
  '.plugin',
  '.codex-plugin',
  '.antigravity-plugin',
  'hooks',
  'hooks.json',
  'mcp_config.json',
  '.mcp.json',
  '.mcp.codex.json',
  'commands',
  'skills',
  'package.json',
  'LICENSE',
]

/** Empties out, then copies PLUGIN_FILES from source and the built dist into it. A missing file throws. */
export function assemble(source, dist, out) {
  rmSync(out, { recursive: true, force: true })
  for (const f of PLUGIN_FILES) {
    mkdirSync(dirname(join(out, f)), { recursive: true })
    cpSync(join(source, f), join(out, f), { recursive: true })
  }
  cpSync(dist, join(out, 'dist'), { recursive: true })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // plugin/ must be the committed source: an uncommitted edit or a stray file (.DS_Store, a draft command) would ship.
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'src', 'tsconfig.json', 'tsconfig.build.json', 'package-lock.json', ...PLUGIN_FILES], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) {
    console.error(`plugin:folder: commit or remove these first:\n${dirty}`)
    process.exit(1)
  }
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  assemble(ROOT, join(ROOT, 'dist'), join(ROOT, 'plugin'))
  console.log('plugin/ rebuilt: commit it with the release')
}
