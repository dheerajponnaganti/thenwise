# Changelog

## 0.1.19

Thenwise is on npm, with an open door for questions and contributions.

- npm: `npm install -g thenwise` installs the CLI. The package page shows the full README.
- README: live npm badges (version, downloads, size), badges for the tested platforms, questions and pull requests, and a "Dig in with us" section on the ways to help. The version badge no longer goes stale.
- New `CONTRIBUTING.md` (ways to help, setup in three commands, where things live, pull request rules), `SECURITY.md` (private reports and what counts), a pull request template, and Questions and Security links on the new issue page.

## 0.1.18

Shared project chats find every chat of the project.

- A chat belongs to the repo of its working folder, else the repo holding most of the folders it edited (it was the first edited folder). Chats from another checkout or a worktree of the shared project now count as that project, matched by its GitHub slug or folder name.
- `team shares` counts waiting chats with the same filter the push uses, so the number matches what the next sync sends.

## 0.1.17

Shared project chats: a teammate's chats join your memory when they share a project.

- Share a project's chats: `thenwise team share-chats <repo>` shows a preview first (counts, size, dates, three masked passages, what stays home), then sends the project's chats as masked passages: prompts and replies only, never raw transcripts, tool output, subagent reports or file contents. Home and project paths in the text become `~` and repo-relative, a redact list (`team.redact`) removes words before anything leaves, and a long chat keeps its newest turns. `team unshare-chats <project or session>` takes them back, `--pause` stops new chats, `team shares` shows what you share, and `forget` also removes a shared chat from the server.
- Teammates' chats in your memory: each sync fetches them into a private cache (`team-chats.db`), and they join search like your own chats, scoped to your checkout of the project and named as theirs (`chat of alice, 2026-10-20 (team)`). Dead ends travel with their sentence. The startup brief counts teammates' new chats in the project. Search, hooks and tools stay local; only the sync talks to the server.
- Team server: schema 4 with shared chats, passages, search, tombstones and retention; new routes under `/v1` (`/chats`, `/chat-tombs`, `/shared-projects`, `/chat-settings`, `/chats/search`) in `openapi.json` 1.1, with every v1 route unchanged. An admin or retention unshare sticks until the owner shares again on purpose. Member and up may share, every role may read, Hub reads are audited, a member may share up to 200 MB, and deletion removes rows, search entries and read counts.
- Opening a store runs no git: each repo's GitHub slug is stored at ingest.
- README: no telemetry, what masking catches, what Thenwise keeps and leaves out, speed, team security, common questions and platforms; a new plate, the sieve; the teams plate shows a shared project's chats; the promise reads "Chats stay home unless you share a project. Raw transcripts never travel."

## 0.1.16

A new README, drawn as a geological survey of your repository.

- README: seven survey plates replace the old art: the hero section, the same question asked twice, three questions, measurements, how the store is laid, the notebook and teams. The text adds Thenwise Hub, the Docker kit, team backup and restore, the inbox and auto-share, and the measurements add plain Claude Code without git.

## 0.1.15

Self-host kit: a team server with the Hub and TLS, and team backups.

- Self-host kit: `team backup <file>` (an online copy, safe while the server runs) and `team restore <file>` (refused while a server runs on the folder, and for a file from a newer Thenwise). `docker/` runs the team server and the Hub behind Caddy with automatic TLS; `docs/teams.md` covers running, inviting, joining, the Hub, backup and restore, removing a member, and what leaves which machine.

## 0.1.14

Teams in the tools: what teammates share is part of the memory.

- Teams in the tools: what teammates share is fetched at each sync and becomes part of the memory, so Claude finds it with `memory_search` and names who shared it. Unshared or retired notes leave on the next sync; notes waiting in a review queue never arrive. Your own shares are not fetched back.
- Opt in: `"team": { "auto_share": ["decision", "dead_end"], "auto_share_projects": ["<project>"] }` shares notes you accept in those projects; `"capture": { "auto": true }` distills new chats into inbox proposals once a day (it calls `claude -p`). Both are off by default.
- `/thenwise:inbox` reviews the proposals and accepts or rejects them by id.

## 0.1.13

Words that meet: answers in other words than the question.

