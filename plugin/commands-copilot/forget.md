---
description: Forget a chat or a whole project: remove it from the archive, the store, backups and shared notes
argument-hint: "<session id or project folder>"
---

Run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" forget $ARGUMENTS` first and show the output as it is. If it asks for confirmation and the person agrees, run `node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" forget $ARGUMENTS --yes`. Your tool asks the person before each run, since forget deletes. Never add `--yes` before the person has seen what will go.
