---
id: fnd_01M5J9Y4MC8XTV41TSDQZ8THVT
type: finding
title: Median offline queue is 14 operations
summary: "Telemetry shows a median of 14 queued operations and a p99 of 310 when a device reconnects."
status: active
confidence: human
origin: local
scope: project
valid_from: 2026-05-15
recorded_at: 2026-05-15T09:00:00Z
updated_at: 2026-05-15T09:00:00Z
version: 1
author: sam
about: ["[[Offline Mode]]"]
sources:
  - "human:sam 2026-05-15"
---

Measured over 30 days of sync logs, 3,800 devices.
The longest queue was 1,940 operations after a 9 day trip.
Used to size [[Cap the offline queue at 5000 operations]].
