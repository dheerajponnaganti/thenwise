---
description: Forget a chat or a whole project: remove it from the archive, the store, backups and shared notes
allowed-tools: Bash
argument-hint: "<session id or project folder>"
---

Run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" forget $ARGUMENTS` without `--yes` first and show the output as it is. If it asks for confirmation and the person agrees, run it again with `--yes`. Never add `--yes` before the person has seen what will go.