- Words that meet: when a search finds no match, the rare words its first three results share are searched too, at synonym weight, and the answer says which. On the gold benchmark this finds 6 answers that were "not recorded" (R@10 67% to 72%) and moves no other question.
- A chat result reads as one unit: what was asked, when the match is further down the turn, and how the next turn answered.
- The output budget of a memory answer is 4,000 characters, or `THENWISE_OUTPUT_CHARS` / `tools.output_chars` in config.json; at 8,000 or more, five results are shown in full. The default stays until a judged run picks one.
- Not taken from the plan, by the benchmark: synonyms mined per chat (10 pairs instead of 1,094 and no gain; expansion stays off, as it lowers R@1 from 36% to 33%), and split camelCase words (the tokenizer already splits snake_case, and no gold question needs camelCase).

## 0.1.12

Teams API for the Hub: roles, invites, browser sessions and note curation.

- Teams: five roles (viewer, member, editor, admin, owner). A viewer only reads, an editor also edits, retires, supersedes and pins others' notes, an admin manages members, invites and settings. A refused call is a 403 and lands in the audit log. The first member is the owner.
- Teams: invite codes (`POST /v1/invites`, `POST /v1/join`) and browser sessions (`POST /v1/session`) with an httpOnly cookie and a CSRF header on writes. Bearer tokens still work for the plugin.
- Teams: notes carry a kind, status, tags, pin and source; every change keeps a revision you can read back; an optional review queue holds new shares until an admin approves. Admin routes list and change members and settings, show the audit log and 90 days of read counts, and `GET /v1/export.zip` gives the notes as Markdown in the vault format.
- Teams: `team serve --console <folder>` serves a built Hub with a content security policy; `--allow-origin` allows a Hub on another host. `--host` beyond this machine now needs `--tls-behind-proxy` or `--allow-plain-http`.
- Teams: the routes without `/v1` are gone; they answer a 404 that says to update Thenwise. `openapi.json` is frozen as v1, and the database migrates to schema 2 (a 0.1.9 server refuses it).

## 0.1.11

Dead ends that exist: found from what happened, not from what was said.

- Dead ends from what happened: an edit that a later edit in the same chat puts back, and tests that fail after an edit before work moves to another file. They are linked to the file, rank above phrase matches in `tried`, and lead the file hint. A prompt line `[dead-end] <what failed>` marks one by hand.
- `thenwise deadend "<what failed>"` and `thenwise decide "<what was decided>"` (also `/thenwise:deadend` and `/thenwise:decide`) save a note at once, tied to the current project.
- The file hint lists what happened first, then decisions and dead ends you kept, the Decision lines of recent commits, and the file's last change. Phrase matches only fill what is left.
- Git history keeps every branch again, since 90 days before your first chat. 0.1.8 kept only the main line and named commits, which dropped the detail of squash-merged branches.

## 0.1.10

Memory that shows up: pointers on questions about the past, and a brief when you open a project.

- Memory that shows up: a prompt that asks about the past (why did we, last time, a date, a PR, a path) gets up to three pointers to the records that answer it, about 300 tokens. A prompt without such a cue, a slash command, or a weak match gets nothing. `hooks.prompt_map: false` turns it off.
- A session started in a repo with a session in the last 7 days opens with a short brief: the last session's date and first prompt, the commits and merged PRs since, the open PRs. `hooks.startup_brief: false` turns it off.
- The memory server tells Claude when to call it, with one example per question shape, and when not to. The tool descriptions are shorter and say it once.
- `/thenwise:why`, `/thenwise:tried` and `/thenwise:asof` ask the memory directly.
- The log records whether a memory call followed a pointer within a minute.

## 0.1.9

Teams foundation: members with ids, a versioned API, and shares that never overwrite each other silently.

- Teams: members have ids. A removed member's name is never given to someone else; `team invite --again <name>` brings the same person back to their notes. New: `team members`, `team rotate <name>`, `team pull`.
- Teams: the server numbers every change, and each share says which version it replaces. Two machines of one person no longer overwrite each other silently: the newer copy wins, and an older one is reported. An unshare still wins over a share made before it.
- Teams: search uses full-text matching, folds accents, matches whole words and shows the words around the hit.
- Teams: the API is versioned under `/v1`, with one error shape, a health route and feeds of what changed since a revision; `openapi.json` describes it. The old routes answer for one more release, so a 0.1.8 client still shares.
- Teams: a server behind a path prefix can be joined. Large shares get 20 seconds instead of 3. A refused token stops the syncs instead of retrying each session, and `thenwise status` says to ask for a new invite. A rejoin keeps what the machine shared.
- Teams: the database has a schema version and migrates on start; a file from a newer Thenwise is refused. Answers carry security headers, and each token has a rate limit.

## 0.1.8

Lean and quiet: less code, syncs that do only what changed, and hooks that cost little.

