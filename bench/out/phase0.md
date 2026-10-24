# Benchmark phase0

Date 2026-10-22T17:18:50.678Z. Vault: 100 notes, 500 edges, 7 hubs. Questions used: 120 of 120.

| System | Kind | n | R@1 | R@3 | R@5 | MRR | wrong inj. | must-not | tokens to answer (mean) | sent (mean) | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B2_grep_proxy | all | 120 | 0.280 | 0.690 | 0.800 | 0.488 | 0.700 | 0.512 | 1148 | 0 | 0.29 |
| B2_grep_proxy | lookup | 20 | 0.200 | 0.600 | 0.750 | 0.408 | 0.800 | n/a | 1180 | 0 | 4.80 |
| B2_grep_proxy | why | 20 | 0.250 | 0.900 | 0.950 | 0.560 | 0.810 | 1.000 | 1159 | 0 | 0.26 |
| B2_grep_proxy | multi_hop | 20 | 0.250 | 0.600 | 0.750 | 0.432 | 0.680 | 0.143 | 1307 | 0 | 0.39 |
| B2_grep_proxy | temporal | 20 | 0.200 | 0.550 | 0.650 | 0.372 | 0.820 | 0.600 | 1363 | 0 | 0.26 |
| B2_grep_proxy | action | 20 | 0.500 | 0.800 | 0.900 | 0.667 | 0.390 | 0.333 | 732 | 0 | 0.34 |
| B2_grep_proxy | negative | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | n/a | 0 | 0 | 0.26 |
| B3_lexical | all | 120 | 0.470 | 0.710 | 0.780 | 0.591 | 0.685 | 0.244 | 785 | 243 | 0.05 |
| B3_lexical | lookup | 20 | 0.600 | 0.750 | 0.900 | 0.704 | 0.750 | n/a | 671 | 239 | 0.24 |
| B3_lexical | why | 20 | 0.600 | 0.750 | 0.850 | 0.700 | 0.776 | 0.000 | 773 | 252 | 0.04 |
| B3_lexical | multi_hop | 20 | 0.150 | 0.650 | 0.750 | 0.375 | 0.650 | 0.000 | 971 | 253 | 0.03 |
| B3_lexical | temporal | 20 | 0.300 | 0.400 | 0.400 | 0.342 | 0.857 | 0.500 | 949 | 227 | 0.10 |
| B3_lexical | action | 20 | 0.700 | 1.000 | 1.000 | 0.833 | 0.400 | 0.000 | 561 | 250 | 0.04 |
| B3_lexical | negative | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | n/a | 0 | 241 | 0.03 |

## B3 threshold sweep (send nothing when the top score is below tau)

| tau | R@3 (answerable) | silence on negatives | wrong injection |
| --- | --- | --- | --- |
| 0 | 0.710 | 0.000 | 0.738 |
| 1 | 0.710 | 0.000 | 0.738 |
| 2 | 0.710 | 0.000 | 0.738 |
| 4 | 0.710 | 0.000 | 0.738 |
| 6 | 0.710 | 0.000 | 0.738 |
| 8 | 0.710 | 0.000 | 0.738 |
| 10 | 0.700 | 0.050 | 0.735 |
| 12 | 0.680 | 0.100 | 0.729 |
| 15 | 0.650 | 0.200 | 0.717 |
| 20 | 0.490 | 0.650 | 0.685 |

## Caveats

- Retrieval only; no model was called. "Tokens to answer" is a proxy: pointer lines sent, plus reading notes in rank order until the first gold note.
- B2 is a grep proxy (files ranked by how many distinct query terms they contain). A real agent would also read the index note and choose files with judgment, so B2 here is a floor for "index plus Grep", not its true value.
- The fixture is synthetic and written by a model; results on real vaults may differ (the private set checks this).
- "Wrong injection" counts every top-5 result that is neither gold nor acceptable; for B2 nothing is injected, so read it as "wrong files surfaced".
