---
id: dec_01M5J9Y4KA4GH1HMZQ2MJMM8S2
type: decision
title: Use Expo managed workflow with a dev client
summary: "The app has no ios/ or android/ folders; native builds run on EAS, and a custom dev client carries expo-sqlite."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-01-25
recorded_at: 2025-01-25T09:00:00Z
updated_at: 2025-01-25T09:00:00Z
version: 1
author: ivo
aliases: [managed workflow, dev client]
tags: [mobile]
about: ["[[Expo]]", "[[Mobile App]]"]
supersedes: []
depends_on: []
sources:
  - "human:ivo 2025-01-25"
---

Config lives in app.json and eas.json. Native modules are added as config plugins.
## Reason
A two person mobile effort cannot maintain native projects. EAS builds take about 12 minutes and need no local Xcode setup.
## Alternatives considered
- Bare React Native CLI: full native control but a heavy upgrade burden.
- Expo Go only: cannot load expo-sqlite config plugins.
