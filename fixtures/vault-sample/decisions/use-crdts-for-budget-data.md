---
id: dec_01M5J9Y4K9QSJP5MZN0999G6PB
type: decision
title: Use CRDTs for budget data
summary: "Budget edits synced as CRDT operations so devices could edit offline and merge without server arbitration."
status: superseded
confidence: human
origin: local
scope: project
valid_from: 2025-02-10
valid_to: 2026-03-10
recorded_at: 2025-02-10T09:00:00Z
updated_at: 2026-03-10T09:00:00Z
version: 2
author: lena
aliases: [CRDT budgets, merge budgets on device]
tags: [sync, budgets]
about: ["[[Sync Engine]]", "[[CRDT]]"]
supersedes: []
depends_on: []
sources:
  - "human:lena 2025-02-10"
  - "url:https://automerge.example.org/docs/ 2025-02-08"
---

Budgets are merged on device with a [[CRDT]] library (Automerge) inside the [[Sync Engine]]. Replaced by [[Use server-authoritative sync for budgets]] on 2026-03-10.
## Reason
Budgets must stay editable offline. A CRDT merge needs no server round trip, so two phones converge on the same envelope values. A prototype converged on 40 random edit traces.
## Alternatives considered
- Server-authoritative sync: needed a round trip per edit, rejected at the time because of offline use.
- Last-write-wins on budget rows: silently loses money edits.
