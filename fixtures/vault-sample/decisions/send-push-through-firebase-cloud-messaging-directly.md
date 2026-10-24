---
id: dec_01M5J9Y4K36GXCVHSEJF7M5SJ9
type: decision
title: Send push through Firebase Cloud Messaging directly
summary: "The server calls Firebase Cloud Messaging for Android and its APNs bridge for iOS to deliver notifications."
status: superseded
confidence: human
origin: local
scope: project
valid_from: 2025-06-01
valid_to: 2026-07-14
recorded_at: 2025-06-01T09:00:00Z
updated_at: 2026-07-14T09:00:00Z
version: 2
author: sam
aliases: [FCM, direct FCM]
tags: [push]
about: ["[[Sync Server]]"]
supersedes: []
depends_on: []
sources:
  - "human:sam 2025-06-01"
---

server/push/ talks to FCM directly, with an APNs key for iOS. Replaced by [[Send push through Beacon Push]] on 2026-07-14.
## Reason
FCM is free and covers both platforms. We needed silent pushes for the sync wake-up work.
## Alternatives considered
- The Expo push service: tokens go stale after reinstall, see [[Expo push tokens expire after reinstall]].
- A hosted notification vendor: extra cost at the time.
