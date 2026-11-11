---
description: Review the notes Thenwise proposed from chats, commits and PRs, and accept or reject them
argument-hint: [accept <id...> | reject <id...>]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" inbox) Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" accept *) Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" reject *), AskUserQuestion
---

If `$ARGUMENTS` starts with accept or reject, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" accept <ids>` or `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" reject <ids>` with the ids from it, and show what it printed.

Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" inbox` and show the notes. If there are any, ask with AskUserQuestion which to accept and which to reject (by id), then run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" accept <ids>` and `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" reject <ids>` and show what they printed. Accept nothing the person did not choose.
