---
id: ent_01M5J9Y4KMEYTJ899M2N2WSNSW
type: entity
title: Beacon Push
summary: "Hosted push notification service used by the sync server to wake phones and send summaries."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-07-14
recorded_at: 2026-07-14T09:00:00Z
updated_at: 2026-07-14T09:00:00Z
version: 1
author: sam
aliases: [push provider, notifications service]
tags: [external, push]
paths: [server/push/]
part_of: ["[[Sync Server]]"]
sources:
  - "url:https://beacon.example.com/docs 2026-07-14"
---

Called from server/push/ over its HTTP API. One API covers iOS and Android.
We moved to it in [[Send push through Beacon Push]]. Delivery data: [[Beacon Push delivers more Android pushes than FCM]].
Pricing limits changed in 2026, see [[Beacon Push free tier shrank to 5,000 devices]].
Planned use: [[Add weekly budget summary push topic]].
