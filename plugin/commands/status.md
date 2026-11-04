---
description: Show what Thenwise has stored and when it last synced
allowed-tools: Bash
---

Run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" hook status` and show its output as it is. If `node` is not found or is too old, tell the user Thenwise needs Node 22.16 or later from https://nodejs.org, then a new session.
