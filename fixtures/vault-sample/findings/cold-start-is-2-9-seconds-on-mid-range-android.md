---
id: fnd_01M5J9Y4M73H0CZPYWJF9Y8CG1
type: finding
title: Cold start is 2.9 seconds on mid-range Android
summary: "Hermes cold start on a Galaxy A54 takes 2.9 seconds; the goal is 2.0 seconds."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-08-18
recorded_at: 2026-08-18T09:00:00Z
updated_at: 2026-08-18T09:00:00Z
version: 1
author: ivo
about: ["[[Mobile App]]", "[[Expo]]"]
sources:
  - "human:ivo 2026-08-18"
  - "file:app.json@8ac2217 2026-08-18"
---

Measured from tap to first interactive frame, median of 20 runs.
Hermes is already on. 1.1 s is spent loading the [[On-device SQLite]] schema runner.
Config in app.json for [[Expo]].