- Smaller and quieter: the old storage stack (Postgres, the SQLite and file stores, their HTTP server and commands) is gone, with the `views` command; the plugin never used them. The `pg` dependency goes with them.
- A sync rewrites the vault only after an ingest that changed something, or once a day.
- A new project folder is an update, not a full rebuild, when the roots come from your history rather than config.json.
- Git history is the default branch's main line since 90 days before your first chat, plus every commit your chats name. A clone of a large project no longer adds its whole history. `"git_all": true` under `ingest` in config.json reads every branch, as before. Every store rebuilds once.
- Hooks that fire on most tool calls stop early when there is nothing to do: about 50 ms instead of 100 ms on a plain Bash command. The hook matchers name whole tools, so `NotebookRead` and similar tools start no hook.
- The search engine keeps the 256 most recently used words, and typo candidates no longer push them out.

## 0.1.7

Right records first: the rankings that put wrong or stale records on top are fixed.

- CLAUDE.md files are kept as one record per heading section, dated by the file's last commit, instead of one record per line dated today. Only the CLAUDE.md of each root and configured repo, and those one folder below a root, are read; deeper ones (often other people's checkouts) are listed by `thenwise status` and can be added with `docs` under `ingest` in config.json.
- `current` no longer boosts CLAUDE.md lines, and gives no recency credit to records dated only by a file's save time.
- Naming a file in a question ranks the commits and chats that touched it by how well they match, not newest first.
- NEWER warnings need evidence that the later record is about the same thing (it supersedes the record, touches the same file or PR, carries its title, or shares its rarest words), say which, and appear once per answer.
- `asof` lists the best match first and names the newest match separately, and follows a chat turn to the commit it made.

## 0.1.6

A ruler for retrieval, and six small fixes.

- A retrieval benchmark: `bench/gold/run.ts` ranks 88 questions with known answer records and reports R@1, R@3, R@10 and MRR per command, in under 5 seconds and with no model. `--compare` lists every question whose rank moved. The commands and the benchmark share one ranking function.
- A bare `#7` ("the #1 cause", "step #2") no longer pulls in PR 7; it still does next to "PR", "pull" or the repo's name.
- File hints are marked once per file even when Claude reads several files at once.
- A commit made with `-m "$(cat <<'EOF' ...)"` keeps its real subject line.
- `hooks.log` is gone; the status shows the last lines of the log instead.
- A store built with `--until` keeps its cutoff: a later forget or sync rebuilds it with the same cutoff instead of adding newer chats.
- `forget` also removes the hint state of the chat's subagents.
- Every store rebuilds once, so chats left out by older versions are read again.

## 0.1.5

A log, and a way to report issues.

- Log: every tool call, hook and sync step leaves one JSON line in `logs/thenwise.log` in the data folder, rotated at 1 MB with 3 old files kept. Secrets are masked, the home folder shows as `~`, and a query is kept only as its word count and a short hash. `THENWISE_LOG=debug` (or `log.level` in config.json) shows more, `off` turns it off. Archive, ingest, distill, teams and doctor runs log their counts too.
- A failed memory call tells Claude a short error code, such as `E4F2`, that matches its log line.
- `thenwise logs [--errors] [--since 1h] [--component mcp] [--json] [--lines N]` and `/thenwise:logs` show the log. `thenwise doctor` and `/thenwise:status` show the errors of the last 24 hours.
- Issue reports: `/thenwise:report` drafts what happened from the chat, and `thenwise report` adds versions, doctor, store counts, settings and the last 20 errors and warnings. Project names and paths are hidden, everything is masked twice, and the whole report is shown first. It is sent only on a yes: with `gh`, through the pre-filled GitHub form, or copied to the clipboard; it is always saved in `reports/`. GitHub issue forms for bugs and ideas.
- The first failed memory call of a session, and a failing doctor, point to the report.
- Tests run with their own empty data folder, so a test run can never write into a real store.

## 0.1.4

Fixes from an evaluation of 0.1.3 against plain Claude Code.

