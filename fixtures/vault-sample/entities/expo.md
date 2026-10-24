---
id: ent_01M5J9Y4KV2PK3AFCP88ZY1AXW
type: entity
title: Expo
summary: "Expo toolchain and EAS build service used for the mobile app."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-01-25
recorded_at: 2025-01-25T09:00:00Z
updated_at: 2025-01-25T09:00:00Z
version: 1
author: ivo
aliases: [EAS, Expo SDK]
tags: [external, mobile]
paths: [app.json, eas.json]
sources:
  - "file:app.json@8ac2217 2026-08-18"
---

Config files: app.json and eas.json. We use the managed workflow with a dev client, see [[Use Expo managed workflow with a dev client]].
Known issues: [[Expo push tokens expire after reinstall]] and [[Expo SDK 54 needs the new build config]].
Startup numbers: [[Cold start is 2.9 seconds on mid-range Android]].
Used by the [[Mobile App]].
