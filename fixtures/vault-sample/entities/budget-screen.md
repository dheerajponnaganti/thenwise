---
id: ent_01M5J9Y4KP99FHB32VN7XA0M5Z
type: entity
title: Budget Screen
summary: "Screen that shows monthly budget envelopes, running totals, and the add-expense sheet."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-14
recorded_at: 2025-02-14T09:00:00Z
updated_at: 2025-02-14T09:00:00Z
version: 1
author: ivo
aliases: [budget view, Budget.tsx, envelopes screen]
tags: [mobile, budgets]
paths: [app/screens/Budget.tsx]
part_of: ["[[Mobile App]]"]
sources:
  - "file:app/screens/Budget.tsx@1d9c4aa 2025-02-14"
---

Shows one card per envelope with spent and remaining amounts, plus a month switcher.
All amounts are integer cents and are formatted with Intl.NumberFormat, see [[Store money as integer cents]].
Edits are queued by the [[Sync Engine]] and confirmed by the server, see [[Use server-authoritative sync for budgets]].
Bank CSV import starts from the overflow menu: [[Support bank CSV import before bank APIs]].
