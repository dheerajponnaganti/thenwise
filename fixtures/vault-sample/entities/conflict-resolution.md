---
id: ent_01M5J9Y4KQ30JHA4C8KF3YA8KX
type: entity
title: Conflict Resolution
summary: "Concept: how Tidewater decides the final value when two devices edit the same record."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-02
recorded_at: 2025-02-02T09:00:00Z
updated_at: 2025-02-02T09:00:00Z
version: 1
author: sam
aliases: [conflict handling, merge rules]
tags: [concept, sync]
sources:
  - "human:sam 2025-02-02"
---

Two rules today. Budgets: the server decides, see [[Use server-authoritative sync for budgets]]. Habit check-ins: last write wins, see [[Keep last-write-wins for habit check-ins]].
Implemented by the [[Conflict Resolver]]. Alternative approach: [[CRDT]].
Concurrent edits are rare in practice: [[Concurrent budget edits are rare]].
