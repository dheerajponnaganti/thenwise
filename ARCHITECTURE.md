# Architecture

Thenwise turns past work into one local SQLite store, and answers questions from it with no model. Claude reaches the store through MCP tools, and hooks bring small pointers up on their own.

## The flow

```
Claude Code chats ──> archive() ──> masked copy ─┐
git commits ─────────────────────────────────────┤
pull requests (optional, through gh) ────────────┼─> ingest ──> graph.db ──┬─> MCP tools ──> Claude
notes, CLAUDE.md files, plans ───────────────────┤   (nodes,               ├─> hooks ──────> Claude
team shares (optional) ──────────────────────────┘    edges,               ├─> CLI ────────> you
                                                      passages)            └─> vault ──────> Markdown notes
```

A session start and a session end run a background sync (`thenwise hook sync-run`), which archives and ingests what changed, and writes its progress to `sync-progress.json`. Search only reads the store, so it stays fast and needs no network.

The handoff skips the store: at session start, `src/hooks/handoff.ts` reads the newest chat another session left in the project straight from the tool's own live file (Claude Code, Copilot CLI, Codex or Antigravity), so the next agent knows where the work stopped even before the sync has copied that chat.

## Module responsibilities

`test/architecture-doc.test.ts` checks that every file and symbol below exists and that every `src/` folder is listed, so this table cannot drift from the code.

| File | Entry points | What it does |
| --- | --- | --- |
| `src/ingest/archive.ts` | `archive`, `maskTranscript` | Claude Code chat files to a masked copy in the data folder |
| `src/ingest/transcript.ts` | `parseSession`, `chatLines`, `bashPaths` | One masked chat to sessions, turns, summaries and tool facts |
| `src/ingest/parts.ts` | `sessionPart`, `prPart`, `notesPart`, `curatedPart`, `docsPart`, `memoryPart` | Pure pieces of the graph build, shared by the full and incremental paths |
| `src/ingest/ingest.ts` | `STATE_VERSION`, `signatureOf`, `storeFormat` | Full build of `graph.db`, and the choice between rebuild and update |
| `src/ingest/incremental.ts` | `updateGraph` | Reads only what changed, and ends with the store a rebuild would give |
| `src/ingest/copilot.ts` | `copilotSources`, `copilotConverter`, `asClaudeTool`, `claudeHookInput` | Copilot CLI chats and hook input, turned into Claude Code's format so one reader serves both |
| `src/ingest/plans.ts` | `snapshotPlan`, `plansPart` | Keeps every version of a plan file before it is overwritten |
| `src/ingest/config.ts` | `loadConfig`, `loadConfigSafe`, `isOff` | Reads and validates `config.json`, and answers whether a project is paused |
| `src/ingest/repos.ts` | `repoRoot`, `projectRoot`, `discoverRepos` | Maps folders and worktrees to the project they belong to |
| `src/ingest/prs.ts` | `fetchPrs` | Pull requests through `gh`, when the user turned them on |
| `src/ingest/lock.ts` | `withLock` | One writer at a time on the data folder |
| `src/core/secrets.ts` | `maskSecrets`, `maskDeep`, `MASK_VERSION` | Removes secrets from text before anything is stored |
| `src/core/home.ts` | `resolveDataDir` | Finds the data folder |
| `src/core/tokenize.ts` | `tokenize` | Splits text into search terms |
| `src/core/log.ts` | `logger`, `logsCommand` | The local log, which holds no chat text |
| `src/core/progress.ts` | `writeProgress`, `progressLine`, `incompleteNote` | The sync's progress, for status, the hooks and the memory tools |
| `src/query/passages.ts` | `splitPassages`, `buildPassageIndex` | Cuts text nodes into passages and indexes them in FTS5 |
| `src/query/language.ts` | `buildLanguage`, `similarity` | Typo fixes and word pairs mined from the store |
| `src/query/engine.ts` | `Graph` | Retrieval: BM25 fused with title, link and exact lanes, plus scope and dates |
| `src/query/commands.ts` | `search`, `current`, `why`, `tried`, `asof`, `trace`, `resume`, `pointers`, `get` | Store in, formatted answer out |
| `src/server/stdio.ts` | `createServer`, `serveStdio` | The eight memory tools over MCP stdio |
| `src/hooks/entry.ts` | `nothingToDo`, `hookInput` | The fast path that exits before SQLite loads |
| `src/hooks/hook.ts` | `runHook`, `syncRun`, `syncNotice` | The Claude Code hooks and the background sync |
| `src/hooks/handoff.ts` | `handoffBlock`, `liveChats`, `readLive` | Where another session of the project stopped, read from its live chat file |
| `src/capture/notes.ts` | `readNotes`, `saveNote`, `accept`, `reject` | Curated notes and their inbox |
| `src/capture/distill.ts` | `distill` | Optional: proposes notes through `claude -p`, into the inbox only |
| `src/capture/similar.ts` | `related` | Finds duplicates and contradictions among notes |
| `src/vault/vault.ts` | `buildNotes`, `writeVault` | Writes decisions, dead ends, timelines and file histories as Markdown |
| `src/vault/user.ts` | `skipReason` | Rules for reading the notes people write |
| `src/views/views.ts` | `sessionProjects`, `sourceOf` | Helpers for the vault writer |
| `src/backup/backup.ts` | `backup` | Copies the vault to a git repo or folders. Never the archive or store |
| `src/privacy/forget.ts` | `forget` | Removes a chat or project everywhere, and leaves a tombstone |
| `src/privacy/tombstones.ts` | `loadTombs`, `isForgotten` | Keeps forgotten chats from coming back |
| `src/privacy/perms.ts` | `tighten` | Folders 0700, files 0600 |
| `src/privacy/uninstall.ts` | `uninstall` | Stops the sync and lists what to delete. It deletes nothing |
| `src/setup/setup.ts` | `setup` | First-run setup |
| `src/setup/projects.ts` | `discoverProjects` | Finds projects from the chat folders |
| `src/ingest/antigravity.ts` | `antigravityConverter`, `antigravitySources` | Reads Antigravity transcripts as Claude Code transcripts |
| `src/ingest/codex.ts` | `codexConverter`, `codexSources` | Reads Codex rollout files as Claude Code transcripts |
| `src/setup/connect.ts` | `plan`, `apply` | Adds the memory tools to another coding tool's MCP config |
| `src/setup/update.ts` | `checkForUpdate`, `updateNotice`, `updateStatus` | The daily version check from the background sync, and the notice read from its saved answer |
| `src/setup/doctor.ts` | `runDoctor` | Checks the install, with one fix line per problem |
| `src/setup/off.ts` | `switchCommand` | `thenwise off` and `on` |
| `src/report/report.ts` | `buildReport`, `reportCommand` | Builds an issue report the user reads before sending |
| `src/teams/server.ts` | `createTeamServer`, `invite`, `backupTeam` | The optional team server, with versioned `/v1` routes |
| `src/teams/schema.ts` | `openTeamDb`, `migrateTeamDb` | The team database and its migrations |
| `src/teams/client.ts` | `joinTeam`, `share`, `fetchShared` | Sharing notes and pulling teammates' notes |
| `src/teams/chats.ts` | `buildChat`, `pushShared`, `previewShare` | Sharing a project's chats, masked again, with a preview first |
| `src/teams/chatcache.ts` | `openChatCache`, `readChats` | Teammates' chats on this machine |
| `src/teams/cli.ts` | `teamMain` | `thenwise team` commands |

