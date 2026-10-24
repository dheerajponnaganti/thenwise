---
id: dec_01M5J9Y4JXF1DMDAP2DDT0VSKQ
type: decision
title: Keep local data in AsyncStorage
summary: "All on-device data is stored as JSON blobs in React Native AsyncStorage."
status: superseded
confidence: human
origin: local
scope: project
valid_from: 2025-01-20
valid_to: 2025-11-05
recorded_at: 2025-01-20T09:00:00Z
updated_at: 2025-11-05T09:00:00Z
version: 2
author: ivo
aliases: [AsyncStorage]
tags: [storage, mobile]
about: ["[[Mobile App]]"]
supersedes: []
depends_on: []
sources:
  - "human:ivo 2025-01-20"
---

Habits and budgets are serialized into AsyncStorage keys. Replaced by [[Keep local data in SQLite on device]] on 2025-11-05.
## Reason
It ships with React Native and needs no setup, good for a first prototype.
## Alternatives considered
- MMKV: faster, but still key-value only.
- SQLite: the query needs were not known yet.
