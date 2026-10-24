---
id: dec_01M5J9Y4KBS031GQ6R059GSSN7
type: decision
title: Use server-authoritative sync for budgets
summary: "The server decides the final state of every budget entry; devices queue edits and accept the server's answer after sync."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-10
recorded_at: 2026-03-10T09:00:00Z
updated_at: 2026-03-10T09:00:00Z
version: 1
author: lena
aliases: [budget sync, money sync, server decides budgets]
tags: [sync, budgets]
about: ["[[Sync Engine]]", "[[Conflict Resolver]]"]
supersedes: ["[[Use CRDTs for budget data]]"]
depends_on: ["[[CRDT merge cost on low-end phones]]", "[[Concurrent budget edits are rare]]"]
sources:
  - "file:src/sync/engine.ts@3f2a1bc 2026-03-09"
  - "human:lena 2026-03-10"
---

What changed: budgets no longer merge as CRDTs. A device queues each edit as an operation ([[Offline Mode]]), sends it to [[API Routes]], and replaces its row with the canonical row the server returns. This supersedes [[Use CRDTs for budget data]].
## Reason
Automerge merges took 380 ms for 20,000 operations on a Moto G Power and history grew 6 times faster than the data. Yjs was fast but cannot enforce server rules such as envelope totals. Only 0.4% of syncs touched the same budget line on two devices, so offline merging bought little.
## Alternatives considered
- Keep CRDTs with history compaction: about 3 weeks of work, rejected.
- Last-write-wins per field: loses totals when two edits cross.
