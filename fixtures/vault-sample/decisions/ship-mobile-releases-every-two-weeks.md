---
id: dec_01M5J9Y4K4BTYSP5ENAVQBS708
type: decision
title: Ship mobile releases every two weeks
summary: "The mobile app ships on a fixed two week train, with a hotfix path for urgent bugs."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-09-01
recorded_at: 2025-09-01T09:00:00Z
updated_at: 2025-09-01T09:00:00Z
version: 1
author: ivo
aliases: [release train, biweekly releases]
tags: [release]
about: ["[[Mobile App]]", "[[Ivo Petrov]]"]
supersedes: []
depends_on: []
sources:
  - "human:ivo 2025-09-01"
---

Train leaves every second Tuesday. Hotfixes need approval from [[Lena Ortiz]] and follow [[No releases on Fridays]].
## Reason
Store review takes 1 to 2 days, so two weeks leaves room for QA and one fix cycle. [[Ivo Petrov]] can plan around a fixed date.
## Alternatives considered
- Monthly releases: too long between fixes.
- Over-the-air updates only: not allowed for native changes.
