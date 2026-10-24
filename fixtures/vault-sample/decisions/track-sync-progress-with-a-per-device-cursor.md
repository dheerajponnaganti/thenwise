---
id: dec_01M5J9Y4K8QMBCTTWJY0R7X0GK
type: decision
title: Track sync progress with a per-device cursor
summary: "Each device stores the last change id it has seen, and pull returns changes after that id."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-12
recorded_at: 2026-03-12T09:00:00Z
updated_at: 2026-03-12T09:00:00Z
version: 1
author: sam
aliases: [sync cursor, device cursor]
tags: [sync]
about: ["[[Sync Engine]]", "[[Postgres]]"]
supersedes: []
depends_on: ["[[Postgres advisory locks serialize sync per user]]"]
sources:
  - "file:server/db/migrations/0015_add_cursor.sql@b8d31ee 2026-03-12"
  - "human:sam 2026-03-12"
---

The cursor is a bigint from a Postgres sequence on the change log. Migration 0015 added the device_cursors table.
## Reason
Timestamps broke when device clocks drifted; we saw up to 90 seconds of skew. A sequence gives a strict order, and ordering per user is safe because of [[Postgres advisory locks serialize sync per user]].
## Alternatives considered
- Timestamps with a safety margin: still dropped changes at the edges.
- Vector clocks: heavy for a 3 device limit per user.
