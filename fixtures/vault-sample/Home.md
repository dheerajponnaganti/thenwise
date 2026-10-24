---
id: not_01M5J9Y4JPES6EP405VT5F6NXE
tags: [hub]
---

# Tidewater vault

Start here. The project is described in [[Tidewater]]. Current plans: [[Roadmap 2026 Q4]] and [[Release 1.8 checklist]].
All decisions are listed in [[Decision Index]].

## People and parts
- [[Tidewater]]
- [[Mobile App]]
- [[Budget Screen]]
- [[Sync Engine]]
- [[Conflict Resolver]]
- [[Offline Mode]]
- [[On-device SQLite]]
- [[Sync Server]]
- [[API Routes]]
- [[Database Migrations]]
- [[Beacon Push]]
- [[Postgres]]
- [[Expo]]
- [[Docs Site]]
- [[Blog]]
- [[Lena Ortiz]]
- [[Sam Achebe]]
- [[Ivo Petrov]]
- [[Ruth Halvorsen]]
- [[CRDT]]
- [[Conflict Resolution]]

## Rules
- [[No em dashes in docs or UI copy]]
- [[TypeScript strict mode and no any]]
- [[Every sync change needs a conflict test]]
- [[No releases on Fridays]]
- [[Every docs page needs a runnable example]]
- [[Ruth reviews blog posts before publishing]]

## Tasks
- [[Move leftover AsyncStorage keys to SQLite]]
- [[Write the sync protocol 2.1 spec]]
- [[Add weekly budget summary push topic]]
- [[Fix Budget screen scroll jank on Android]]
- [[Publish the sync explainer blog post]]
- [[Rotate the JWT signing key]]
- [[Build conflict test fixtures]]
- [[Benchmark SQLite vacuum on low-end phones]]

## Findings
- [[CRDT merge cost on low-end phones]]
- [[Yjs merges stay under 50 ms on low-end phones]]
- [[Expo push tokens expire after reinstall]]
- [[Beacon Push delivers more Android pushes than FCM]]
- [[Beacon Push free tier covers 10,000 devices]]
- [[Beacon Push free tier shrank to 5,000 devices]]
- [[SQLite write throughput depends on transactions]]
- [[AsyncStorage slows past 6 MB on Android]]
- [[Postgres advisory locks serialize sync per user]]
- [[Median offline queue is 14 operations]]
- [[Docusaurus build takes over four minutes at 300 pages]]
- [[Starlight builds 300 pages in 38 seconds]]
- [[Concurrent budget edits are rare]]
- [[Float rounding drifts budget totals]]
- [[Cold start is 2.9 seconds on mid-range Android]]
- [[Expo SDK 54 needs the new build config]]

## Meetings
- [[Onboarding call with Ivo 2025-02-03]]
- [[Weekly sync 2026-01-26]]
- [[Budget sync - server decides]]
- [[Moving docs to Starlight]]
- [[Retro 2026-06-30]]
- [[Release review 2026-09-18]]
- [[Roadmap kickoff 2026-01-06]]

## Drafts
- [[Draft - How Tidewater syncs]]
- [[Draft - Offline mode guide]]
- [[Draft - Release notes 1.8]]
- [[Draft - Contributing guide]]
- [[Draft - Roadmap 2027 thoughts]]
- [[Draft - Budget import walkthrough]]

Loose ends: [[Ideas parking lot]], [[Reading list]], [[Glossary scratch]].
