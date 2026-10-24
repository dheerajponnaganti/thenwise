---
id: tsk_01M5J9Y4MY139A7ER7ZQT984VV
type: task
title: Build conflict test fixtures
summary: "Create fixtures for two and three device edit sequences used by the conflict tests."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-16
recorded_at: 2026-03-16T09:00:00Z
updated_at: 2026-03-16T09:00:00Z
version: 1
author: sam
done: true
due: 2026-04-30
about: ["[[Conflict Resolver]]"]
sources:
  - "commit:0be12a7 2026-04-27"
---

Fixtures live in tests/sync/fixtures/ and cover 12 scenarios.
Required by [[Every sync change needs a conflict test]].
Each fixture replays a list of operations against the [[Conflict Resolver]] and checks the final rows.
