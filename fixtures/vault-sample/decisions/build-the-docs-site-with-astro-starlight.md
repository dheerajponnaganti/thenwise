---
id: dec_01M5J9Y4JRPZY18GBFCTYTWXEG
type: decision
title: Build the docs site with Astro Starlight
summary: "The docs site is built with Astro Starlight; CI builds finish in under a minute."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-04-08
recorded_at: 2026-04-08T09:00:00Z
updated_at: 2026-04-08T09:00:00Z
version: 1
author: ruth
aliases: [starlight, docs generator]
tags: [docs]
about: ["[[Docs Site]]", "[[Ruth Halvorsen]]"]
supersedes: ["[[Build the docs site with Docusaurus]]"]
depends_on: ["[[Starlight builds 300 pages in 38 seconds]]", "[[Docusaurus build takes over four minutes at 300 pages]]"]
sources:
  - "commit:2f8a9d3 2026-04-05"
  - "human:ruth 2026-04-08"
---

What changed: docs/ moved from Docusaurus to Starlight. This supersedes [[Build the docs site with Docusaurus]]. Migration took 6 days and old URLs keep working through redirects.
## Reason
The build fell from 4 min 20 s to 38 s at 300 pages ([[Docusaurus build takes over four minutes at 300 pages]], [[Starlight builds 300 pages in 38 seconds]]). [[Ruth Halvorsen]] edits plain Markdown with no React wrapper.
## Alternatives considered
- Tune Docusaurus caching: only reached 2 min 50 s.
- VitePress: fewer accessibility defaults.
