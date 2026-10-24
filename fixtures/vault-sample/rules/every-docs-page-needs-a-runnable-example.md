---
id: rul_01M5J9Y4MTZNH5WMG4G1VZH0R5
type: rule
title: Every docs page needs a runnable example
summary: "Each page in docs/guide/ must contain at least one example that runs in the docs test suite."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-06-10
recorded_at: 2025-06-10T09:00:00Z
updated_at: 2025-06-10T09:00:00Z
version: 1
author: ruth
aliases: [tested snippets]
tags: [writing, docs]
about: ["[[Docs Site]]"]
sources:
  - "human:ruth 2025-06-10"
---

Examples are extracted by docs:test and executed against a local sync server.
A page without a tested snippet fails review.
Applies to the [[Docs Site]].
