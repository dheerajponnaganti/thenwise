<p align="center"><img src="assets/readme/hero.png" width="100%" alt="Thenwise. Your code has a past. Now your agents remember it. A section through a repository: dated layers of chats, commits, a dead end and a decision. One drill rig bores down to 6 October, where a specimen tag reads: cache split into eight shards; one prices.json had a single writer that locked up at the Friday peak; a mutex pool made it worse; commit e0a23e3; decided in Claude Code. Works with Claude Code, Copilot CLI, Codex and Antigravity."></p>

<p align="center">
  <a href="https://thenwise.dev"><img alt="Website thenwise.dev" src="https://img.shields.io/badge/website-thenwise.dev-B3361F"></a>
  <a href="https://www.npmjs.com/package/thenwise"><img alt="npm version" src="https://img.shields.io/npm/v/thenwise?label=npm&color=241C15"></a>
  <a href="https://www.npmjs.com/package/thenwise"><img alt="npm downloads" src="https://img.shields.io/npm/dm/thenwise?label=downloads&color=B3361F"></a>
  <a href="https://www.npmjs.com/package/thenwise"><img alt="Unpacked size" src="https://img.shields.io/npm/unpacked-size/thenwise?label=size&color=6B655B"></a>
  <img alt="Node 22.16+" src="https://img.shields.io/badge/node-22.16%2B-56687A">
  <a href="LICENSE"><img alt="Licence Apache 2.0" src="https://img.shields.io/badge/licence-Apache%202.0-6B655B"></a>
  <br>
  <img alt="Plugin for Claude Code, Copilot CLI, Codex and Antigravity" src="https://img.shields.io/badge/plugin-Claude%20Code%20%C2%B7%20Copilot%20CLI%20%C2%B7%20Codex%20%C2%B7%20Antigravity-8a7f6e">
  <img alt="Runs locally" src="https://img.shields.io/badge/runs-100%25%20local-B3361F">
  <a href="https://github.com/dheerajponnaganti/thenwise/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/dheerajponnaganti/thenwise/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/dheerajponnaganti/thenwise/discussions"><img alt="Questions welcome" src="https://img.shields.io/badge/questions-discussions-8a7f6e"></a>
  <a href="CONTRIBUTING.md"><img alt="Pull requests welcome" src="https://img.shields.io/badge/PRs-welcome-241C15"></a>
</p>

<h3 align="center">Every decision, every dead end, every yesterday of your work with coding agents.<br>Kept on your machine. Handed back the moment a question needs it.</h3>

<br>

**Thenwise gives Claude Code, Copilot CLI, Codex and Antigravity one local memory of your past chats, commits, pull requests and notes.**

Your project lays down history every day. A chat settles a question. A commit lands. An idea fails on a Tuesday and nobody writes it down. Weeks later the reason is buried, and your agent starts from zero. Thenwise keeps every layer, dated and in order, and drills straight to the one that answers.

## Install

Install it in each tool you use. They all share one memory. You need Node 22.16 or later, on macOS, Linux or Windows.

<table>
<tr><th>Claude Code<br><sub>type the commands in a Claude Code chat</sub></th><th>Copilot CLI<br><sub>run in your terminal</sub></th></tr>
<tr><td>

```
# 1. Add the Thenwise marketplace (once)
/plugin marketplace add dheerajponnaganti/thenwise

# 2. Install the plugin from it
/plugin install thenwise@thenwise

# 3. Quit and start a new session
```

</td><td>

```
# 1. Add the Thenwise marketplace (once)
copilot plugin marketplace add dheerajponnaganti/thenwise

# 2. Install the plugin from it
copilot plugin install thenwise@thenwise

# 3. Start a new copilot session
```

</td></tr>
<tr><th>Codex<br><sub>run in your terminal</sub></th><th>Antigravity<br><sub>run in your terminal</sub></th></tr>
<tr><td>

