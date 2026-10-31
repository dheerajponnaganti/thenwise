#!/usr/bin/env node
// Checks hooks/hooks.json against the CLI: every entry runs `thenwise hook <name>` from the plugin folder, names a hook the
// CLI handles, sits under a known event and keeps the 3 s timeout. Exits 1 and lists each problem.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'SessionEnd'])
const SCRIPT = '${CLAUDE_PLUGIN_ROOT}/dist/cli.js'
// The hook names runHook answers, read from the source so a new hook needs no edit here.
const handled = new Set([...readFileSync(join(ROOT, 'src/hooks/hook.ts'), 'utf8').matchAll(/name === '([a-z-]+)'/g)].map((m) => m[1]))

/** The hook name an entry runs, or null when its command is not `node <plugin>/dist/cli.js hook <name>`. */
function hookName(h) {
  if (Array.isArray(h.args)) return h.command === 'node' && h.args[0] === SCRIPT && h.args[1] === 'hook' && h.args.length === 3 ? h.args[2] : null
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" hook ([a-z-]+)$/.exec(h.command ?? '')

  return m ? m[1] : null
}

const problems = []
const { hooks } = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'))
for (const [event, groups] of Object.entries(hooks)) {
  if (!EVENTS.has(event)) problems.push(`${event}: not an event Thenwise uses`)
  for (const g of groups) {
    if (g.matcher !== undefined) {
      try {
        new RegExp(g.matcher)
      } catch {
        problems.push(`${event}: matcher ${g.matcher} is not a valid pattern`)
      }
    }
    for (const h of g.hooks) {
      const name = hookName(h)
      if (h.type !== 'command') problems.push(`${event}: type ${h.type}, expected command`)
      if (!name) problems.push(`${event}: command ${JSON.stringify(h.command)} does not run "thenwise hook <name>" from the plugin folder`)
      else if (!handled.has(name)) problems.push(`${event}: hook "${name}" is not handled in src/hooks/hook.ts`)
      if (!(h.timeout > 0 && h.timeout <= 3)) problems.push(`${event}: timeout ${h.timeout}, expected 1 to 3 seconds`)
    }
  }
}

if (problems.length) {
  console.error(`hooks check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`hooks check: ${Object.values(hooks).flat().flatMap((g) => g.hooks).length} hooks fine`)
