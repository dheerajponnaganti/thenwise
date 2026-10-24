---
id: dec_01M5J9Y4KFDE9SG3K6WD5R3XC6
type: decision
title: Write migrations as forward-only SQL files
summary: "Schema changes are plain SQL files that only move forward; fixes ship as new migrations."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-05-10
recorded_at: 2025-05-10T09:00:00Z
updated_at: 2025-05-10T09:00:00Z
version: 1
author: sam
aliases: [forward-only migrations, no down migrations]
tags: [database]
about: ["[[Database Migrations]]", "[[Postgres]]"]
supersedes: []
depends_on: []
sources:
  - "human:sam 2025-05-10"
---

Files go in server/db/migrations/ and run in order on deploy. There are no down scripts.
## Reason
Down scripts were never run in production and drifted from the up scripts. A forward fix is reviewed like any other change.
## Alternatives considered
- Knex-style up and down pairs: double the review burden.
- An ORM schema push: hides the SQL we want to review.
