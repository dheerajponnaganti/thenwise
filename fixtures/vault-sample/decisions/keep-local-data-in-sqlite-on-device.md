---
id: dec_01M5J9Y4JY9KHYCRHFB7FS1X54
type: decision
title: Keep local data in SQLite on device
summary: "The app stores habits, budgets and the operation queue in a local SQLite database through expo-sqlite."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-11-05
recorded_at: 2025-11-05T09:00:00Z
updated_at: 2025-11-05T09:00:00Z
version: 1
author: ivo
aliases: [use sqlite, local storage engine, sqlite on phone]
tags: [storage, mobile]
about: ["[[On-device SQLite]]", "[[Mobile App]]"]
supersedes: ["[[Keep local data in AsyncStorage]]"]
depends_on: ["[[AsyncStorage slows past 6 MB on Android]]", "[[SQLite write throughput depends on transactions]]"]
sources:
  - "file:src/db/index.ts@d02e7a3 2025-11-05"
  - "human:ivo 2025-11-05"
---

What changed: JSON blobs in AsyncStorage became tables in [[On-device SQLite]]. This supersedes [[Keep local data in AsyncStorage]]. Task [[Move leftover AsyncStorage keys to SQLite]] finished the migration.
## Reason
AsyncStorage slows past 6 MB on Android ([[AsyncStorage slows past 6 MB on Android]]). Budgets need range queries by month. Batched inserts reach 12,000 rows per second ([[SQLite write throughput depends on transactions]]).
## Alternatives considered
- MMKV: fast but no queries.
- WatermelonDB: its own sync layer clashed with ours.
