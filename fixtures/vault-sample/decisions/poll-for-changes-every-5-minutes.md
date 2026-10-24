---
id: dec_01M5J9Y4K016H32E03PFWX2HFX
type: decision
title: Poll for changes every 5 minutes
summary: "The app polls the server every 5 minutes while idle to pick up changes from other devices."
status: superseded
confidence: human
origin: local
scope: project
valid_from: 2025-04-01
valid_to: 2026-05-20
recorded_at: 2025-04-01T09:00:00Z
updated_at: 2026-05-20T09:00:00Z
version: 2
author: sam
aliases: [five minute poll, polling interval]
tags: [sync, battery]
about: ["[[Sync Engine]]"]
supersedes: []
depends_on: []
sources:
  - "human:sam 2025-04-01"
---

The [[Sync Engine]] polls /v1/sync/pull on a 5 minute timer. Replaced by [[Wake sync from push with a 15 minute fallback poll]] on 2026-05-20.
## Reason
No push infrastructure existed in early 2025. Five minutes cost about 2% battery per day in our test and kept data reasonably fresh.
## Alternatives considered
- Polling every minute: 7% battery per day on a Pixel 6a.
- Websockets: rejected because mobile OSes kill idle sockets and battery use was worse.
