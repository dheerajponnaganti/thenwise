---
id: ent_01M5J9Y4KZ811AZ3TPSE7CY12V
type: entity
title: On-device SQLite
summary: "The local database on each phone, accessed through expo-sqlite, holding habits, budgets and the operation queue."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-11-06
recorded_at: 2025-11-06T09:00:00Z
updated_at: 2025-11-06T09:00:00Z
version: 1
author: ivo
aliases: [local database, sqlite, local db]
tags: [mobile, storage]
paths: [src/db/]
part_of: ["[[Mobile App]]"]
sources:
  - "file:src/db/index.ts@d02e7a3 2025-11-06"
---

Code is in src/db/. Schema versions are applied on app start by a small runner.
Chosen in [[Keep local data in SQLite on device]]. Writes must be wrapped in transactions, see [[SQLite write throughput depends on transactions]].
Not encrypted in version 1: [[Skip database encryption in version 1]].
Open work: [[Benchmark SQLite vacuum on low-end phones]].
