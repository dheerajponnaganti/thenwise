# Contributing to Thenwise

Thanks for digging in. Every kind of help counts, and most of it needs no code. Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Ask a question** in [Discussions](https://github.com/dheerajponnaganti/thenwise/discussions). Your question shows us where the docs are thin.
- **Report a bug** with `thenwise report`. It opens the bug form with your versions and the error code filled in, with secrets masked.
- **Suggest an idea** with the [idea form](https://github.com/dheerajponnaganti/thenwise/issues/new?template=idea.yml).
- **Improve the docs.** A clearer sentence in the README or `docs/` is a welcome pull request.
- **Teach the mask a new secret shape.** Add the pattern in `src/core/secrets.ts` and a test with a fake key.
- **Fix a bug or build a feature.** For anything large, open an idea first so we can agree on the shape before you write it.
- **Share what it found** in [Show and tell](https://github.com/dheerajponnaganti/thenwise/discussions/categories/show-and-tell).

## Set up

You need Node 22.16 or later and git.

```sh
git clone https://github.com/dheerajponnaganti/thenwise.git
cd thenwise
npm ci
npm test            # every test, in isolated temp homes
npm run check       # type check
npm run gate        # everything CI checks: types, build, tests, package, hooks, owner-data scan
```

Run the CLI from source with `node src/cli.ts <command>`. The plugin runs the built copy in `dist/`, so run `npm run build` before you try a change inside Claude Code.

## Where things live

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts connect, and [ROADMAP.md](ROADMAP.md) shows where the project is heading. Coding agents read [AGENTS.md](AGENTS.md).

| Folder | What it holds |
| --- | --- |
| `src/ingest` | Archiving chats, reading commits, PRs and plans, building the store |
| `src/query` | Search, history and the answer layout |
| `src/hooks` | The quiet hooks that run during a session |
| `src/server` | The MCP server and its seven tools |
| `src/teams` | The team server, sync and shared project chats |
| `src/vault` | The notebook in your vault |
| `src/privacy` | Forget, tombstones and uninstall |
| `test` | `node:test` suites, one file per area |
| `bench` | Benchmarks and evals |

## Bugs and their tests

Every bug gets a GitHub issue, and its fix gets a test named after it, so `grep -rn "'#41" test/` finds the test that guards bug 41:

```ts
test('#41: a [no-memory] marker added after a sync drops the archived copy', () => { ... })
```

The commit message ends with `Fixes #41`, and the changelog line ends with `(#41)`.

## Pull requests

- **Title:** `type(area): what changed`, such as `fix(hooks): keep the store open`. Types are fix, feat, docs, test, ci, chore, refactor and perf. Areas are the `area:` labels, such as hooks, search, ingest, privacy, teams, hub, plugin and ci. CI checks the form.
- One change per pull request, with a test that fails without it.
- `npm run gate` passes.
- **How a pull request lands:** it is squashed into one commit on `main`, with its title and description as the message, and you stay the author. Write them for a public history.
- Before your first push, run `git config core.hooksPath .githooks`. The hook refuses owner data and bad commit messages.
- Thenwise has no runtime dependencies. A pull request that adds one needs a strong reason.
- Nothing leaves the machine unless the user turned it on. No telemetry, no network calls in search or hooks.
- Add a line to `CHANGELOG.md` under the next version.
- Write short, plain sentences in docs, messages and comments.

By sending a pull request, you agree that your contribution is licensed under the Apache License 2.0, as section 5 of [LICENSE](LICENSE) describes.
