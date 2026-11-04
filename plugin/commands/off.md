---
description: Turn Thenwise memory off for this project, or everywhere with "all"
allowed-tools: Bash
argument-hint: "[all]"
---

If the argument is "all", run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" off`. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" off --project "$PWD"`. Show the output as it is. Off stops archiving, plan history, and reading commits, PRs and CLAUDE.md of that project. Records already stored stay until `forget`.
