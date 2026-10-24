# Benchmark phase0-sqlite

Date 2026-10-22T18:01:15.687Z. B3 backend: sqlite. Vault: 100 notes, 500 edges, 7 hubs. Questions used: 120 of 120.

| System | Kind | n | R@1 | R@3 | R@5 | MRR | wrong inj. | must-not | tokens to answer (mean) | sent (mean) | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B2_grep_proxy | all | 120 | 0.280 | 0.690 | 0.800 | 0.488 | 0.700 | 0.512 | 1148 | 0 | 0.30 |
| B2_grep_proxy | lookup | 20 | 0.200 | 0.600 | 0.750 | 0.408 | 0.800 | n/a | 1180 | 0 | 0.71 |
| B2_grep_proxy | why | 20 | 0.250 | 0.900 | 0.950 | 0.560 | 0.810 | 1.000 | 1159 | 0 | 0.27 |
| B2_grep_proxy | multi_hop | 20 | 0.250 | 0.600 | 0.750 | 0.432 | 0.680 | 0.143 | 1307 | 0 | 0.39 |
| B2_grep_proxy | temporal | 20 | 0.200 | 0.550 | 0.650 | 0.372 | 0.820 | 0.600 | 1363 | 0 | 0.39 |
| B2_grep_proxy | action | 20 | 0.500 | 0.800 | 0.900 | 0.667 | 0.390 | 0.333 | 732 | 0 | 0.28 |
| B2_grep_proxy | negative | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | n/a | 0 | 0 | 0.26 |
| B3_lexical | all | 120 | 0.450 | 0.730 | 0.810 | 0.598 | 0.688 | 0.195 | 788 | 236 | 0.60 |
| B3_lexical | lookup | 20 | 0.400 | 0.800 | 0.900 | 0.603 | 0.750 | n/a | 704 | 235 | 1.25 |
| B3_lexical | why | 20 | 0.600 | 0.800 | 0.900 | 0.725 | 0.755 | 0.000 | 713 | 247 | 0.65 |
| B3_lexical | multi_hop | 20 | 0.200 | 0.700 | 0.850 | 0.460 | 0.620 | 0.000 | 860 | 242 | 0.66 |
| B3_lexical | temporal | 20 | 0.300 | 0.400 | 0.450 | 0.360 | 0.847 | 0.400 | 1121 | 220 | 0.60 |
| B3_lexical | action | 20 | 0.750 | 0.950 | 0.950 | 0.842 | 0.470 | 0.000 | 543 | 241 | 0.64 |
| B3_lexical | negative | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | n/a | 0 | 233 | 0.54 |

## B3 threshold sweep (send nothing when the top score is below tau)

| tau | R@3 (answerable) | silence on negatives | wrong injection |
| --- | --- | --- | --- |
| 0 | 0.730 | 0.000 | 0.740 |
| 1 | 0.720 | 0.000 | 0.741 |
| 2 | 0.720 | 0.000 | 0.741 |
| 4 | 0.690 | 0.050 | 0.743 |
| 6 | 0.630 | 0.500 | 0.729 |
| 8 | 0.560 | 0.800 | 0.713 |
| 10 | 0.460 | 0.850 | 0.695 |
| 12 | 0.310 | 1.000 | 0.676 |
| 15 | 0.120 | 1.000 | 0.600 |
| 20 | 0.050 | 1.000 | 0.520 |

## Caveats

- Retrieval only; no model was called. "Tokens to answer" is a proxy: pointer lines sent, plus reading notes in rank order until the first gold note.
- B2 is a grep proxy (files ranked by how many distinct query terms they contain). A real agent would also read the index note and choose files with judgment, so B2 here is a floor for "index plus Grep", not its true value.
- The fixture is synthetic and written by a model; results on real vaults may differ (the private set checks this).
- "Wrong injection" counts every top-5 result that is neither gold nor acceptable; for B2 nothing is injected, so read it as "wrong files surfaced".
