---
id: dec_01M5J9Y4MHW5096ME2E3Z20943
type: decision
title: Compress sync payloads with gzip
summary: "Proposal: gzip push and pull bodies, shrinking an average 200 operation batch from 84 KB to 11 KB."
status: inbox
confidence: agent
origin: local
scope: project
valid_from: 2026-10-19
recorded_at: 2026-10-19T09:00:00Z
updated_at: 2026-10-19T09:00:00Z
version: 1
author: claude-code:session-4e1a
tags: [sync]
about: ["[[API Routes]]", "[[Sync Engine]]"]
supersedes: []
depends_on: []
sources:
  - "file:src/sync/engine.ts@3f2a1bc 2026-10-19"
---

Measured on 50 recorded batches in src/sync/engine.ts test runs. Needs a decision from [[Sam Achebe]].
## Reason
Mobile data is metered for many users.
## Alternatives considered
- Brotli: better ratio, more CPU on low-end phones.
