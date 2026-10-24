---
id: ent_01M5J9Y4M2FSFT5MRTAWP9WXTX
type: entity
title: Sync Engine
summary: "Client sync code: queues local operations, pushes batches, pulls changes by cursor, and calls the conflict resolver."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-01-20
recorded_at: 2025-01-20T09:00:00Z
updated_at: 2025-01-20T09:00:00Z
version: 1
author: sam
aliases: [sync, sync code, sync client]
tags: [sync]
paths: [src/sync/]
part_of: ["[[Tidewater]]"]
sources:
  - "file:src/sync/engine.ts@3f2a1bc 2026-03-09"
---

Lives in src/sync/. Main file is src/sync/engine.ts.
Pushes batches of up to 200 operations to [[API Routes]] and pulls changes after the device cursor, see [[Track sync progress with a per-device cursor]].
Uses the [[Conflict Resolver]] when the server returns a different row than the one the device sent.
Holds the queue behind [[Offline Mode]]. Runs after a push wake-up or a fallback poll, see [[Wake sync from push with a 15 minute fallback poll]].
