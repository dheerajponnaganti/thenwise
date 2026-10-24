---
id: dec_01M5J9Y4JTY1R0B2V8KNAPE8K9
type: decision
title: Cap the offline queue at 5000 operations
summary: "The local operation queue holds at most 5000 operations; when full, old check-ins coalesce and budget edits are blocked with a banner."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-05-28
recorded_at: 2026-05-28T09:00:00Z
updated_at: 2026-05-28T09:00:00Z
version: 1
author: ivo
aliases: [queue cap, queue limit]
tags: [sync, mobile]
about: ["[[Offline Mode]]"]
supersedes: []
depends_on: ["[[Median offline queue is 14 operations]]"]
sources:
  - "file:src/sync/queue.ts@2b9f4a8 2026-05-28"
---

Implemented in src/sync/queue.ts. At 5000 operations the queue uses about 2.4 MB.
## Reason
The 99th percentile queue was 310 operations, so 5000 is 16 times that ([[Median offline queue is 14 operations]]). An unbounded queue could grow SQLite without limit during long offline stretches.
## Alternatives considered
- Unlimited queue: risk of a very slow first sync.
- Cap at 1000: only 3 times the p99.
