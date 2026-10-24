---
id: fnd_01M5J9Y4MEQ5NBV0QDPA2BBYZN
type: finding
title: SQLite write throughput depends on transactions
summary: "On a Pixel 6a, SQLite managed 12,000 inserts per second inside one transaction and 300 per second without."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-10-20
recorded_at: 2025-10-20T09:00:00Z
updated_at: 2025-10-20T09:00:00Z
version: 1
author: ivo
about: ["[[On-device SQLite]]"]
sources:
  - "file:bench/sqlite-insert.ts@a41b9e0 2025-10-20"
---

Benchmark inserted 50,000 small rows with expo-sqlite, with and without a wrapping transaction.
The queue writer in [[Offline Mode]] therefore batches writes per 100 ms.
Supports [[Keep local data in SQLite on device]].
