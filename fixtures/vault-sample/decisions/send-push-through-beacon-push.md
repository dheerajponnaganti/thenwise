---
id: dec_01M5J9Y4K20A69RDH7V7K4NQP0
type: decision
title: Send push through Beacon Push
summary: "Notifications go through the Beacon Push HTTP API instead of calling FCM and APNs ourselves."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-07-14
recorded_at: 2026-07-14T09:00:00Z
updated_at: 2026-07-14T09:00:00Z
version: 1
author: sam
aliases: [beacon, push provider choice]
tags: [push]
about: ["[[Beacon Push]]", "[[Sync Server]]"]
supersedes: ["[[Send push through Firebase Cloud Messaging directly]]"]
depends_on: ["[[Beacon Push delivers more Android pushes than FCM]]", "[[Beacon Push free tier covers 10,000 devices]]"]
sources:
  - "file:bench/push-compare.csv@5d20f3a 2026-06-20"
  - "human:sam 2026-07-14"
---

What changed: server/push/ now calls [[Beacon Push]]. This supersedes [[Send push through Firebase Cloud Messaging directly]].
## Reason
Delivery was 97.8% against 94.1% for FCM on Android in a 3 week test ([[Beacon Push delivers more Android pushes than FCM]]). One API covers both platforms and we stop rotating the APNs key every year. The free tier was 10,000 devices at the time ([[Beacon Push free tier covers 10,000 devices]]).
## Alternatives considered
- Stay on FCM: free but lower delivery.
- Another hosted vendor: higher price per device.
