# Install

Thenwise installs as a plugin in each tool you use. Every tool reads and writes the same memory on your machine.

Needs Node 22.16 or later, and git to read your commits. Runs on macOS, Linux and Windows, and every push passes a fresh install on all three. It ships as built JavaScript, so there is nothing to compile.

## Claude Code

```
/plugin marketplace add dheerajponnaganti/thenwise
/plugin install thenwise@thenwise
```

On Claude Code 2.1.275 or later, one line does it:

```
/plugin install thenwise --marketplace dheerajponnaganti/thenwise
```

Start a new session after installing. Turn on auto-update for this marketplace in `/plugin`, so fixes reach you on their own.

## GitHub Copilot CLI

```
copilot plugin marketplace add dheerajponnaganti/thenwise
copilot plugin install thenwise@thenwise
```

- If you turn on Copilot's sandbox, allow your Thenwise data folder in `sandbox.userPolicy`, or the memory cannot open.
- Copilot can sync sessions to GitHub. `thenwise forget` removes a chat from Thenwise; the copy Copilot keeps on GitHub is Copilot's to delete.
- Copilot updates other people's plugins only when asked. Run `copilot plugin update thenwise` now and then, or set `autoUpdate: true` on this marketplace under `extraKnownMarketplaces` in `~/.copilot/settings.json`.

## OpenAI Codex

```
codex plugin marketplace add dheerajponnaganti/thenwise
codex plugin add thenwise@thenwise
```

Then open `/hooks` in Codex and trust Thenwise's hooks, so Codex starts the sync and brings the memory in on its own. Codex asks again after each plugin update. Until then the memory tools still work.

## Google Antigravity

```
agy plugin install https://github.com/dheerajponnaganti/thenwise/tree/main/plugin
```

## Cursor, Gemini CLI and OpenCode

They read the same memory through MCP, including what your team shared:

```bash
npm install -g thenwise
thenwise connect cursor   # or gemini, opencode, codex, antigravity
```

Restart the tool afterwards. `thenwise connect <tool> --remove` takes it back.

## In your terminal

```bash
npm install -g thenwise
```

Every command in [commands.md](commands.md) then runs as `thenwise <command>`.

## First run

Start a session in any of the tools. Thenwise archives your past chats and builds its store in the background, and every project you worked on is remembered. The person sees one line when the first sync starts and how far it got.

Prefer to choose? Run `thenwise setup`. It lists your projects with chat counts and asks which to keep, where your notes go (a folder of their own or your Obsidian vault), whether to fetch PRs with `gh`, and whether to back up.

`thenwise doctor` checks everything and prints one fix line per problem.

## Where it lives

Data lives in `~/.thenwise`, or in `THENWISE_HOME` when you set it. [privacy.md](privacy.md) lists every file in it.

## Remove it

`thenwise uninstall` stops the background sync and lists what to delete by hand. It deletes nothing itself. Then remove the plugin in each tool.
