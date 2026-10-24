---
id: dec_01M5J9Y4KC7FK871BG7YTSFWC9
type: decision
title: Validate API payloads with Zod
summary: "Request and response bodies are checked with Zod schemas shared by client and server."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-04-15
recorded_at: 2025-04-15T09:00:00Z
updated_at: 2025-04-15T09:00:00Z
version: 1
author: sam
aliases: [Zod, payload validation]
tags: [server]
about: ["[[API Routes]]"]
supersedes: []
depends_on: []
sources:
  - "file:server/api/routes.ts@e44a1d7 2025-04-15"
---

Schemas live in packages/schemas and are imported by [[API Routes]] and by the [[Sync Engine]].
## Reason
One schema gives runtime checks and TypeScript types, which supports [[TypeScript strict mode and no any]]. Contract drift between app and server dropped to zero in our integration tests.
## Alternatives considered
- Joi: no inferred types.
- Hand-written checks: 400 lines already for the push endpoint.
