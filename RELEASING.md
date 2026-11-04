# Releasing Thenwise

## Every change

1. Branch from `main`.
2. Run `npm run gate`.
3. Open a pull request titled `type(area): what changed`. The title becomes the commit subject on `main`, with the issue number added, such as `(#12)`, and the description becomes the message.
4. CI must pass on macOS, Linux and Windows.
5. Squash and merge.

## Does it need a version?

- **No:** README, `docs/`, tests, `bench/`, `.github/`, `fixtures/`. It merges and waits for the next release.
- **Patch** (0.x.y to 0.x.y+1): a bug in code users run (`src/`, `hooks/`, `commands/`, `skills/`), with no other change in behaviour.
- **Minor** (0.x to 0.x+1.0): a feature, or a change in what is kept, deleted, shown or sent. Before a minor, run one live session per supported tool.

Plugin users get new code only when the version changes, and npm publishes a version only once.

## A release

1. Open a pull request titled `chore(release): <version>` that bumps the version in `package.json`, `package-lock.json` and every plugin manifest (`scripts/check-versions.mjs` lists them), and renames `## Unreleased` in `CHANGELOG.md`. In the same pull request, run `npm run plugin:folder` and commit `plugin/`: the built plugin every tool installs from. Say whether hooks changed.
2. CI proves the pull request before you merge it: `plugin/` may change only with a version bump, and it must be exactly the pull request's source, built. Merging publishes it, because every tool installs `plugin/` from `main`. Then update your local `main`.
3. Tag the merged commit on `main` as `v<version>` and push the tag. Tags cannot be moved or deleted, so check the version first.
4. The `release` workflow checks that the tag matches every version and that `plugin/` is exactly its source, built. Then it builds the package and stages it on npm. Nobody can install it yet.
5. Review it under Staged Packages on npmjs.com, or with `npm stage download <id>`, and approve it with 2FA.
6. Confirm provenance with `npm view thenwise@<version> dist.attestations`.
7. The workflow drafts the GitHub release from the changelog. Publish the draft.

A new tool's branch merges inside the release pull request that ships it, never before: the README on `main` is the install page, and `plugin/` cannot serve a tool until a release builds it in.

Keep the old `release` branch on GitHub. Installs made before `plugin/` existed read it until their marketplace refreshes.

If a run fails after the tag, fix the cause in a new version. Reruns are safe: a version already on npm is left alone.

## A bad release

Publish a fixed version, and deprecate the bad one with `npm deprecate`. Do not unpublish.

## Bugs

Every bug gets a public issue with no private details. Its fix adds a test named `#<n>: ...`, and the pull request says `Fixes #<n>`. A security bug is fixed first and filed after the fix ships.
