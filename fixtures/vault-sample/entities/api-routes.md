---
id: ent_01M5J9Y4KM49TEH0P3VQK9M2G8
type: entity
title: API Routes
summary: "The REST endpoints of the sync server: /v1/sync/push, /v1/sync/pull and /v1/auth/refresh."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-03-01
recorded_at: 2025-03-01T09:00:00Z
updated_at: 2025-03-01T09:00:00Z
version: 1
author: sam
aliases: [routes.ts, REST endpoints, sync endpoints]
tags: [server]
paths: [server/api/routes.ts]
part_of: ["[[Sync Server]]"]
sources:
  - "file:server/api/routes.ts@e44a1d7 2026-04-02"
---

Defined in server/api/routes.ts. Three endpoints: POST /v1/sync/push, GET /v1/sync/pull and POST /v1/auth/refresh.
Payloads are validated with the shared schemas from [[Validate API payloads with Zod]].
Push handlers take a per-user lock, see [[Postgres advisory locks serialize sync per user]].
Money fields end in _cents, see [[Store money as integer cents]].
