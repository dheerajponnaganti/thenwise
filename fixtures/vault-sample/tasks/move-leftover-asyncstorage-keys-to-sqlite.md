---
id: tsk_01M5J9Y4N0MR4XQZBNKM34VSMX
type: task
title: Move leftover AsyncStorage keys to SQLite
summary: "Copy the last AsyncStorage settings keys into SQLite and delete the old storage code."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-11-06
recorded_at: 2025-11-06T09:00:00Z
updated_at: 2025-11-06T09:00:00Z
version: 1
author: ivo
done: true
due: 2025-12-01
about: ["[[On-device SQLite]]"]
sources:
  - "human:ivo 2025-11-06"
---

Finishes [[Keep local data in SQLite on device]]. Moved 14 keys and removed the AsyncStorage dependency.
Shipped in release 1.3.
Old code path is gone from [[Mobile App]].
