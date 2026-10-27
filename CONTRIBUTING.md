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
```

Run the CLI from source with `node src/cli.ts <command>`. The plugin runs the built copy in `dist/`, so run `npm run build` before you try a change inside Claude Code.

## Where things live

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

## Pull requests

- One change per pull request, with a test that fails without it.
- `npm test` and `npm run check` pass.
- Thenwise has no runtime dependencies. A pull request that adds one needs a strong reason.
- Nothing leaves the machine unless the user turned it on. No telemetry, no network calls in search or hooks.
- Add a line to `CHANGELOG.md` under the next version.
- Write short, plain sentences in docs, messages and comments.

By sending a pull request, you agree that your contribution is licensed under the Apache License 2.0, as section 5 of [LICENSE](LICENSE) describes.
