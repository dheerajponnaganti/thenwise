---
id: fnd_01M5J9Y4MJYXYRYTD2NMB1VGZF
type: finding
title: Migrations 0014 and 0015 touch the same table
summary: "Both migrations alter device_cursors, so they could run as one statement and hold the lock once."
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

0014 adds the column and 0015 adds the index.
Running them separately takes two locks of about 400 ms each on a 2 million row table.
Relevant to [[Database Migrations]].
