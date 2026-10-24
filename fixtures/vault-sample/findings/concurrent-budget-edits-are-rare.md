---
id: fnd_01M5J9Y4M8XC5H5S5DY0PSQSC4
type: finding
title: Concurrent budget edits are rare
summary: "In January 2026 only 0.4% of 18,000 syncs touched the same budget line from two devices."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-02-02
recorded_at: 2026-02-02T09:00:00Z
updated_at: 2026-02-02T09:00:00Z
version: 1
author: sam
about: ["[[Conflict Resolution]]"]
derived_from: ["[[Weekly sync 2026-01-26]]"]
sources:
  - "human:sam 2026-02-02"
  - "file:server/api/routes.ts@e44a1d7 2026-01-31"
---

Counted from server logs: 72 conflicting budget edits out of 18,000 syncs.
Most were a double tap on one phone.
Came out of the weekly sync, see [[Weekly sync 2026-01-26]].
Used in [[Use server-authoritative sync for budgets]].
