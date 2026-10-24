---
id: dec_01M5J9Y4KCHD6V5TAJS1DBEEQX
type: decision
title: Use short-lived JWT access tokens
summary: "Access tokens are JWTs that expire after 15 minutes; refresh tokens last 30 days and live in the secure store."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-07-08
recorded_at: 2025-07-08T09:00:00Z
updated_at: 2025-07-08T09:00:00Z
version: 1
author: sam
aliases: [token lifetime, JWT lifetime]
tags: [server, security]
about: ["[[API Routes]]"]
supersedes: []
depends_on: []
sources:
  - "human:sam 2025-07-08"
---

/v1/auth/refresh issues new pairs. The signing key rotates yearly: [[Rotate the JWT signing key]].
## Reason
A stolen token is useful for at most 15 minutes. Refresh tokens stay in the platform secure store, not in [[On-device SQLite]].
## Alternatives considered
- 24 hour tokens: long exposure.
- Server session cookies: awkward on React Native.
