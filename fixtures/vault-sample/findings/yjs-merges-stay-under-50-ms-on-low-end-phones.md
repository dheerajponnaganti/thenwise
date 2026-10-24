---
id: fnd_01M5J9Y4MGTZHYSWKBKKPC0YE0
type: finding
title: Yjs merges stay under 50 ms on low-end phones
summary: "Yjs merged the same 20,000 operation trace in 46 ms and 22 MB on a Moto G Power."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-02-18
recorded_at: 2026-02-18T09:00:00Z
updated_at: 2026-02-18T09:00:00Z
version: 1
author: ivo
about: ["[[CRDT]]"]
contradicts: ["[[CRDT merge cost on low-end phones]]"]
sources:
  - "file:bench/yjs-merge.ts@9c1d7e2 2026-02-17"
---

The same trace that took Automerge 380 ms ([[CRDT merge cost on low-end phones]]) ran in 46 ms in Yjs, peak 22 MB.
So the 380 ms figure is specific to Automerge, not to CRDTs as a whole.
Yjs still cannot enforce server rules like envelope totals, which is why [[Use server-authoritative sync for budgets]] still stood.
