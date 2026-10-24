---
id: not_01M5J9Y4JKNVQKF7TAS5EV265W
tags: [hub]
---

# Decision Index

Every decision in the vault, newest first within each group. Reasons are in the notes. Context: [[Home]], [[Tidewater]].

## Active
- [[Send push through Beacon Push]] (2026-07-14): Notifications go through the Beacon Push HTTP API instead of calling FCM and APNs ourselves.
- [[Skip database encryption in version 1]] (2026-06-02): The on-device database is not encrypted in version 1; we rely on OS-level encryption of locked devices.
- [[Cap the offline queue at 5000 operations]] (2026-05-28): The local operation queue holds at most 5000 operations; when full, old check-ins coalesce and budget edits are blocked with a banner.
- [[Wake sync from push with a 15 minute fallback poll]] (2026-05-20): The server sends a silent push when a user's data changes; the app syncs on wake and polls every 15 minutes as a safety net.
- [[Check docs links in CI]] (2026-05-02): Every pull request that touches docs/ runs a link checker that fails on dead links.
- [[Version the sync protocol with semantic versions]] (2026-04-20): The sync protocol has a major.minor version sent in the X-Tidewater-Protocol header; a major bump makes the server reject old clients with HTTP 426.
- [[Build the docs site with Astro Starlight]] (2026-04-08): The docs site is built with Astro Starlight; CI builds finish in under a minute.
- [[Track sync progress with a per-device cursor]] (2026-03-12): Each device stores the last change id it has seen, and pull returns changes after that id.
- [[Keep last-write-wins for habit check-ins]] (2026-03-12): Habit check-ins merge by latest timestamp; the newer write replaces the older one.
- [[Use server-authoritative sync for budgets]] (2026-03-10): The server decides the final state of every budget entry; devices queue edits and accept the server's answer after sync.
- [[Keep local data in SQLite on device]] (2025-11-05): The app stores habits, budgets and the operation queue in a local SQLite database through expo-sqlite.
- [[Support bank CSV import before bank APIs]] (2025-10-14): Users import transactions from bank CSV files; direct bank connections are postponed.
- [[Ship mobile releases every two weeks]] (2025-09-01): The mobile app ships on a fixed two week train, with a hotfix path for urgent bugs.
- [[Keep the blog in Markdown in the main repo]] (2025-08-12): Blog posts are Markdown files in blog/, reviewed through pull requests.
- [[Use short-lived JWT access tokens]] (2025-07-08): Access tokens are JWTs that expire after 15 minutes; refresh tokens last 30 days and live in the secure store.
- [[Write migrations as forward-only SQL files]] (2025-05-10): Schema changes are plain SQL files that only move forward; fixes ship as new migrations.
- [[Validate API payloads with Zod]] (2025-04-15): Request and response bodies are checked with Zod schemas shared by client and server.
- [[Run the sync server on Postgres 16]] (2025-03-20): The sync server uses PostgreSQL 16 on a managed host.
- [[Store money as integer cents]] (2025-03-02): All amounts are stored and sent as integers in the smallest currency unit, with a separate currency code.
- [[Use Expo managed workflow with a dev client]] (2025-01-25): The app has no ios/ or android/ folders; native builds run on EAS, and a custom dev client carries expo-sqlite.

## Superseded
- [[Send push through Firebase Cloud Messaging directly]] (2025-06-01): The server calls Firebase Cloud Messaging for Android and its APNs bridge for iOS to deliver notifications. Ended 2026-07-14.
- [[Poll for changes every 5 minutes]] (2025-04-01): The app polls the server every 5 minutes while idle to pick up changes from other devices. Ended 2026-05-20.
- [[Build the docs site with Docusaurus]] (2025-02-20): The docs site is generated with Docusaurus, with its built-in search and versioning. Ended 2026-04-08.
- [[Use CRDTs for budget data]] (2025-02-10): Budget edits synced as CRDT operations so devices could edit offline and merge without server arbitration. Ended 2026-03-10.
- [[Keep local data in AsyncStorage]] (2025-01-20): All on-device data is stored as JSON blobs in React Native AsyncStorage. Ended 2025-11-05.

Two meeting notes restate decisions in looser words: [[Budget sync - server decides]] and [[Moving docs to Starlight]]. The decision notes are the record.
