---
id: ent_01M5J9Y4M36YSYSX3TCKVKH0PW
type: entity
title: Sync Server
summary: "Node 22 service with a Postgres database that stores canonical data and serves the sync API."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-01-22
recorded_at: 2025-01-22T09:00:00Z
updated_at: 2025-01-22T09:00:00Z
version: 1
author: sam
aliases: [backend, server]
tags: [server]
paths: [server/]
part_of: ["[[Tidewater]]"]
sources:
  - "file:server/index.ts@aa310c4 2025-01-22"
---

Code is in server/. Routes are in [[API Routes]], schema changes in [[Database Migrations]], notifications in server/push/ via [[Beacon Push]].
Data is in [[Postgres]]. Auth uses [[Use short-lived JWT access tokens]].
Protocol versions are tracked as described in [[Version the sync protocol with semantic versions]].
[[Sam Achebe]] owns it.
