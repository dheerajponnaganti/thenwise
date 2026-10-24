---
id: ent_01M5J9Y4KRRKFEM46APS7NV2FX
type: entity
title: CRDT
summary: "Conflict-free replicated data type: a data structure whose copies merge without coordination."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-08
recorded_at: 2025-02-08T09:00:00Z
updated_at: 2025-02-08T09:00:00Z
version: 1
author: lena
aliases: [CRDTs, conflict-free replicated data type]
tags: [concept, sync]
sources:
  - "url:https://crdt.example.org/intro 2025-02-08"
---

We tried CRDTs (Automerge, then Yjs) for budget data between February 2025 and March 2026.
Costs seen: [[CRDT merge cost on low-end phones]] and the counter view in [[Yjs merges stay under 50 ms on low-end phones]].
The approach was dropped for budgets in [[Use server-authoritative sync for budgets]]. See also [[Conflict Resolution]].
