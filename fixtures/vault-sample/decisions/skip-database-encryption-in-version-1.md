---
id: dec_01M5J9Y4K551V0D5Y3R5S79BRK
type: decision
title: Skip database encryption in version 1
summary: "The on-device database is not encrypted in version 1; we rely on OS-level encryption of locked devices."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-06-02
recorded_at: 2026-06-02T09:00:00Z
updated_at: 2026-06-02T09:00:00Z
version: 1
author: lena
aliases: [no sqlcipher, encryption at rest]
tags: [storage, security]
about: ["[[On-device SQLite]]"]
supersedes: []
depends_on: []
sources:
  - "human:lena 2026-06-02"
---

Revisit when users ask for it or when we add bank credentials.
## Reason
SQLCipher adds about 8 MB to the binary and needs a custom config plugin for [[Expo]] builds. iOS and Android already encrypt app storage while the device is locked.
## Alternatives considered
- SQLCipher now: size and build cost.
- Encrypting only budget rows: complicates queries in [[On-device SQLite]].