- Results: search, why and tried show the top 3 in full, each with the next turn of the same chat, then more matches as one line each, kept under the tool output limit. Excerpts show the part of a passage with the most distinct rare query words. Reading a passage of a short record prints the whole record. Short stub passages join the next one.
- Ranking: subagent turns weigh half and stay out of title matches; near-duplicates in one chat take one slot. A query word missing from a passage counts half when its turn or the turns next to it hold it.
- As of a date: memory_asof asks for the hour and zone the question gives. A note edited after the date stays out, even when its front matter carries an older date.
- NEWER warnings skip records from the same chat within 30 minutes and quote what the newer record says.
- The server tells Claude to use the memory first for why, tried, when and as-of questions.
- Dead ends: chat replies, Revert commits and PRs closed unmerged that record an abandoned approach are flagged at ingest, by phrase rules, with no model. The file hint lists them, also before an edit, and is silent for files without one.
- Off the record: `[no-memory]` in a prompt keeps that chat out (replaces the old evaluation tag as the default). The evaluation folder exclusions are gone from the defaults.

## 0.1.3

Fixes from a full audit of 0.1.2.

- Privacy: every stored record is masked (commits, PRs, notes, CLAUDE.md, the PR cache), not only chats and plans. Masking no longer removes the word after "token", "secret" or "password" in prose. Mask version 5 re-reads Claude Code's original chats where they still exist, so those words come back.
- Data safety: a folder backup only removes files it copied, and refuses a non-empty folder it did not make. A git backup commits only `_thenwise/`. Forget and off also cover a project's commits, PRs, CLAUDE.md, notes and plans. Every file Thenwise writes is private to you.
- Capture: slash-command turns, subagent chats, and headless and SDK chats are kept (eval chats stay out). Commits stay after a history rewrite, marked as no longer in git. PR reviews are read. CLAUDE.md files of cloned repos are no longer global rules.
- Answers: file history finds the right repo and handles absolute, Windows, spaced and bracketed paths. Plain Bash reads get file history. The compaction brief reads the live session and puts next steps first. asof and trace prefer main. Scope applies before result limits. memory_trace pages with `offset`.
- Speed: hooks and the seven tools read the store on demand instead of loading all of it. Open takes about 1 ms, and memory stays near 200 MB on a 5,000-chat store.
- Sync runs on clear, compact and session end, steps time out, and a lock older than an hour is stale.
- Setup: PRs default off, the Obsidian vault ignores the right folder, Node 22.16 is enforced, status warns about new projects out of scope. The "inside each project" vault option is removed.
- Teams preview: only a 2xx answer counts as sent; refused shares are reported.

## 0.1.2

- Plan history: every version of planning-with-files plans (`task_plan.md`, `findings.md`, `progress.md`, at the project root or in `.planning/<slug>/`) is kept, masked, before Claude changes it. The background sync also saves plans edited by hand. Each version is a dated `plan` record that search, asof and trace find. `ingest.plans: false` turns it off. Paused and excluded projects are skipped, and `forget <project folder>` removes the project's plans.
- README: opens with the three questions Thenwise is built for (why, what was tried, what held on a date) and the go/no-go result.

## 0.1.1

- Masking: a key wrapped at a line break, a key glued to `_` or `-`, and Twilio `SK` keys are now masked. Mask version 4: the archive masks old copies again on the next sync.
- Teams preview: waiting shares retry in the background sync at session start. A lock keeps two processes from losing a queued change.
- Teams preview: `thenwise team remove <name>` asks whether to keep or delete the member's shared notes (`--keep-notes`, `--delete-notes`). Without a terminal it needs one of the flags.
- The sync lock no longer fails when it is released mid-read, and a fresh lock is never taken as stale.

## 0.1.0

First release. Teams mode is a preview. Windows is experimental.

- Claude Code plugin: an MCP server with seven tools (`memory_search`, `memory_current`, `memory_why`, `memory_tried`, `memory_asof`, `memory_trace`, `memory_read`), a skill that says when to use each, and slash commands for status, resume, off and on.
- Hooks: a background sync at session start, a resume brief after compaction, a short file history when Claude reads a file. Hooks exit fast and never fail the chat. Errors go to a log file.
- Local archive of past chats with secrets masked, and a SQLite graph of chats, compaction summaries, commits and PRs. Updates are incremental and match a full rebuild.
- PRs through `gh` when it is signed in. Read only, cached for a day.
- `thenwise setup`: choose projects, vault place, notes folders, PRs and backup. `thenwise doctor` checks the install.
- Curated notes vault (`_thenwise/`): decisions, dead ends, timeline and file histories, with a format version. Your own notes are read and never rewritten.
- Projects can be excluded or paused. Chats with an exclude marker are never archived.
- Teams preview: a small self-hosted server where members share chosen notes. Raw chats never leave the machine.
- Formats: config version 1, store format 1, vault format 1. A newer format is refused with a message.
- Needs Node 22.16 or later.
- Apache 2.0.
