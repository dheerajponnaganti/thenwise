---
id: rul_01M5J9Y4MJ9AWQ2H0JDQ2CD9M9
type: rule
title: Name migrations with a four digit counter
summary: "Proposal: migration files must start with a four digit counter and an underscore, for example 0024_add_index.sql."
status: inbox
confidence: agent
origin: local
scope: project
valid_from: 2026-10-20
recorded_at: 2026-10-20T09:00:00Z
updated_at: 2026-10-20T09:00:00Z
version: 1
author: claude-code:session-4e1a
tags: [database]
about: ["[[Database Migrations]]"]
sources:
  - "file:server/db/migrations/0015_add_cursor.sql@b8d31ee 2026-10-20"
---

Two files were recently named with dates, which sorts differently.
The deploy runner sorts by name.
Fits [[Write migrations as forward-only SQL files]].
