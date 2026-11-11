---
description: Review the notes Thenwise proposed from chats, commits and PRs, and accept or reject them
argument-hint: [accept <id...> | reject <id...>]
---

If `$ARGUMENTS` starts with accept or reject, run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" accept <ids>` or `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" reject <ids>` with the ids from it, and show what it printed.

Otherwise run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" inbox` and show the notes. If there are any, ask with AskUserQuestion which to accept and which to reject (by id), then run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" accept <ids>` and `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" reject <ids>` and show what they printed. Accept nothing the person did not choose.
