---
id: dec_01M5J9Y4JVVME1JMRSFEWV7T05
type: decision
title: Check docs links in CI
summary: "Every pull request that touches docs/ runs a link checker that fails on dead links."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-05-02
recorded_at: 2026-05-02T09:00:00Z
updated_at: 2026-05-02T09:00:00Z
version: 1
author: ruth
aliases: [link checker, docs CI]
tags: [docs, ci]
about: ["[[Docs Site]]", "[[Ruth Halvorsen]]"]
supersedes: []
depends_on: []
sources:
  - "commit:c19d2f0 2026-05-02"
---

Runs lychee over the built Starlight output. A 429 response counts as a pass.
## Reason
The first run found 31 broken links, 9 of them in the getting started guide. Dead links cost [[Ruth Halvorsen]] reader trust.
## Alternatives considered
- A weekly scheduled check: found problems too late.
- Manual review: nobody did it consistently.