```
# 1. Add the Thenwise marketplace (once)
codex plugin marketplace add dheerajponnaganti/thenwise

# 2. Install the plugin from it
codex plugin add thenwise@thenwise

# 3. Start codex, open /hooks and trust
#    Thenwise's hooks, then start a new session
```

</td><td>

```
# 1. Install the plugin straight from GitHub
agy plugin install https://github.com/dheerajponnaganti/thenwise/tree/main/plugin

# 2. Start a new agy session
```

</td></tr>
</table>

On the first new session, Thenwise reads your past chats in the background and shows one line when it starts. Antigravity's CLI and its app both count. There is nothing else to set up.

Cursor, Gemini CLI and OpenCode read the same memory with `npm install -g thenwise` and `thenwise connect cursor` (or `gemini`, `opencode`). Auto-update, sandboxes and the one-line install: [docs/install.md](docs/install.md).

## What happens after you install

<p align="center"><img src="assets/readme/after-install.png" width="100%" alt="Plate II, what happens after you install, on one line of time. First session: it reads your past, chats from every tool, commits, plans and notes, masked, on your disk; 2,771 chats in 164 seconds. Every new session: it knows where you stopped, the last session, what landed since, and where another tool stopped; a brief of 200 tokens at most. While you work: it warns before an edit, a file's dead ends and decisions arrive first; 600 tokens, once per file. Whenever you ask: it answers with sources, why, what was tried, what holds now, what was true on any date; eight memory tools."></p>

No model, no API key, no account, nothing to configure. Want to choose? `thenwise setup` asks which projects to keep, where your notes go, whether to fetch pull requests, and whether to back up. `thenwise doctor` checks everything and prints one fix line per problem.

## Measured, with the answers hidden

Make every token count. We tested it the hard way.

<p align="center"><img src="assets/readme/measurements.png" width="100%" alt="Field measurements with hidden answers, graded blind. Individual, on your own history: 2.5 times more questions answered right (93% with Thenwise, 37% for plain Claude Code reading git), 60% fewer raw tokens, 1.9 times faster answers (14 seconds against 26). Teams, from a teammate's shared chats: 5.3 times more questions answered right (88% against 17%), 39% fewer raw tokens, 1.5 times faster (16 seconds against 24). And 2,771 chats remembered 164 seconds after install."></p>

**Individual:** your agent answers about your own history. **Teams:** a teammate asks about a project they never worked on and answers from its shared chats. In both tests, plain Claude Code could read the repository and its git history, and a judge graded every answer without knowing which side wrote it. Hooks answer in about 50 ms and a search takes milliseconds, so your agent never waits on its memory. [How we measured](docs/eval.md), with a run for every tool.

## What it does for you

### The same question, twice

<p align="center"><img src="assets/readme/g1-same-question.gif" width="100%" alt="Two Claude Code terminals get the same question in one repository: why did we split the cache into shards? Without Thenwise, Claude runs git show twice and answers that the history does not say why; it guesses at contention and says Maya Rao would know. With Thenwise, Claude calls memory_why and memory_read and answers that the cache was split to fix checkout timeouts at the Friday peak: one prices.json file with a single writer held the lock for up to 900 ms, a mutex pool made it worse and was reverted, the cache is now eight shards keyed by store id, p99 went back to 120 ms, and the split is commit e0a23e3 from 2026-10-06. Real Claude Code output."></p>

Same repository, same question, real output. That second answer came from a chat you had three weeks ago and forgot about. Thenwise kept it.

### Born for three questions

<p align="center"><img src="assets/readme/three-questions.png" width="100%" alt="Three specimens. A fossil: why did we choose this? Decisions come back with their reasons, their day and their commit. A filled-in tunnel: what did we already try? Dead ends stay marked and dated. A pin in a layer: what was true on that day? Your agent answers from what was known then."></p>

In one session, each with its day and its source:

<p align="center"><img src="assets/readme/g3-three-questions.gif" width="100%" alt="One Claude Code session with Thenwise answers three questions. Why did we split the cache into shards: memory_why, the Friday peak timeouts, the reverted mutex pool. What did we already try for the price fetch retries: memory_tried, two approaches on 2026-10-14, plain retries dropped because every client retried at once. What did the price cache look like on 1 October: memory_asof, the version from commit 2953f33, one JsonFileCache on prices.json. Real Claude Code output."></p>

### The past comes to you

You will not always think to ask. Thenwise brings the right history in at the right moment, and stays quiet the rest of the time.

- **Open a file** and your agent learns its dead ends and decisions before it changes a line.
- **Ask about the past** and it gets up to three pointers to the records that answer it. A question about the work in front of you gets nothing.
- **Open a project you touched this week** and it starts where you left off.
- **After a compaction**, a short resume brief carries it straight back into the work.
- **Dead ends are found on their own.** A reverted commit, an edit that was undone, a test that failed before the work moved on, a line like "that didn't work": each is marked, with no model and nothing for you to write down.
- **Across sessions, projects and tools**, the memory follows you. A second clone of the same repo counts as the same project.

Ask it to change a file with a dead end in its past, and it checks before it edits:

<p align="center"><img src="assets/readme/g5-dead-end.gif" width="100%" alt="Asked to add retries to the price fetch in src/fetch.ts, Claude reads the file, calls memory_trace on it, and finds that four plain retries were tried on 2026-10-14 and reverted because every client retried at the same moment. It makes no change and says it did not add plain retries again because that approach is a known dead end. Real Claude Code output."></p>

### What it is great at

- **Coming back after three weeks.** Open the project and your agent knows where you stopped, what landed since and what is still open.
- **"Why is this like this?"** An odd config value, a pinned version, a strange workaround: the reason comes back with its day and its commit.
- **Not digging the same tunnel twice.** Before it edits a file, your agent sees what was tried there and failed.
- **"What was the setup on release day?"** Ask about any date and get what was true then.
- **Rules that changed.** Your CLAUDE.md files and plans are kept, every version dated, so an old rule and its replacement are told apart.
- **Joining someone else's project.** With a teammate's shared chats, the reasons behind the code arrive on your first day.
- **Running out mid-task.** Switch tools and carry on. The next one starts where the last one stopped.

### A notebook you can open

<p align="center"><img src="assets/readme/notebook.png" width="100%" alt="A Codex window runs thenwise vault write and lists the notes it wrote: a _thenwise folder with a shop folder holding Index, Decisions, Dead ends, Timeline and a Files folder. Beside it, the open page Decisions.md: dated decisions, each with its source. Beside that: a memory you can open and read, in any editor or on GitHub, in its own Git repo, or in Obsidian with the graph."></p>

`thenwise vault write` turns what it remembers into linked notes: **decisions**, **dead ends**, a **timeline**, and the **history of each file**. It is plain Markdown. Read it in any editor or on GitHub, keep it in its own Git repo, or point it at your Obsidian vault for backlinks and the graph. Notes you accept from `/thenwise:inbox` join it, and `/thenwise:backup` copies it to git or other folders once a day. Thenwise reads your own notes folders too, and never rewrites them.

## What it does for your team

<p align="center"><img src="assets/readme/teams.png" width="100%" alt="Three teammates, maya, theo and ines, each keep a full memory on their own machine. Maya shares one decision and the chats of one project: both pass a mask and reach the team server the team runs itself, then arrive on theo's and ines's machines at their next sync, named as hers. Raw chats stay on every machine. Thenwise Hub shows the shared catalog in a browser."></p>

Memory tools remember for one person. Thenwise remembers for the team. Asked about a project they never worked on, a teammate's agent answered 88% right from shared chats, against 17% from git alone.