`src/cli.ts` checks the runtime and takes the hook fast path, then `src/main.ts` runs the command. `openapi.json` is the team server's API contract, and a test checks it against the routes.

## The store

`graph.db` is one SQLite file of typed nodes and edges, plus an FTS5 passage index. Nodes are sessions, turns, summaries, commits, pull requests, files, notes, rules and plans. Edges say how they connect: a commit `changed` a file, a turn `edited` it, a pull request was `merged_as` a commit. Every record keeps its date and its source.

## The data folder

`~/.thenwise`, or `THENWISE_HOME`. Folders are 0700 and files 0600.

| Path | Holds |
| --- | --- |
| `archive/` | Masked copies of chats, and `archive/plans/` for plan versions |
| `graph.db` | The store, built from the archive, git and notes |
| `notes/` | Curated notes and the inbox |
| `config.json` | Settings |
| `logs/` | The log, with no chat text |
| `team-server/` | The team database, only if this machine hosts a team |

## The hooks

| Event | What it does |
| --- | --- |
| `SessionStart` | Starts a sync, and adds the handoff from the newest other chat of the project and a short brief, or a resume block after a compaction; says when the first sync starts |
| `UserPromptSubmit` | Adds up to three pointers when a prompt asks about the past, a teammate's chat that arrived after the start, and the first sync's progress |
| `PreToolUse` on edits | Keeps a plan version before it changes |
| `PostToolUse` on reads and shell commands | Adds a file's dead ends and decisions, led by a teammate who worked on it in the last day |
| `PreCompact` | Marks a compaction, so Copilot CLI gets its resume brief on the next prompt |
| `Stop`, `StopFailure` | In Antigravity, `PreInvocation` is the prompt hook and `Stop` (after each model loop) is session end. For a team member: starts a sync after a reply (at most every 10 minutes) and at once after a usage limit or an error |
| `SessionEnd` | Starts a sync |

Each tool has its own thin entry and all share one code base and one data folder. Claude Code reads `.claude-plugin/plugin.json` and `hooks/hooks.json`. Copilot CLI reads `.plugin/plugin.json` first, which points it at `hooks/copilot.json`: the same hooks in Copilot's own form (`exec` plus `args`, no shell), with no pre-edit hook, because Copilot denies the edit when such a hook fails. `src/ingest/copilot.ts` turns Copilot's hook payloads and chat files into Claude Code's shapes at the door, so everything after that is shared. `.mcp.json`, `commands/` and `skills/` serve Claude Code and Copilot CLI. Codex reads `.codex-plugin/plugin.json`, which names `hooks/codex.json` (shell commands that use `$PLUGIN_ROOT`, with a Windows form) and `.mcp.codex.json` (a relative command run from the plugin folder, with `PWD` passed through so the server knows the project). Antigravity reads `.antigravity-plugin/plugin.json` with `hooks.json` and `mcp_config.json` at the plugin root, its own names and shapes; its Stop hook fires after every model loop, so it syncs only when idle.

## The rules that hold it together

- **Update equals rebuild.** `src/ingest/parts.ts` builds both paths, and `test/incremental-random.test.ts` runs random changes to prove the results match.
- **Deterministic.** Inputs are sorted, the graph uses no wall-clock time, and no model sits between a question and the records.
- **`STATE_VERSION`** forces one store rebuild when what ingest produces changes.
- **`MASK_VERSION`** forces one re-mask of existing archives when masking gets stronger.
- **Hooks stay fast and silent.** A hook never fails the chat. Errors go to the log, and a slow step is cut off.

## Build and distribution

`npm run build` compiles `src/` to `dist/` with TypeScript alone, and the build is byte-for-byte reproducible. Two routes reach users: the npm package, which holds `dist/`, and the `release` branch, which plugin users install from. [RELEASING.md](RELEASING.md) explains how CI proves both come from the public source.
