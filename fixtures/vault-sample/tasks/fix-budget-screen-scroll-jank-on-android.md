---
id: tsk_01M5J9Y4MZM4DE3YQF4FX4S4TB
type: task
title: Fix Budget screen scroll jank on Android
summary: "Remove dropped frames when scrolling the envelope list on mid-range Android phones."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-08-20
recorded_at: 2026-08-20T09:00:00Z
updated_at: 2026-08-20T09:00:00Z
version: 1
author: ivo
done: true
due: 2026-09-01
about: ["[[Budget Screen]]"]
sources:
  - "commit:e5a40bd 2026-08-31"
---

Cause was rendering 60 envelope cards without virtualization.
Switched to FlashList and memoized the totals.
Dropped frames went from 18% to 2%.
