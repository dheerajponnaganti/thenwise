---
id: fnd_01M5J9Y4M97NR81CQQ7N40RMGG
type: finding
title: CRDT merge cost on low-end phones
summary: "Automerge needed 380 ms and 90 MB to merge 20,000 operations on a Moto G Power."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-11-12
recorded_at: 2025-11-12T09:00:00Z
updated_at: 2025-11-12T09:00:00Z
version: 1
author: ivo
about: ["[[CRDT]]", "[[Sync Engine]]"]
sources:
  - "url:https://automerge.example.org/benchmarks 2025-10-30"
  - "human:ivo 2025-11-12"
---

Test on a Moto G Power (2021): merging a 20,000 operation budget history in Automerge took 380 ms and peaked at 90 MB. A Pixel 8 needed 41 ms.
Document history grew 6 times faster than the visible data.
Disputed later by [[Yjs merges stay under 50 ms on low-end phones]]. Fed into [[Use server-authoritative sync for budgets]].
