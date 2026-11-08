# Commands

## The memory tools

Every tool reaches for these on its own when a question needs history.

| Tool | Ask it |
| --- | --- |
| `memory_search` | "Find what we said about the exporter." |
| `memory_current` | "What is the setup now?" |
| `memory_why` | "Why is the limit 600 tokens?" |
| `memory_tried` | "What did we try before shards?" |
| `memory_asof` | "What was the latest release at 06:50 UTC on the 25th?" |
| `memory_trace` | "Tell me the whole story of `src/cache.ts`." |
| `memory_read` | "Show me that record in full." |
| `memory_resume` | "Continue where the last session stopped." |

Every answer cites its source and date. A result line reads date, project and source, and its id opens the record with `memory_read`. When a newer record replaces an older one (it supersedes it, carries its title, touches the same PR, or is a later commit to the same file), a `NEWER` line under the older one names it. When no shown passage holds all of a question's rare words, the answer says so in one line.

## In Claude Code and Copilot CLI

- `/thenwise:status`: what is stored and when it last synced.
- `/thenwise:resume [topic]`: brief the agent on past work.
- `/thenwise:why <words>`, `/thenwise:tried <words>`, `/thenwise:asof <date> <words>`: ask the memory directly.
- `/thenwise:deadend <what failed>` and `/thenwise:decide <what was decided>`: keep a dead end or a decision on purpose.
- `/thenwise:off [all]` and `/thenwise:on [all]`: pause or resume memory for this project, or everywhere.
- `/thenwise:forget <session id or project folder>`: remove a chat or a project from memory.
- `/thenwise:backup`: back up the vault now.
- `/thenwise:inbox [accept <id...> | reject <id...>]`: review the notes Thenwise proposed from your chats, commits and PRs.
- `/thenwise:logs`: the latest log lines, errors first.
- `/thenwise:shown`: exactly what Thenwise added to the agent in this session, block by block.
- `/thenwise:report [what happened]`: report a problem or an idea. The agent drafts it, you read every line, nothing is sent without your yes.

Codex and Antigravity load no plugin commands, so Thenwise names each of these as the terminal line that runs it.

## In the terminal

- `thenwise setup`, `thenwise doctor`, `thenwise status`.
- `thenwise logs [--errors] [--since 1h]`: what Thenwise did and what failed.
- `thenwise report [--what <text>] [--send | --open | --copy]`: an issue report with versions, doctor and recent errors, never chat text. Shown in full first; sent only when you say yes.
- `thenwise archive`, `thenwise ingest [--full]`.
- `thenwise search|current|why|tried|trace <words>`, `thenwise asof <date> <words>`, `thenwise resume [words]`, with `--here`, `--project <folder>` or `--all`.
- `thenwise tests <test command or file> [--here]`: the files whose edits that test failed right after in past chats, most often first. The hooks give the same lines when the test runs, and before an edit they name the tests that failed after edits to that file.
- `thenwise cost [words] [--since 7d|<date>]` and `/thenwise:cost`: what the chats cost, per tool and per project, and the share spent in chats that hit a dead end. Each tool counts by its own record: Claude Code gives dollars (at API prices) and tokens, Codex gives tokens; a tool whose chat files hold no cost is named, never guessed. With words, only chats about them.
- `thenwise off|on [--project <path>]`.
- `thenwise vault write`: write the curated notes (decisions, dead ends, timeline, file histories) to your vault in a `_thenwise/` folder. Your own notes are read and never rewritten.
- `thenwise notices all|important|off`: how much Thenwise tells you.
- `thenwise connect <tool> [--remove]`: give Cursor, Gemini CLI, OpenCode, Codex or Antigravity the memory tools through MCP.
- `thenwise forget`, `thenwise uninstall`: see [privacy.md](privacy.md).
- Teams: see [teams.md](teams.md).

## Hooks

- **Session start** syncs in the background. In a repo with a session in the last 7 days it adds a brief of at most 200 tokens. When another chat in the project stopped recently, in any of the tools, it adds that chat's handoff: the task, where it stopped, the files it edited, the last test and what is uncommitted now.
- **After a compaction**, a resume brief of at most 1,500 tokens.
- **A prompt that asks about the past** gets at most three pointers, about 300 tokens. Most prompts get nothing.
- **Opening or editing a file** adds its dead ends and decisions, at most 600 tokens, once per file per session. A file whose only history is its last change gets nothing. In Codex the hint arrives before `apply_patch`.
- **A question for the next agent:** a line `[question] <the question>` in any chat shows in the next agent's handoff until a later chat answers it with `[answer q-xxxx] ...`.

Turn the prompt pointers or the brief off with `"hooks": { "prompt_map": false, "startup_brief": false }` in config.json. You see one line when Thenwise hands work over, when something fails, on first run and when notes wait. `thenwise notices important` keeps only first run and failures, and `thenwise notices off` shows none. A hook never fails the chat; errors go to the log.
