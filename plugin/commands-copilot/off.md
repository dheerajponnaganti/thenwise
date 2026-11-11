---
description: Turn Thenwise memory off for this project, or everywhere with "all"
argument-hint: "[all]"
---

If the argument is "all", run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" off`. Otherwise run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" off --project .`. Show the output as it is. Off stops archiving, plan history, and reading commits, PRs and CLAUDE.md of that project. Records already stored stay until `forget`.
