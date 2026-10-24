---
id: ent_01M5J9Y4KS81EJ8DB1DR6141BG
type: entity
title: Database Migrations
summary: "Forward-only SQL files in server/db/migrations/, numbered 0001 to 0023 as of October 2026."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-05-10
recorded_at: 2025-05-10T09:00:00Z
updated_at: 2025-05-10T09:00:00Z
version: 1
author: sam
aliases: [migrations, schema changes]
tags: [server, database]
paths: [server/db/migrations/]
part_of: ["[[Sync Server]]"]
sources:
  - "file:server/db/migrations/0015_add_cursor.sql@b8d31ee 2026-03-12"
---

One file per change, named with a four digit counter and a short label, for example 0015_add_cursor.sql.
They run in order at deploy time against [[Postgres]].
Policy is in [[Write migrations as forward-only SQL files]]. There are no down scripts.
Part of the [[Sync Server]].
