---
id: fnd_01M5J9Y4M46PKYHAHACWF82A90
type: finding
title: AsyncStorage slows past 6 MB on Android
summary: "Reading 6 MB from AsyncStorage on Android took 1.4 seconds, and the default size cap is 6 MB."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-10-02
recorded_at: 2025-10-02T09:00:00Z
updated_at: 2025-10-02T09:00:00Z
version: 1
author: ivo
about: ["[[Mobile App]]"]
sources:
  - "url:https://github.example.com/rn-async-storage/issues/412 2025-09-28"
  - "human:ivo 2025-10-02"
---

Heavy users reached 4.8 MB after 8 months of habit data.
Each read parsed the full JSON blob.
This was the trigger for [[Keep local data in SQLite on device]].
