# Layer 1 on action questions (max 2)

{
  "questions": 20,
  "max": 2,
  "recallAtMax": 1,
  "wrongInjection": 0,
  "sentPerQuestion": 1.9,
  "mustNotRate": 0,
  "p95Ms": 0.4772920000000056
}

| q | path | shown | gold hit |
| --- | --- | --- | --- |
| q081 | src/sync/conflict.ts | decisions/keep-last-write-wins-for-habit-check-ins.md<br>entities/conflict-resolver.md | 2/4 |
| q082 | src/sync/engine.ts | decisions/use-server-authoritative-sync-for-budgets.md<br>decisions/wake-sync-from-push-with-a-15-minute-fallback-poll.md | 1/3 |
| q083 | src/sync/queue.ts | decisions/cap-the-offline-queue-at-5000-operations.md<br>entities/offline-mode.md | 2/2 |
| q084 | app/screens/Budget.tsx | decisions/store-money-as-integer-cents.md<br>entities/budget-screen.md | 2/2 |
| q085 | server/api/routes.ts | decisions/validate-api-payloads-with-zod.md<br>decisions/version-the-sync-protocol-with-semantic-versions.md | 2/4 |
| q086 | server/db/migrations/ | entities/database-migrations.md<br>decisions/write-migrations-as-forward-only-sql-files.md | 2/2 |
| q087 | server/push/ | entities/beacon-push.md<br>decisions/send-push-through-beacon-push.md | 2/2 |
| q088 | src/db/ | entities/on-device-sqlite.md<br>decisions/skip-database-encryption-in-version-1.md | 1/2 |
| q089 | app.json | entities/expo.md<br>findings/cold-start-is-2-9-seconds-on-mid-range-android.md | 1/2 |
| q090 | docs/ | entities/docs-site.md<br>rules/every-docs-page-needs-a-runnable-example.md | 1/2 |
| q091 | blog/ | entities/blog.md<br>rules/ruth-reviews-blog-posts-before-publishing.md | 2/2 |
| q092 | app/ | entities/mobile-app.md<br>rules/no-releases-on-fridays.md | 2/3 |
| q093 | server/ | entities/sync-server.md<br>decisions/send-push-through-beacon-push.md | 1/2 |
| q094 | server/db/ | entities/postgres.md<br>decisions/track-sync-progress-with-a-per-device-cursor.md | 1/2 |
| q095 | src/sync/ | entities/sync-engine.md<br>rules/every-sync-change-needs-a-conflict-test.md | 1/3 |
| q096 | bench/sqlite-insert.ts | findings/sqlite-write-throughput-depends-on-transactions.md | 1/1 |
| q097 | bench/yjs-merge.ts | findings/yjs-merges-stay-under-50-ms-on-low-end-phones.md | 1/1 |
| q098 | bench/push-compare.csv | decisions/send-push-through-beacon-push.md<br>findings/beacon-push-delivers-more-android-pushes-than-fcm.md | 1/1 |
| q099 | docs/guide/ | entities/docs-site.md<br>rules/every-docs-page-needs-a-runnable-example.md | 2/2 |
| q100 | server/db/migrations/0015_add_cursor.sql | decisions/track-sync-progress-with-a-per-device-cursor.md<br>entities/database-migrations.md | 1/2 |
