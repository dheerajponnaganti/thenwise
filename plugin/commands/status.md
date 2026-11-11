---
description: Show what Thenwise has stored and when it last synced
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook status)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook status` and show its output as it is. If `node` is not found or is too old, tell the user Thenwise needs Node 22.16 or later from https://nodejs.org, then a new session.
