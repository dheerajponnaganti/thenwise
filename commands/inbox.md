---
description: Review the notes Thenwise proposed from chats, commits and PRs, and accept or reject them
argument-hint: [accept <id...> | reject <id...>]
allowed-tools: Bash, AskUserQuestion
---

If `$ARGUMENTS` starts with accept or reject, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS` and show what it printed.

Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" inbox` and show the notes. If there are any, ask with AskUserQuestion which to accept and which to reject (by id), then run `accept <ids>` and `reject <ids>` the same way and show what they printed. Accept nothing the person did not choose.
