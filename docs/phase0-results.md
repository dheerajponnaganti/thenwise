# Phase 0 results (2026-10-22)

Machine: Apple Silicon Mac, Node 26.0.0. Raw data: `bench/out/phase0.json`, `bench/out/perf-2000.json`, `bench/out/perf-10000.json`.

## Gate: passed

| Gate item | Target | Result | Pass |
| --- | --- | --- | --- |
| Checker on the public fixture | no errors | 0 errors, 0 warnings, 0 info (after ids were assigned) | yes |
| N7 full rebuild, 2,000 notes, cold | at most 3 s | 0.36 s | yes |
| N8 incremental update of one note (p95), 2,000 notes | at most 20 ms | 8.9 ms | yes |
| B2 and B3 recorded | recorded | below | yes |

## Speed

| Notes | Cold build | Warm start (cache) | Update one note p50 / p95 | Query p50 / p95 | Checker |
| --- | --- | --- | --- | --- | --- |
| 2,000 (11,343 edges, 102 hubs) | 361 ms | 123 ms | 7.4 / 8.9 ms | 1.2 / 1.4 ms | 378 ms |
| 10,000 (57,916 edges, 537 hubs) | 1,696 ms | 632 ms | 51.6 / 59.3 ms | 7.0 / 9.6 ms | 2,027 ms |

**Known limit:** at 10,000 notes a one-note update takes 59 ms, over the 20 ms target. Cause: every change recomputes link resolution, hubs and supersede heads for the whole vault. Fix before Files mode claims the 10,000-note ceiling: keep the title and alias maps between updates and re-resolve only links that name the changed note.

## Retrieval (public fixture: 100 notes, 120 questions)

Top 5 results per question. B2 is a grep proxy (files ranked by how many distinct query terms they contain), B3 is our lexical retrieval with the status rules.

| | R@1 | R@3 | R@5 | MRR | Must-not hit | Tokens to answer (mean) |
| --- | --- | --- | --- | --- | --- | --- |
| B2 grep proxy | 0.28 | 0.69 | 0.80 | 0.49 | 0.51 | 1,148 |
| B3 lexical | **0.47** | 0.71 | 0.78 | **0.59** | **0.24** | **785** |

By kind (B3): lookup R@1 0.60, why 0.60, multi-hop 0.15 (R@3 0.65), temporal now R@1 0.50, temporal past R@1 0.10, action R@3 1.00.

What this says:
- B3 puts the right note first far more often (0.47 against 0.28) and needs about 32% fewer tokens to reach it. At R@5 the two are equal: grep finds the note, it ranks it worse.
- **Multi-hop is the weak spot** (R@1 0.15). Expected: the question shares few words with the answering note. This is what Phase 4's graph expansion must fix, or be dropped.
- **Temporal past questions fail by design** (R@1 0.10): Phase 0 always redirects superseded notes to the newest version; as-of retrieval is not built yet.
- **Contradicted findings leak** (2 of 10 "now" questions): an old finding that a newer finding contradicts is still `active`, so it is returned. Only `supersedes` is handled today. Phase 3 must rank or flag the older side of a `contradicts` pair.
- **Silence does not work with a raw score threshold.** At τ = 20, silence on unanswerable questions reaches 0.65 but R@3 falls to 0.49. Negatives share vocabulary with the vault (by design), so BM25 scores stay high. Phase 3 needs a better confidence signal (for example the share of query terms matched, or the gap between the first and fifth score).
- **Pointer blocks are over budget:** 5 pointers average 243 tokens against the 200-token target (N3). Shorten summaries in pointers or send 4.

## Caveats

- Retrieval only; no model was called. "Tokens to answer" is a proxy: pointer lines sent, plus reading notes in rank order until the first gold note.
- B2 is a floor for "index note plus Grep": a real agent also reads the index note and picks files with judgment. The end-to-end comparison (Phase 3) uses a real agent.
- The fixture was written by a model (Claude Sonnet), then checked by our checker and by hand on a sample of 12 questions. Results on real vaults may differ; the private set checks this.
- 120 questions is small: one question moves a per-kind number by 0.05.
