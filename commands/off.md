---
description: Turn Thenwise memory off for this project, or everywhere with "all"
allowed-tools: Bash
argument-hint: "[all]"
---

If the argument is "all", run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" off`. Otherwise run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" off --project "$PWD"`. Show the output as it is. Off stops archiving, plan history, and reading commits, PRs and CLAUDE.md of that project. Records already stored stay until `forget`.
