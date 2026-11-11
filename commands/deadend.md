---
description: Record a dead end
argument-hint:  an approach that failed, so it is not tried again:<what failed and why>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" deadend --here *)
---

Write the dead end in one or two plain sentences from `$ARGUMENTS` and this conversation, with the reason. Then run this command with the sentences in place of the middle line, and show what it printed:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" deadend --here <<'THENWISE_END'
the sentences
THENWISE_END
```

Keep the first and last lines exactly as they are. The sentences go in on stdin, so nothing in them runs.
