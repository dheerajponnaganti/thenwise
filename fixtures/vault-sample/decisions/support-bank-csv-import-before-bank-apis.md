---
id: dec_01M5J9Y4K7DV76E6FB2CNPKKTG
type: decision
title: Support bank CSV import before bank APIs
summary: "Users import transactions from bank CSV files; direct bank connections are postponed."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-10-14
recorded_at: 2025-10-14T09:00:00Z
updated_at: 2025-10-14T09:00:00Z
version: 1
author: lena
aliases: [CSV import, bank import]
tags: [budgets]
about: ["[[Budget Screen]]", "[[Tidewater]]"]
supersedes: []
depends_on: []
sources:
  - "human:lena 2025-10-14"
---

CSV import supports 3 file layouts that cover 11 banks. It is reached from the [[Budget Screen]] overflow menu.
## Reason
Bank aggregators charge about $0.30 per linked account per month and need a legal review. CSV needs neither and ships in one sprint.
## Alternatives considered
- A bank aggregator API: cost and compliance.
- Manual entry only: too slow for budget users.
