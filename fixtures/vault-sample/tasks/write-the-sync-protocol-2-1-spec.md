---
id: tsk_01M5J9Y4N24CT9PFC8F32TE62Z
type: task
title: Write the sync protocol 2.1 spec
summary: "Document headers, endpoints, error codes and the cursor semantics of protocol 2.1."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-09-20
recorded_at: 2026-09-20T09:00:00Z
updated_at: 2026-09-20T09:00:00Z
version: 1
author: sam
done: false
due: 2026-11-05
about: ["[[Sync Server]]", "[[Sync Engine]]"]
sources:
  - "human:sam 2026-09-20"
---

Spec goes in docs/reference/sync-protocol.md. Must cover the 426 behaviour from [[Version the sync protocol with semantic versions]] and the cursor from [[Track sync progress with a per-device cursor]].
Reviewer is [[Lena Ortiz]].
Also list the three endpoints from [[API Routes]].
