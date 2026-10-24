---
id: fnd_01M5J9Y4M9RYN14KT6TM78NDMX
type: finding
title: Docusaurus build takes over four minutes at 300 pages
summary: "A clean CI build of the Docusaurus site took 4 min 20 s at 300 pages on a 2 vCPU runner."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-03-25
recorded_at: 2026-03-25T09:00:00Z
updated_at: 2026-03-25T09:00:00Z
version: 1
author: ruth
about: ["[[Docs Site]]"]
sources:
  - "file:docs/package.json@7be3c20 2026-03-25"
---

With a warm cache it still took 2 min 50 s.
Most time went to webpack bundling.
Measured on the old docs setup from [[Build the docs site with Docusaurus]].
