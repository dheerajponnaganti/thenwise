---
id: dec_01M5J9Y4KEXFX4ADH7P5QA6JYV
type: decision
title: Wake sync from push with a 15 minute fallback poll
summary: "The server sends a silent push when a user's data changes; the app syncs on wake and polls every 15 minutes as a safety net."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-05-20
recorded_at: 2026-05-20T09:00:00Z
updated_at: 2026-05-20T09:00:00Z
version: 1
author: sam
aliases: [push wake sync, fallback poll, 15 minute poll]
tags: [sync, battery]
about: ["[[Sync Engine]]", "[[Sync Server]]"]
supersedes: ["[[Poll for changes every 5 minutes]]"]
depends_on: []
sources:
  - "file:src/sync/engine.ts@3f2a1bc 2026-05-19"
  - "human:sam 2026-05-20"
---

What changed: sync is triggered by a silent push, not a 5 minute timer. A 15 minute poll remains in case a push is dropped. This supersedes [[Poll for changes every 5 minutes]].
## Reason
A 2 week beta with 60 testers showed battery use falling from 2.1% to 0.6% per day, and average freshness improving from about 150 s to under 5 s.
## Alternatives considered
- Keep the 5 minute poll: simple but costs battery.
- Foreground websocket: rejected, one open server connection per active user.
