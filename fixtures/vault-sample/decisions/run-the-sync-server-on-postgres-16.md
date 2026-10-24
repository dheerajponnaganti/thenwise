---
id: dec_01M5J9Y4K14T92WHC1MM20ED82
type: decision
title: Run the sync server on Postgres 16
summary: "The sync server uses PostgreSQL 16 on a managed host."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-03-20
recorded_at: 2025-03-20T09:00:00Z
updated_at: 2025-03-20T09:00:00Z
version: 1
author: sam
aliases: [pg16, postgres version]
tags: [database, server]
about: ["[[Postgres]]", "[[Sync Server]]"]
supersedes: []
depends_on: []
sources:
  - "file:server/db/pool.ts@90ab1fe 2025-03-20"
---

Chosen over MySQL and SQLite on the server.
## Reason
Strong JSONB and advisory lock support, logical decoding for a later change feed, and Sam already runs it in production. Version 16 was the newest with a minimum 5 years of support.
## Alternatives considered
- MySQL 8: no advisory locks of the same quality.
- SQLite on the server: single writer limit.
