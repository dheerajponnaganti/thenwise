---
description: Show the latest Thenwise log lines, errors first
allowed-tools: Bash
---

Run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" logs --lines 30 $ARGUMENTS` and show its output as it is. Then list any ERROR or WARN lines on their own, with their error codes.
