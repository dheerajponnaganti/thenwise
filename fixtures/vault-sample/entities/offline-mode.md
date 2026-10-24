---
id: ent_01M5J9Y4KYQKTW157YTX001KM3
type: entity
title: Offline Mode
summary: "Concept and code path that keeps every screen usable without a network by queuing operations."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-05
recorded_at: 2025-02-05T09:00:00Z
updated_at: 2025-02-05T09:00:00Z
version: 1
author: ivo
aliases: [offline, airplane mode support, offline queue]
tags: [sync, mobile]
paths: [src/sync/queue.ts]
part_of: ["[[Sync Engine]]"]
sources:
  - "file:src/sync/queue.ts@2b9f4a8 2026-05-28"
---

Every write goes to [[On-device SQLite]] first and to an operation queue second (src/sync/queue.ts).
The queue drains through the [[Sync Engine]] when the network returns.
The queue is capped, see [[Cap the offline queue at 5000 operations]].
Typical queue sizes are small, see [[Median offline queue is 14 operations]].
