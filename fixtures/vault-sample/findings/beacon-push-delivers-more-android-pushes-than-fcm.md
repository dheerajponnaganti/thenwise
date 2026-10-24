---
id: fnd_01M5J9Y4M5W3817AZHKYR57VNR
type: finding
title: Beacon Push delivers more Android pushes than FCM
summary: "In a 3 week test on 1,200 Android devices, Beacon delivered 97.8% of pushes within 30 s against 94.1% for FCM."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-06-20
recorded_at: 2026-06-20T09:00:00Z
updated_at: 2026-06-20T09:00:00Z
version: 1
author: sam
about: ["[[Beacon Push]]"]
sources:
  - "file:bench/push-compare.csv@5d20f3a 2026-06-20"
---

Both providers received the same 4,000 silent pushes per day. Raw numbers are in bench/push-compare.csv.
The gap was largest on devices with aggressive battery savers.
Basis for [[Send push through Beacon Push]]. Provider page: [[Beacon Push]].
