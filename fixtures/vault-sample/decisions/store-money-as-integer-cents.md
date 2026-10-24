---
id: dec_01M5J9Y4K64RECRTQ6FQ1P5E10
type: decision
title: Store money as integer cents
summary: "All amounts are stored and sent as integers in the smallest currency unit, with a separate currency code."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-03-02
recorded_at: 2025-03-02T09:00:00Z
updated_at: 2025-03-02T09:00:00Z
version: 1
author: lena
aliases: [cents, money as integers]
tags: [budgets, data]
about: ["[[Budget Screen]]", "[[API Routes]]"]
supersedes: []
depends_on: ["[[Float rounding drifts budget totals]]"]
sources:
  - "file:app/screens/Budget.tsx@1d9c4aa 2025-02-28"
  - "human:lena 2025-03-02"
---

API fields end in _cents. Currency is a separate 3 letter column. The [[Budget Screen]] formats with Intl.NumberFormat and [[API Routes]] reject non-integer amounts.
## Reason
Floating point drifted by 0.07 after 3,000 entries ([[Float rounding drifts budget totals]]). Integers make totals exact and cheap to sum in SQL.
## Alternatives considered
- Decimal strings: exact but slow to sum and awkward to validate.
- A decimal library such as big.js: adds a dependency to every screen.
