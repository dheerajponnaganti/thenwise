# Thenwise agent guide

Thenwise is a Claude Code plugin and an npm package that gives Claude a local memory of past chats, commits, pull requests, notes and plans. It stores them in one SQLite file and searches them with no model. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing how the parts connect.

## If you are an AI agent

- A person reviews and owns every line you write. Do not open a pull request, issue or comment without your operator's approval.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Commands

- `npm ci`: install. You need Node 22.16 or later and git.
- `npm run gate`: everything CI checks. Run it before every pull request.
- `npm test`: all tests. Each test runs in its own temp home.
- `node --import ./test/isolate.mjs --test test/<file>.test.ts`: one test file. Prefer this while working.
- `npm run check`: type check.
- `npm run build`: build `dist/`, which is what the plugin runs.
- `node src/cli.ts <command>`: run the CLI from source.
- `git config core.hooksPath .githooks`: turn on the pre-push check, once per clone.

## Rules that must hold

- NEVER add a runtime dependency. The package ships with none.
- NEVER make a network call in search or hooks. Anything that leaves the machine is something the user turned on.
- NEVER store text without masking it. Everything goes through `src/core/secrets.ts`.
- NEVER let a hook fail or block the user's chat. Errors go to the log and the exit code stays 0.
- NEVER change a user's own notes or Claude Code's chat files. Thenwise only reads them.
- ALWAYS keep the incremental update equal to a full rebuild. A change to what ingest produces must work in both paths.
- ALWAYS bump `STATE_VERSION` when existing stores must rebuild, and `MASK_VERSION` when existing archives must be masked again.
- ALWAYS use forward slashes in stored paths, through `normPath`, so Windows and other systems match.

## Tests

- A new feature or fix needs a test that fails without it.
- A bug fix's test is named `#<issue>: what it guards`.
- Tests never touch the real home. `test/isolate.mjs` sets this up, and tests that start a child process must pass their own `HOME` and `THENWISE_HOME`.
- Match the style of nearby tests. Check whether an existing test already covers the behaviour.
- Tests must pass on macOS, Linux and Windows, so build paths with `join` and compare stored paths with forward slashes.

## Pull requests

- One change per pull request.
- Title: `type(area): what changed`, such as `fix(hooks): keep the store open`. Types are fix, feat, docs, test, ci, chore, refactor and perf. Areas are hooks, search, ingest, privacy, teams, hub, plugin and ci. CI checks the form.
- A change users will notice gets a line under `## Unreleased` in `CHANGELOG.md`.
- Write short, plain sentences in docs, messages and comments.
- [RELEASING.md](RELEASING.md) explains versions and releases.
