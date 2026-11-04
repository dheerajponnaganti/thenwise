---
description: Turn Thenwise memory back on for this project, or everywhere with "all"
allowed-tools: Bash
argument-hint: "[all]"
---

If the argument is "all", run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" on`. Otherwise run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" on --project "$PWD"`. Show the output as it is.
