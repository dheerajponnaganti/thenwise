# Releasing Thenwise

## Every change

1. Branch from `main`.
2. Run `npm run gate`.
3. Open a pull request titled `type(area): what changed`. The title becomes the commit subject on `main`, with the issue number added, such as `(#12)`, and the description becomes the message.
4. CI must pass. Windows is a warning until it is green twice in a row.
5. Squash and merge.

## Does it need a version?

- **No:** README, `docs/`, tests, `bench/`, `.github/`, `fixtures/`. It merges and waits for the next release.
- **Patch** (0.x.y to 0.x.y+1): a bug in code users run (`src/`, `hooks/`, `commands/`, `skills/`), with no other change in behaviour.
- **Minor** (0.x to 0.x+1.0): a feature, or a change in what is kept, deleted, shown or sent. Before a minor, run one live session per supported tool.

Plugin users get new code only when the version changes, and npm publishes a version only once.

## A release

1. Open a pull request titled `chore(release): <version>` that bumps `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, and renames `## Unreleased` in `CHANGELOG.md`.
2. Merge it, then tag that commit on `main` as `v<version>`. Tags cannot be moved or deleted.
3. Run `npm run release:branch` and push the `release` branch. It holds one commit per release, with the built `dist/`, and it is what plugin users install.
4. Create the GitHub release.
5. Publish to npm, then confirm the version and checksum on the registry.

## A bad release

Publish a fixed version, and deprecate the bad one with `npm deprecate`. Do not unpublish.

## Bugs

Every bug gets a public issue with no private details. Its fix adds a test named `#<n>: ...`, and the pull request says `Fixes #<n>`. A security bug is fixed first and filed after the fix ships.
