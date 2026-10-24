---
id: rul_01M5J9Y4MVB5VBDSPW05HEGMAF
type: rule
title: No em dashes in docs or UI copy
summary: "Never write em dashes or en dashes in docs, blog posts or UI strings; use commas, colons or periods."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-02-01
recorded_at: 2025-02-01T09:00:00Z
updated_at: 2025-02-01T09:00:00Z
version: 1
author: ruth
aliases: [no dashes, dash rule]
tags: [writing]
about: ["[[Docs Site]]", "[[Blog]]"]
sources:
  - "human:ruth 2025-02-01"
---

The docs:lint script fails the build on U+2014 and U+2013 in docs/ and blog/.
UI strings are checked in the app lint step.
Applies to the [[Docs Site]], the [[Blog]] and all strings in the [[Mobile App]].
