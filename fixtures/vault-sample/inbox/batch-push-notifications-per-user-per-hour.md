---
id: dec_01M5J9Y4MHDK1SJHHVZBZEZFM3
type: decision
title: Batch push notifications per user per hour
summary: "Proposal: send at most one push per user per hour and merge pending events into it."
status: inbox
confidence: agent
origin: local
scope: project
valid_from: 2026-10-21
recorded_at: 2026-10-21T09:00:00Z
updated_at: 2026-10-21T09:00:00Z
version: 1
author: claude-code:session-4e1a
tags: [push]
about: ["[[Beacon Push]]", "[[Sync Server]]"]
supersedes: []
depends_on: []
sources:
  - "file:server/push/index.ts@c7d8e19 2026-10-21"
---

Today a busy user can receive up to 9 silent pushes in an hour. Beacon counts every push against the rate limit.
## Reason
Fewer wake-ups save battery and keep within [[Beacon Push]] limits.
## Alternatives considered
- Per-device throttling in the app: too late, the push already woke the device.
