# Changelog

## Unreleased

- A database error now names the file that cannot be read, with advice that fits it: the store in your data folder (delete and rebuild), a store given with `--db` (rebuild it there with `thenwise ingest --db`), the team chat cache (delete it; the next sync fetches the chats again) or the team server's database (restore it from a backup, never delete). Before, every such error said to delete `graph.db` in your data folder, even when another file had failed, which could throw away a healthy store.
- A flag that takes a value, given without one (`thenwise status --db`, `thenwise distill --since`), is an input error that names the flag, with exit code 2. Before, the command ran with its default and said nothing, so a typo could work on data you did not mean.

## 0.2.0

- A Copilot chat stopped by a credit limit or an error reads "stopped by the tool: premium request limit reached", without a second "stopped".
- A handoff now opens with one line that names the earlier chat's tool and keeps its work apart from the agent's: when the agent continues that work, it says first what that chat had done and anything it tried that failed, then what it did itself, and it claims only its own edits and test runs.
- Memory answers are shorter. A result reads date, project and source on one line, with the passage in its id; one-line results of the same PR or commit series fold into one; a chat's next turn shows only when it has a reply. With the shorter NEWER line below, answers to a set of real questions are about 18% shorter, with the same top results.
- When no shown passage holds all of a question's rare words, the answer says so in one line (`no shown passage has all of: distribution, linux`), so a partial match is not read as the answer. A record read in full after that search says which of those words it lacks.
- A passage that holds only what the person typed is labelled `[prompt]`, and weighs half in `why`, `tried` and `current`, which look for answers. The first sync after updating rebuilds the store.
- A hit on a title or heading alone shows the start of the text under it.
- A second clone of the same GitHub repo counts as the same project, so its chats and commits answer without the all-projects fallback.
- The skill tells every tool to ask the memory before searching files or git about past work, and to read the files directly for what they show now. Codex, which shows the model no server instructions, gets the same rule for its shell on the `memory_search` tool.
- File history hints no longer repeat the line about citing memory ids, which the server instructions and the skill already say.
- File history hints stay silent when all they could say is when the file last changed, and the same commit on two branches gives one line.
- Codex gets a file's dead ends and decisions before it edits the file, as Claude Code does: the hint reads the files from the patch.
- `memory_resume` names a handoff the session start already gave the agent instead of printing it again, until a compaction takes it away.
- A commit whose message describes dead ends (a release note of a tool that records them) is no longer recorded as a dead end itself.
- A NEWER warning needs evidence that the later record replaces the earlier one: it supersedes it, carries its title, touches the same PR, or is a later commit to the same file. Records that only share words get none. The warning is one line: `NEWER: <id> (<date>), <reason>. Read it before saying what holds now.`
- Codex and Antigravity load no plugin commands, so there a `/thenwise:` command is shown as the line that runs it.
- A handoff starts the other chat's last reply at a whole word, and names files that chat wrote outside the repo, next to what git shows uncommitted.
- Codex: the note about untrusted hooks says what still works (memory tools, the live handoff) and shows once, on the first memory answer, `memory_resume` included.
- A background subagent's launch notice, and the id and usage lines at the end of a subagent's report, are no longer stored as part of the chat.
- You can see what Thenwise does. In Claude Code and Codex a session start says what it added for the agent, such as "Thenwise added: where a Copilot session stopped 20 min ago". Copilot and Antigravity show no plugin text, so there the agent says it in one line. `/thenwise:shown` lists exactly what went to the agent this session, block by block.
- A failed background sync or memory call is told once at the next session start, with where to look. In Codex, Thenwise says when its hooks are not trusted, and `thenwise doctor` checks it.
- The first run says, in every tool, how many past chats Thenwise reads from which tool, where the copy lives, that secrets are masked and nothing leaves the machine, and how to pause it.
- `/thenwise:status` opens with six lines: memory, this session, hooks, team, inbox and errors. The full detail follows.
- `thenwise notices all|important|off`, or `notices` in config.json, sets how much Thenwise tells you. `THENWISE_NOTICES` overrides it.
- Google Antigravity. Install with `agy plugin install https://github.com/dheerajponnaganti/thenwise/tree/main/plugin`. Chats from its CLI and app join the same memory, labelled by tool.
- OpenAI Codex. Install with `codex plugin marketplace add dheerajponnaganti/thenwise` and `codex plugin add thenwise@thenwise`, then trust the hooks in `/hooks`. Codex chats join the same memory, labelled by tool.
- `thenwise connect antigravity|codex|cursor|gemini|opencode` gives those tools the memory tools, so they can read this memory and what your team shared. `--dry-run` shows the change and `--remove` takes it back.
- GitHub Copilot CLI. Install with `copilot plugin marketplace add dheerajponnaganti/thenwise` and `copilot plugin install thenwise@thenwise`. Copilot chats join the same memory as Claude Code chats, with the same memory tools, hooks and privacy rules, and answers say which tool a chat came from. Copilot gets its own manifest and hooks file; the Claude Code files are unchanged. The first sync after updating rebuilds the store once. If you set your own `include_entrypoints`, add `copilot-cli` to read Copilot chats.
- Before this release, the plugin blocked every file edit in Copilot CLI, because Copilot denies an edit when a pre-edit hook fails and the released hooks could not run there. Copilot now gets no pre-edit hook at all, so a broken install can never block an edit.
- Teams with mixed tools: a shared chat carries the tool it came from, and a teammate's results say "Copilot chat of alice" or "Claude Code chat of bob". The team server adds one column at its next start; older Thenwise versions keep working and send no tool.
- `thenwise forget` and `thenwise uninstall` name Copilot's own chat files and the copies Copilot keeps on GitHub, which Thenwise cannot reach.
- The `/thenwise:` commands work in Copilot CLI with any model. Copilot leaves `${CLAUDE_PLUGIN_ROOT}` empty, so each command now falls back to Copilot's install folder by itself; before, it depended on the model rewriting the path.
- Pick up where another session stopped, in any of the tools. When a session starts, Thenwise reads the newest chat another session left in the project, straight from Claude Code's, Copilot's, Codex's or Antigravity's own file, and tells the new agent where it stopped: a usage limit, a step that never finished, or its last reply; the task; the last prompt and reply; the files it edited; the last test and whether it passed; commits; dead ends; and what is uncommitted now. It needs no sync, so it works the moment you switch. `/thenwise:resume` and a new `memory_resume` tool start with the same block. Chats marked `[no-memory]`, paused projects and forgotten chats never hand over.
- A usage limit or an API error that stopped a chat is no longer stored as a reply. The turn ends with a stop line instead, so search, resume and teammates see that the work paused there. The first sync after updating rebuilds the store once.
- You can see the first sync. Claude Code and Codex say when it starts, show how far it got after a prompt at most once a minute, and say once when it is done, with the number of chats remembered. A rebuild after an update shows the same. `/thenwise:status` shows the progress any time. While the first sync runs, memory answers say the memory is still filling up.
- Teams: a teammate's half-finished chat shows in your session brief and in `/thenwise:resume`, with their tool and where they stopped. A team member's chat now syncs after a reply (at most every 10 minutes) and right after a usage limit, so it reaches the team while it is fresh. A chat that arrives after your session started is given at your next prompt.
- After a compaction, the resume block no longer comes out empty when the last turn was very long, and it now also gives back what the session did: the files it edited, the last test and its result, open questions, and what is uncommitted.
- Leave a question for whoever picks the work up next. A line `[question] why did you skip the migration?` in any tool's chat, shows in the next agent's handoff and session brief, and in `/thenwise:resume`, with an id such as `q-3f2a`. It stays open for a week until a later chat answers it with `[answer q-3f2a] ...` or an `[answer]` line that names it. Teammates' questions show the same way.
- Teams: when you open a file a teammate worked on in the last day, its history hint now starts with who, in which tool, how long ago, and whether their chat was stopped by the tool, so the work there may be half done.
- Every tool now installs the plugin from one `plugin/` folder in the repo, the way claude-mem and Ponytail ship theirs. Claude Code clones once instead of twice, so the extra clone can no longer fail with a permission error on a machine with no GitHub SSH key.