- **Your server, your rules.** One small server you run yourself. No vendor, no cloud account, no per-seat bill.
- **Share on purpose.** Nothing leaves until someone picks a note or a project. Every share shows a preview, and keys are masked on the way out and again on arrival.
- **Chats stay home unless you share a project.** Raw transcripts never travel. A shared project's chats cross as masked passages, and one command takes them back.
- **One search for everyone's past.** What teammates share joins your memory at each sync. Your agent finds it like its own and names whose it is and from which tool: "Copilot chat of alice".
- **See a teammate's work in progress.** A teammate's half-finished chat shows in your session brief, with their tool and where they stopped. Open a file they touched today, and your agent hears who, how long ago, and whether their chat was cut off.
- **Locked down.** Tokens are stored only as hashes. Five roles run from owner to viewer, every admin action lands in an audit log, and an optional review queue holds new shares until an admin approves. If the server is down, shares wait and go out on their own.
- **A reading room in the browser.** [Thenwise Hub](https://github.com/dheerajponnaganti/thenwise-hub) shows the team's notes as a card catalog, with search, history and a review queue.

Maya opens the shop project while alice's Copilot chat is stopped halfway through the same file:

<p align="center"><img src="assets/readme/c-teammate.png" width="100%" alt="Maya's Claude Code session in the shop project. Its brief says: teammates' chats in this project since your last session: 1, alice; teammate's newest chat: alice in Copilot, 6 minutes ago, stopped by the tool because her premium request limit was reached, last asked to put the price fetch behind a circuit breaker. Reading src/fetch.ts adds: alice in Copilot worked on this file 8 minutes ago and that chat was stopped by the tool, so the work may be half done; and the dead end from 14 October, the reverted four plain retries. Real output."></p>

```
thenwise team serve --dir ~/team --console <hub build>   # on the server
thenwise team invite alice --dir ~/team                   # prints alice's token once
thenwise team join <url> <token>                          # on alice's machine
thenwise share <note>                                     # preview, mask, confirm, send
thenwise team share-chats <repo path>                     # share a project's chats
```

| | **Solo** | **Team** |
| --- | --- | --- |
| **What you run** | Nothing. Install the plugin and keep working. | One small server, hosted by one person on the team. |
| **What leaves your machine** | Nothing. | Only the notes and project chats you choose to share, masked. |
| **What search covers** | Your whole history. | Your whole history, plus everything your team shared. |
| **Cost** | Free. | Free, on hardware you already have. |

The [`docker/`](docker/) kit runs the server, the Hub and Caddy with automatic certificates. Roles, invites, backups and what leaves which machine: [docs/teams.md](docs/teams.md).

## One memory, every tool

Decide it in Claude Code. Ask about it in Copilot. Run out in one tool and carry on in another. The handoff reads the other tool's own chat file the moment you switch, with no sync to wait for.

<p align="center"><img src="assets/readme/g8-handoff.gif" width="100%" alt="A Codex window in the shop project, told only: continue the work in this project. A Claude Code chat had added retries with jitter to the price fetch and stopped before running the tests. Codex calls memory_resume and memory_trace on src/fetch.ts, checks the diff and runs npm test, then answers: the earlier Claude chat added three retries with exponential backoff and jitter in src/fetch.ts, then stopped before running tests; earlier project history reverted four synchronized plain retries after they worsened a pricing service outage; in this session it ran npm test, 1 test passed, 0 failed, and made no code changes. Real Codex output."></p>

The next agent learns why the last one stopped (a usage limit, a step that never finished, or its last reply), the task, the files it edited, the last test and whether it passed, the commits, the dead ends, and what is uncommitted now:

<p align="center"><img src="assets/readme/a-handoff.png" width="100%" alt="The handoff a new Codex session receives in the shop project from a Claude Code chat. State: stopped by the tool 20 minutes ago, 5-hour limit reached. Task: add retries with jitter to the price fetch, with a test, then run the tests, with a question whether the retry cap should be 3 or 5. Last reply: the new test fails, the loop calls fetch four times and the test expects three. Edited: test/fetch.test.ts and src/fetch.ts. Last test: npm test, failed. Open question q-fa41. Uncommitted now: src/fetch.ts and test/fetch.test.ts. Real output."></p>

Leave a question for whoever comes next: a line `[question] <the question>` in any chat shows in the next agent's handoff and in your teammates' briefs, and stays open for a week until a later chat answers it.

## Your memory stays yours

A memory this deep has to be private. This one lives on your disk and nowhere else.

| | |
| --- | --- |
| **Local** | One folder on your disk, readable by you alone. |
| **Masked** | Keys and tokens become `[secret masked]` before a single byte is written. |
| **No middleman** | No model stands between your question and your memory. Search, hooks and tools make zero network calls. |
| **Off the record** | Start or end a prompt with `[no-memory]`, or give it a line of its own, and that whole chat is never kept. |
| **Forgettable** | `thenwise forget` erases a chat or a whole project, and it stays gone. |
| **Read only** | Each tool's own chat files and your own notes are read, never changed. |
| **No telemetry** | No account, no sign-up, no usage reports. Nothing phones home. |

<p align="center"><img src="assets/readme/sieve.png" width="100%" alt="The sieve. One chat window holds a prompt, the agent's reply, four thousand lines of tool output, a line with a Stripe key and an aside marked no-memory. All of it pours through the sieve. The prompt and reply are kept, dated 06 Oct; the key line is kept with the key masked; tool noise is not indexed, no-memory chats are never kept and paused projects are not read. No telemetry, no account, nothing phones home."></p>

Masking knows the shape of keys from AWS, GitHub, GitLab, Anthropic, OpenAI, Stripe, Slack, npm, Hugging Face and more, with private key blocks, JWTs and passwords inside URLs. [Every file it keeps, and everything masking catches](docs/privacy.md).

## Commands and hooks

### Eight memory tools

Your agent reaches for these on its own whenever a question needs history.

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

Every result names its day, its project and the tool it came from. When a newer record replaces an older one, it is flagged right under it. When no record holds all of a question's rare words, the answer says so, so a near miss is never passed off as the answer.

### The commands you will use

| Command | What it does |
| --- | --- |
| `/thenwise:status` | What is stored and when it last synced. |
| `/thenwise:resume [topic]` | Brief your agent on past work. |
| `/thenwise:why`, `/thenwise:tried`, `/thenwise:asof` | Ask the memory directly. |
| `/thenwise:decide`, `/thenwise:deadend` | Keep a decision or a dead end on purpose. |
| `/thenwise:shown` | Exactly what Thenwise added to this session, block by block. |
| `/thenwise:inbox` | Review the decisions and dead ends Thenwise proposed from your chats, commits and PRs. |
| `/thenwise:off`, `/thenwise:on` | Pause or resume memory for this project, or everywhere. |
| `thenwise why`, `tried`, `asof`, `trace <words>` | Ask the memory from your terminal, with `--all` for every project. |
| `thenwise setup`, `thenwise doctor` | Choose what to keep; check everything. |
| `thenwise vault write` | Write the notebook of decisions, dead ends and file histories. |
| `thenwise connect <tool>` | Give Cursor, Gemini CLI or OpenCode the memory tools. |
| `thenwise forget <chat or project>` | Erase it from memory for good. |

Slash commands run in Claude Code and Copilot CLI. In Codex and Antigravity, run the same thing in your terminal as `thenwise <command>`. [Every command](docs/commands.md).

### What the hooks do on their own

| Moment | What your agent gets | At most |
| --- | --- | --- |
| **Session start** | A brief of where you left off, in a project with a session in the last 7 days, and the handoff from a chat that stopped in another tool. The sync starts in the background. | 200 tokens for the brief |
| **A prompt about the past** | Pointers to the records that answer it. Most prompts get nothing. | 3 pointers, about 300 tokens |
| **Opening or editing a file** | Its dead ends and decisions, once per file per session. | 600 tokens |
| **After a compaction** | A resume brief: the task, the files edited, the last test and its result, open questions, and what is uncommitted. | 1,500 tokens |
| **When a chat ends** | Nothing. Thenwise copies and masks the chat, so the next session in any tool can pick it up. | |

A hook never fails your chat; errors go to the log. Turn the brief or the pointers off with `"hooks": { "prompt_map": false, "startup_brief": false }` in config.json.

### Never a black box

The first run says how many chats it reads from which tool, where the copy lives, and that nothing leaves your machine. Every session start says in one line what Thenwise added. `/thenwise:status` opens with six lines, and `/thenwise:shown` lists every block your agent received, with its size. `thenwise notices all|important|off` sets how much it tells you.

<p align="center"><img src="assets/readme/b-visible.png" width="100%" alt="A Claude Code session in the shop project. The start says: Thenwise added where a Claude Code session stopped 20 minutes ago, and this project's recent history; /thenwise:shown lists it. /thenwise:status shows six lines: memory, 3 chats remembered; session, handoff, brief, pointers and file hint added, about 621 tokens; hooks; team; inbox; errors, none in the last 24 hours. /thenwise:shown lists the four blocks with their sizes: handoff 258 tokens, brief 132, pointers 152, file hint 79. Real output."></p>

## Questions people ask

**Does it send my code anywhere?** No. Your code, your chats and your memory stay on your disk. The only things that ever leave are the ones you switch on: PR lookups through `gh`, `distill`, Teams, and an issue report you approve line by line. Once a day the background sync asks npm for the newest Thenwise version, sending nothing about you; `thenwise update-check off` stops it.

**Does it need a model or an API key?** No. No model runs inside Thenwise, so there is no key to add and no extra bill.

**Does it slow my agent down?** No. Hooks take about 50 ms, search takes milliseconds, and in our tests answers arrived 1.5 to 1.9 times faster.

**What does it cost in tokens?** Less than going without: 60% fewer raw tokens on questions about the past. In a chat that needs no memory, it adds about 1%.

**How does it fit with CLAUDE.md and each tool's own memory?** They hold your standing rules. Thenwise holds the history: what was decided, what was tried, and what was true on any day. It reads your CLAUDE.md files too, dated, so an old rule and its replacement are told apart.

**Can I delete everything?** Yes. `thenwise forget` erases any chat or project for good, and `thenwise uninstall` stops it and lists every file to remove.

## Reference

- [thenwise.dev](https://thenwise.dev): the whole story, drawn, with every page of the docs.
- [Install](docs/install.md): every tool, auto-update, sandboxes, first run.
- [Commands](docs/commands.md): every slash command, terminal command and hook.
- [Privacy](docs/privacy.md): what it keeps, where it lives, masking, forget, backups.
- [Teams](docs/teams.md): the server, roles, invites, sharing chats, runbooks.
- [How we measured](docs/eval.md): the questions, the two arms, the blind grading.

## Dig in with us

Thenwise grows from the questions people bring to it. Pick your way in.

- **Ask a question.** Start a thread in [Discussions](https://github.com/dheerajponnaganti/thenwise/discussions). No question is too small.
- **Report a bug.** Run `thenwise report`. It fills in the [bug form](https://github.com/dheerajponnaganti/thenwise/issues/new?template=bug.yml) with your versions and the error code, with secrets masked.
- **Suggest an idea.** The [idea form](https://github.com/dheerajponnaganti/thenwise/issues/new?template=idea.yml) asks what you want to do and what gets in the way today.
- **Send a pull request.** Fixes, tests, docs and new secret shapes for the mask are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) gets you from clone to green tests in three commands.
- **Show what it found.** Post the answer that saved your afternoon in [Show and tell](https://github.com/dheerajponnaganti/thenwise/discussions/categories/show-and-tell).
- **Star the repo**, so the next person finds it.

Found a security problem? Report it privately, as [SECURITY.md](SECURITY.md) describes.

---

<p align="center"><b>Thenwise</b>: wise about then. <a href="https://thenwise.dev">thenwise.dev</a><br><sub>Apache 2.0 · see <code>LICENSE</code> · Claude Code, GitHub Copilot, Codex and Antigravity are trademarks of their owners; Thenwise is an independent project.</sub></p>
