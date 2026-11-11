---
description: Record a decision and its reason
argument-hint: <what was decided and why>
---

Write the decision in one or two plain sentences from `$ARGUMENTS` and this conversation, with the reason. Then run this command with the sentences in place of the middle line, and show what it printed:

```sh
node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/thenwise/thenwise/dist/cli.js" decide --here <<'THENWISE_END'
the sentences
THENWISE_END
```

Keep the first and last lines exactly as they are. The sentences go in on stdin, so nothing in them runs.