## 0.1.28

Windows no longer flashes console windows, and resume stays on the project you are in. Memory answers point agents to the memory tools.

- Windows: Thenwise no longer opens blank Node.js console windows. Every process it starts (the background sync, memory lookups, git) now runs hidden; before, windows flashed open with each hook and the sync's window stayed until you closed it.
- Resume is about this project. Another project's to-do list no longer fills it, it shows at most three open items with where to read the rest, and in a repo with no recorded chat it says so instead of showing a chat from your home folder.
- Memory answers point to the memory tools (`memory_read`, `memory_current`) instead of CLI commands, which an agent cannot run as tools.

## 0.1.27

Memory pointers now reach more past questions and long prompts, a too old Node says what to do, and team sync is steadier. In a new eval, answers held level with 0.1.26 on 6% fewer tokens.

- A team sync no longer loses its fetch when the server resets a reused connection. A request that is safe to repeat is sent once more; before, the sync brought in nothing that time.
- A too old Node now shows a notice at session start with what to do. Before, the plugin stayed off with no clear message. If Node is missing or `/thenwise:status` cannot run it, Claude now says what to install.
- Long prompts, such as a pasted log with a question at the end, get memory pointers again. Before, the search used the whole prompt, ran past the hook's time limit and gave nothing. It now searches only the sentences that ask about the past.
- Memory pointers now also appear for past questions like "why was the cache split" and "what did we decide". Before, only a few phrasings such as "why did we" got them.
- Asked why something is the way it is, Claude now checks memory before grep and git log. Past chats hold reasons that code and commits do not.
- The team server refuses a shared file path that starts with a scheme such as `file:` or with a home folder, and the client never sends one. Before, such a path from a buggy or newer client was stored and shown to every teammate.
- Installing and updating the plugin works on a machine with no SSH key on GitHub. Before, it could fail with a permission error.

