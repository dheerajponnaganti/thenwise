---
id: rul_01M5J9Y4MT5FE4PBREM9KFFBDG
type: rule
title: Every sync change needs a conflict test
summary: "A pull request that changes src/sync/ must add or update a test in tests/sync/conflict.test.ts."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-15
recorded_at: 2026-03-15T09:00:00Z
updated_at: 2026-03-15T09:00:00Z
version: 1
author: lena
aliases: [conflict test rule, sync test rule]
tags: [code-style, sync]
about: ["[[Sync Engine]]", "[[Conflict Resolver]]"]
sources:
  - "human:lena 2026-03-15"
---

The PR template has a checkbox.
Reviewers reject sync changes without a test that covers two devices editing the same row.
Fixtures were built in [[Build conflict test fixtures]].
