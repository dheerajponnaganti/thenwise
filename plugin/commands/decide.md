---
description: Record a decision and its reason
argument-hint: <what was decided and why>
allowed-tools: Bash
---

Write the decision in one or two plain sentences from `$ARGUMENTS` and this conversation, with the reason. Then run `R="${CLAUDE_PLUGIN_ROOT}"; node "${R:-${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise}/dist/cli.js" decide "<the sentences>" --here` and show what it printed.
