---
id: fnd_01M5J9Y4MD9ZTWMY1BRVKWZY0P
type: finding
title: Postgres advisory locks serialize sync per user
summary: "Push handlers wrap each user's writes in pg_advisory_xact_lock, so concurrent pushes queue up per user."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-04-02
recorded_at: 2026-04-02T09:00:00Z
updated_at: 2026-04-02T09:00:00Z
version: 1
author: sam
about: ["[[Postgres]]", "[[API Routes]]"]
sources:
  - "file:server/api/routes.ts@e44a1d7 2026-04-02"
---

p95 push latency is 120 ms. Two devices pushing at the same moment wait for each other, with no deadlocks seen in 10,000 test runs.
The lock keys on a hash of the user id and is released at transaction end.
It makes the change sequence in [[Track sync progress with a per-device cursor]] strictly ordered per user. Code: [[API Routes]].
