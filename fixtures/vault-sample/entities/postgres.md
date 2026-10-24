---
id: ent_01M5J9Y4M0CBK91RKYS6ZXQW46
type: entity
title: Postgres
summary: "PostgreSQL 16, the canonical data store of the sync server."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-03-20
recorded_at: 2025-03-20T09:00:00Z
updated_at: 2025-03-20T09:00:00Z
version: 1
author: sam
aliases: [pg, database server]
tags: [external, database]
paths: [server/db/]
sources:
  - "file:server/db/pool.ts@90ab1fe 2025-03-20"
---

Holds users, devices, budget rows, habit check-ins and the change log used for pull cursors.
Version choice: [[Run the sync server on Postgres 16]]. Schema code is under server/db/.
Schema is changed only through [[Database Migrations]]. Per-user ordering uses advisory locks, see [[Postgres advisory locks serialize sync per user]].
