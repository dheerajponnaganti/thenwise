---
id: tsk_01M5J9Y4MYQR8V8NE1EFVNSAYN
type: task
title: Benchmark SQLite vacuum on low-end phones
summary: "Measure how long VACUUM takes on a 50 MB database and decide when to run it."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-10-12
recorded_at: 2026-10-12T09:00:00Z
updated_at: 2026-10-12T09:00:00Z
version: 1
author: ivo
done: false
about: ["[[On-device SQLite]]"]
sources:
  - "human:ivo 2026-10-12"
---

Run on the Moto G Power and Galaxy A54. Report to [[On-device SQLite]] notes.
Target: under 2 seconds for a 50 MB file.
If slower, run VACUUM only while charging.
