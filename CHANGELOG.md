# Changelog

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
