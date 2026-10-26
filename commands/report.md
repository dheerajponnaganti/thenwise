---
description: Report a Thenwise issue to GitHub, after you check every line
argument-hint: [what happened]
allowed-tools: Bash, AskUserQuestion
---

Help the user report a Thenwise problem or idea.

1. Draft "what happened" in two to four plain sentences from this conversation and from `$ARGUMENTS`: what the user did, what they expected, what Thenwise did. If a memory tool failed with an error code such as `E4F2`, note the code. Write no chat text, file contents, secrets or project names into it.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report --what "<draft>"` (add `--code <code>` if there is one, or `--idea` for an idea). It sends nothing; it prints the full report and saves it.
3. Show the user the whole report as printed. Ask with AskUserQuestion whether to send it, offering: "Send with gh" (`--send`), "Open the GitHub form" (`--open`), "Copy to clipboard" (`--copy`), "Edit first", and "Don't send".
4. On "Edit first", take their changes and go back to step 2. On a send choice, run the same command with that flag and `--yes`, and show what it printed. On "Don't send", say where the report was saved.

Never add `--yes` before the user has chosen to send.
