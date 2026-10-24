---
id: fnd_01M5J9Y4MCFAD3NNHFH6REN0WM
type: finding
title: Float rounding drifts budget totals
summary: "Summing 3,000 entries stored as floating point drifted by 0.07 from the exact total."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-28
recorded_at: 2025-02-28T09:00:00Z
updated_at: 2025-02-28T09:00:00Z
version: 1
author: lena
about: ["[[Budget Screen]]"]
sources:
  - "file:app/screens/Budget.tsx@1d9c4aa 2025-02-28"
---

Reproduced in the [[Budget Screen]] with entries like 0.10 and 19.99.
A user could see a total one cent off.
This is why [[Store money as integer cents]] exists.
