---
id: dec_01M5J9Y4KD2Y9JYHN4M4MKTBXJ
type: decision
title: Version the sync protocol with semantic versions
summary: "The sync protocol has a major.minor version sent in the X-Tidewater-Protocol header; a major bump makes the server reject old clients with HTTP 426."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-04-20
recorded_at: 2026-04-20T09:00:00Z
updated_at: 2026-04-20T09:00:00Z
version: 1
author: sam
aliases: [protocol versioning, protocol header]
tags: [server, sync]
about: ["[[Sync Server]]", "[[API Routes]]"]
supersedes: []
depends_on: []
sources:
  - "file:server/api/routes.ts@e44a1d7 2026-04-20"
---

Current version is 2.1. Minor bumps add optional fields; major bumps change meaning.
## Reason
Slow app updates mean old clients stay online for weeks. A clear header lets [[API Routes]] answer 426 Upgrade Required instead of corrupting data. Spec task: [[Write the sync protocol 2.1 spec]].
## Alternatives considered
- Date-based versions: do not say whether a change breaks clients.
- A URL prefix only: forces duplicate route trees.
