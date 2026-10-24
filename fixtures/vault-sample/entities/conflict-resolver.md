---
id: ent_01M5J9Y4KRVJ8XXCTF4X1V4J4J
type: entity
title: Conflict Resolver
summary: "Module that applies the conflict rules: server wins for budgets, last write wins for habit check-ins."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-02
recorded_at: 2025-02-02T09:00:00Z
updated_at: 2025-02-02T09:00:00Z
version: 1
author: sam
aliases: [conflict.ts, merge code]
tags: [sync]
paths: [src/sync/conflict.ts]
part_of: ["[[Sync Engine]]"]
sources:
  - "file:src/sync/conflict.ts@77be0d1 2026-03-14"
---

Single file: src/sync/conflict.ts, about 140 lines.
Implements [[Conflict Resolution]] for the [[Sync Engine]].
Budget rows: take the server row, see [[Use server-authoritative sync for budgets]]. Habit check-ins: compare timestamps, see [[Keep last-write-wins for habit check-ins]].
Test fixtures are in tests/sync/, required by [[Every sync change needs a conflict test]].
