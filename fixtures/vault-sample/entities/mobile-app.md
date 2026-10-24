---
id: ent_01M5J9Y4KXM2R080N1J8EEC4EY
type: entity
title: Mobile App
summary: "The React Native app built with Expo: habit lists, budget envelopes, and the offline queue."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-01-12
recorded_at: 2025-01-12T09:00:00Z
updated_at: 2025-01-12T09:00:00Z
version: 1
author: ivo
aliases: [app, Expo app, client]
tags: [mobile]
paths: [app/]
part_of: ["[[Tidewater]]"]
sources:
  - "file:app/App.tsx@6a1c2de 2025-01-12"
---

React Native on [[Expo]]. Screens live in app/screens/, including the [[Budget Screen]].
Local data sits in [[On-device SQLite]]. Network calls go through the [[Sync Engine]].
[[Ivo Petrov]] owns it. Releases follow the two week train in [[Ship mobile releases every two weeks]].
