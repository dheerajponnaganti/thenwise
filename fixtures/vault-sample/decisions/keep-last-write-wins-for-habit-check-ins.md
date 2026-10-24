---
id: dec_01M5J9Y4JWQ0M9J85P1YJDVBAG
type: decision
title: Keep last-write-wins for habit check-ins
summary: "Habit check-ins merge by latest timestamp; the newer write replaces the older one."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-12
recorded_at: 2026-03-12T09:00:00Z
updated_at: 2026-03-12T09:00:00Z
version: 1
author: lena
aliases: [LWW check-ins, latest write wins]
tags: [sync, habits]
about: ["[[Conflict Resolver]]", "[[Conflict Resolution]]"]
supersedes: []
depends_on: []
sources:
  - "file:src/sync/conflict.ts@77be0d1 2026-03-12"
---

Applied in the [[Conflict Resolver]] for rows in the habit_checkins table.
## Reason
A check-in is a boolean per habit per day, so losing one edit costs nothing. The rule is about 30 lines of code. Budgets are different, see [[Use server-authoritative sync for budgets]].
## Alternatives considered
- A CRDT counter per habit: overkill for a boolean.
- Server-authoritative check-ins: adds latency to a tick box.
