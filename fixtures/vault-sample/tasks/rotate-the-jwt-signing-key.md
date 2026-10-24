---
id: tsk_01M5J9Y4N1F18Z0193FNR5HZ0Z
type: task
title: Rotate the JWT signing key
summary: "Replace the JWT signing key and keep the old one valid for 15 minutes during rollout."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-10-10
recorded_at: 2026-10-10T09:00:00Z
updated_at: 2026-10-10T09:00:00Z
version: 1
author: sam
done: false
due: 2026-11-30
about: ["[[API Routes]]"]
sources:
  - "human:sam 2026-10-10"
---

Keys rotate yearly under [[Use short-lived JWT access tokens]]. Add a key id header so [[API Routes]] can verify both keys.
Owner is [[Sam Achebe]].
Do not deploy on a Friday, see [[No releases on Fridays]].