## 0.1.26

A full rebuild now uses far less memory, and answers hold up in new evals.

**Why this release:** one very long chat could push a full rebuild past 2.5 GB of memory, enough to slow or stop a sync on a smaller machine. Sync should never be the thing you notice.

- Long chats take far less memory: a full rebuild on a real history with a 260 MB chat fell from about 2.6 GB to about 500 MB, and the store it builds is the same. The first sync after updating rewrites older long chats in the archive once, which peaks around 1.8 GB. Their text does not change.

**New evals, graded blind on hidden answers:**

| | Plain Claude Code | Thenwise | Difference |
| --- | --- | --- | --- |
| Your own history: correct | 37% | **93%** | 2.5 times more |
| Your own history: raw tokens | 7.1 million | **3.6 million** | 50% fewer |
| Your own history: seconds per answer | 26 | **14** | 1.9 times faster |
| A teammate's shared chats: correct | 17% | **88%** | 5.3 times more |
| A teammate's shared chats: raw tokens | 5.0 million | **3.1 million** | 39% fewer |
| A teammate's shared chats: seconds per answer | 24 | **16** | 1.5 times faster |

Every source was frozen before the questions were written, and a sandbox blocked everything else on the machine. On your own history, this build scored 93% against 87% for 0.1.24, with the same token use. [How we measured](https://github.com/dheerajponnaganti/thenwise/blob/main/docs/eval.md).

**Why these numbers changed:** earlier rounds scored 83% against 47% on your own history, and 88% against 25% on shared chats. Plain fell because it can no longer read live repositories, live pull requests or anything written after the questions: all of that once helped it. Thenwise rose on your own history because its test store now holds every chat and note from before the cutoff, where earlier rounds missed some. Token figures also moved from a weighted count per answer to raw totals, so they don't compare directly with earlier numbers.

## 0.1.25

One security fix, Windows fixes with Windows tests now required in CI, fixes for search, setup and sync, and a notice when a new version is out. The first sync after updating rebuilds the store once. This is the first release published from CI, with provenance.

- Thenwise tells you when a new version is out, once per version at the start of a session, and says when it has been updated. Once a day the background sync asks npm for the newest version and sends nothing about you or your work. Turn it off with `thenwise update-check off`. Search, tools and foreground hooks stay offline.
- One empty chat file no longer stops all memory updates. Before, every sync failed while that file existed.
- The default vault folder is made on the first write. Before, a fresh setup recorded `~/Thenwise` but never made it, so no notes were written and every sync logged an error.
- The sync log says why a step failed when the step reports it on standard output.
- Search finds a word that appears only in a title, such as the subject of a commit that also has a message body. Before, it said the word was not recorded. The first sync after updating rebuilds the store once.
- Windows: project folders, notes and file paths are compared with forward slashes everywhere, so a chat from a deleted repo keeps its project and a note's links resolve.
- Windows: `thenwise uninstall` stops a running background sync.
- Windows: `thenwise team share-chats` no longer hangs on a chat that started outside a repository.
- `thenwise team join` works on a fresh install, before anything has made the data folder.
- Windows: `thenwise distill` and automatic capture start Claude Code when npm installed it as `claude.cmd`.
- Security: `Decision:` and `Dead-end:` lines in commits and PRs now wait in the inbox. Anyone who lands a commit could write one, and it became a trusted note. Accept them with `thenwise accept --all-of decision`.
- `thenwise decide` and `thenwise deadend` name a similar note you already have.
- `thenwise doctor` says when `gh` is not installed, in place of asking you to sign in.
- `thenwise doctor` checks for `git`, which reads your commits on any host. Having no `gh` only fails when GitHub PR reading is on.

## 0.1.24

More secrets masked in shell commands, and shell commands now link files and commits on every system.

- More secrets are masked: `--password value`, `-Token value`, `setx`, `SetEnvironmentVariable`, `ConvertTo-SecureString` and `PSCredential`. Older chats are masked again at the next sync.
- Shell commands link files on Linux and Windows as they do on macOS, including relative paths. Commits are linked when written as `git -c x=y commit`, `git commit -F file` or `--amend`. The first sync after updating rebuilds the store once.

## 0.1.23

Fixes from an npm package review and a Hub test, a Hub on another host, and a README that shows Thenwise at work.

- Team server: a Hub on another host works with `--allow-origin`. Its session cookies can travel with a cross-site request, and the new `GET /v1/session/csrf` hands the Hub the value it cannot read from the cookie (API 1.1 addition; v1 is unchanged).
- Windows: a full rebuild no longer fails while Claude Code holds the store open. The new store waits beside it as `graph.db.next`, and the next process that opens the store swaps it in.
- Masking: long text with many hyphens is masked in linear time. Before, a 100 KB note could hold the team server for about 9 seconds, and a long hyphenated line slowed the archive and hooks.
- `thenwise --help` and `thenwise --version` print to stdout and exit 0.
- `uninstall` stops only the background sync itself, never another process that happens to reuse its pid.
- Team server: an export past 65,535 files answers 413 with a clear message instead of failing.
- Teams: a chat marked `[no-memory]` after it was shared leaves the team server at the next sync, and teammates drop it.
- Teams: a Markdown file shared as a note keeps its kind (decision, dead end, rule or finding) from `type:` or `kind:` in its front matter.
- Teams: a teammate's note shows its project in search results instead of "global".
- Team server: `/v1/health` reports the Thenwise version.
- Messages: `archive` names chats left out for `[no-memory]` as such, and `team share-chats` mentions later syncs only when chats are left.
- README: what Thenwise is, the install lines and the results open the page. Three recordings of real Claude Code sessions show the same question with and without Thenwise, three questions in one session, and a dead end caught before an edit.
- How we measured: `docs/eval.md` explains the questions, the two arms, the blind grading and the results, and how to run the harness.
- npm: a clearer description and more keywords.

## 0.1.22

Five bug fixes from a code review, and a corrected measurement.

- Off the record: `[no-memory]` added to a chat after it was archived now drops the archived copy at the next sync, so the chat leaves the memory. An excluded project's old copies still wait for `thenwise archive --prune-excluded`.
- Sync: an update waits for a running search instead of failing into a full rebuild.
- Sync: an empty or half-written `sync.lock` no longer blocks syncs for an hour.
- Git history: an update bounds commits by your own first chat, as a rebuild does, so a teammate's older shared chats no longer pull in extra history.
- File hints: `cat -n <file>` and `bat -n <file>` get the file's dead ends and decisions, as `cat <file>` does.
- README: plain Claude Code's individual score is corrected from 63% to 47%. In the round behind the old number, plain found leftover copies of our records on the test machine: saved tool output holding vault notes and old chats, the prompt history file, and Claude Code's own memory notes. 5 of its 19 right answers came from those copies. The re-run blocks the vault and its copies, and plain scored 47% in both of two runs. The plate now reads 1.8 times more questions answered right (83% against 47%) and 2.2 times faster answers (23 seconds against 51).

## 0.1.21

Hardening: a full reliability review, 17 findings, all fixed but one that waits for a larger change.

- Teams: only the owner can reset the owner's token, and an admin only roles below admin. `team restore` checks that the file is a team backup with an owner, and keeps the old database as `team.db.before-restore-<time>`. Removing a member with their notes now makes every teammate's machine drop those notes at its next sync. The server masks what it stores, edits included. Repeated failed sign-ins from one address get 429 and one audit row a minute. `docs/teams.md` has runbooks for a lost owner token, a bad restore and checking a removal.
- Archive: one run at a time (a second one says "archive already running"). Chats are read in chunks, so a chat of any size archives and memory stays low (a 228 MB chat: 2.2 GB before, about 210 MB now). A line over 128 MB is left out and counted instead of crashing the run. A failed file says why, with its size, in the output and in `logs --errors`. A damaged file prints one summary line.
- Search: two chats that share a session id in different folders are both found (the second as `<id>@<folder>`); `forget` asks which. Emoji are searchable (the store rebuilds once, and `status` says when one is waiting). A row dated in the future is moved back to its file's time. Replies stored as plain text are read.
- Masking: Slack webhooks, Google OAuth tokens, Docker registry logins, `<vendor>_key=` values that look like tokens, and database URLs with a password but no user. Environment references such as `process.env.API_KEY` stay readable. Archives re-mask once at the next sync.
- A full rebuild checks free disk first; `doctor` shows free disk against the store size. Tool errors reach Claude marked as errors.
- Tests never start a real background sync.

## 0.1.20

Thenwise is open source.

- The repository is public under Apache 2.0, with Discussions, issue forms, a contributing guide, a security policy and a code of conduct.
- README: a live CI badge for macOS, Linux and Windows.
- README: the measurements plate has two rows. Individual: 83% right against 63% for plain Claude Code, 40% fewer tokens, 2.4 times faster. Teams, from a teammate's shared chats: 88% against 25%, 24% fewer tokens, 1.5 times faster.
- Benchmarks: the eval record sets live outside the repo, so the bench names no private projects.

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
