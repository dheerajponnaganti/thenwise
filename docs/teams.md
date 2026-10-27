# Thenwise Teams

A team shares the notes its members choose (decisions, dead ends, findings) through one small server the team runs itself. Chats stay home unless a member shares a project. Raw transcripts never travel.

## Run the server

On a machine the team can reach, with TLS in front of it:

```sh
thenwise team serve --dir ~/thenwise-team --console <hub build folder> --tls-behind-proxy --host 0.0.0.0
```

`--host` beyond this machine needs `--tls-behind-proxy` (a TLS proxy such as Caddy in front, cookies marked Secure) or `--allow-plain-http`. For the shortest path, use the Docker kit in `docker/`: it runs the server, the Hub and Caddy with automatic certificates.

## Invite and join

```sh
thenwise team invite alice --dir ~/thenwise-team      # prints alice's token once; the first member is the owner
thenwise team join https://team.example.com <token>   # on alice's machine
```

An invite link from the Hub works the same in a browser. Roles: owner, admin, editor, member, viewer. Admins manage members; editors can edit any note; viewers read.

## Share

```sh
thenwise share <note id or file.md>    # preview, mask, confirm, send
thenwise unshare <note>
thenwise team search <words>
```

Teammates' notes arrive at each sync and become part of the memory, so Claude finds them and names who shared them. With the review queue on (an owner setting in the Hub), a share by someone who is not an admin waits for approval and reaches nobody until then.

## The Hub

Open the server's address in a browser and sign in with your token. It shows the team's notes by project, a search, each note with its history, the members, and the review queue. It works on a phone.

## Back up and restore

```sh
thenwise team backup team-2026-10-27.db --dir ~/thenwise-team     # safe while the server runs
thenwise team restore team-2026-10-27.db --dir ~/thenwise-team    # with the server stopped
```

A backup holds notes, members, sessions and the audit log, and is readable by its owner only. A restore refuses a file from a newer Thenwise.

## Remove a member

```sh
thenwise team remove bob --keep-notes --dir ~/thenwise-team     # or --delete-notes
thenwise team members --dir ~/thenwise-team
thenwise team rotate alice --dir ~/thenwise-team                 # a new token; the old one stops at once
```

A removed name is never given to someone else. `team invite --again bob` brings the same person back to their notes.

## Share a project's chats

A member opts in per project. Nothing is shared until a project is named.

```sh
thenwise team share-chats <repo path>
thenwise team unshare-chats <project or session id>
```

The first time, a preview shows the number of chats and passages, the size, the oldest and newest date, three masked passages picked at random, and what was left out. Confirm with a typed `yes` or `--yes`. Members and above can share. Viewers cannot.

| Travels | Never travels |
| --- | --- |
| Prompt and reply text, cut into masked passages | Raw transcripts |
| Compaction summaries | Tool output |
| Session id, first prompt, start and end time | Thinking |
| Repo-relative paths, short commit shas, PR URLs | File contents and absolute paths |
| Dead-end flags | Subagent turns |
| | Chats marked `[no-memory]`, and paused projects |

Teammates' Claude finds shared chats like its own memory and names whose chat it was. The Hub shows them as bound volumes.

**Unshare.** `team unshare-chats <project>` removes the project's chats from the server. `team unshare-chats <session id>` removes one chat. Teammates drop them at their next sync.

**Forget.** `thenwise forget` also deletes a shared chat from the server.

**Redact list.** Masking catches key formats. It cannot catch customer names, internal hostnames, pasted emails or a password written in prose. List those words in `config.json`, and they are replaced with `[redacted]` before anything leaves. The preview shows what the list removed.

```json
{ "team": { "redact": ["Acme", "acme.internal"] } }
```

**Retention.** An optional team setting deletes shared chats older than N days. Members drop them at their next sync.

**Admins.** An admin can unshare any member's chats and sees a sharing ledger: who shares which project, how many chats, how many bytes, and the last push.

### What this does not protect

- The server owner can read every shared passage.
- A removed member keeps what they already fetched.
- A teammate who has synced keeps a copy until their next sync after an unshare. A machine that never syncs again keeps it.
- Backups made before a deletion still hold the chat. Rotate old backups.
- Masking and the redact list can miss a secret in a format nobody listed. Read the preview.

## What leaves which machine

| | Stays on your machine | Goes to the team server |
| --- | --- | --- |
| Your chats | Always, as raw transcripts | Nothing, unless you share a project |
| A shared project's chats | The originals | Masked passages of its prompts and replies, after a preview |
| Your notes | Until you share one | The notes you share, masked at send |
| Teammates' notes | A copy, fetched at each sync | Already there |
| Tokens | `team.json`, readable by you only | Only a hash of each token |
