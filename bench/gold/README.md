# Gold retrieval benchmark

Measures where the records that hold an answer land in Thenwise's ranking, for every command the plugin's tools use. No model and no network, so a run takes seconds. Every ranking change is checked with it before any judged evaluation.

```sh
node bench/gold/run.ts --label <name>                 # R@1, R@3, R@10 and MRR per command and per kind
node bench/gold/run.ts --label <new> --compare <old>  # also lists every question whose rank moved
node bench/gold/run.ts --chars                        # also reports the size of each formatted answer
node bench/gold/build.ts                              # rebuilds the gold set from the evaluation question sets
```

The gold set, its stores and the results live outside the repo, in `~/.memory/eval/gold/`: they name private chats and repositories.

```
~/.memory/eval/gold/
  gold.jsonl.gz        one line per question
  gate/, e3/           frozen data folders (graph.db, config.json, archive); never synced
  out/gold-<label>.json  one file per run
```

## A gold line

```json
{ "id": "e2-07", "set": "e2-2026-10-25", "store": "gate", "kind": "why", "cmd": "why",
  "query": "the question as asked", "date": "2026-10-20T09:00:00Z",
  "gold": ["turn:<id>"], "acceptable": ["pr:<repo>#12"], "must_not": [] }
```

- `cmd` is the ranking to use: `search`, `why`, `tried`, `current` or `asof` (`date` is required for `asof`).
- `gold` holds the ids of the records that hold the answer; `acceptable` holds records that hold it too. A question scores the rank of the first of either.
- `must_not` holds records that must not be in the top 3, such as an outdated statement of the answer.
- `store` names the folder under `~/.memory/eval/gold/`, or `db` gives a path.

Gold holds ids only, never answer text, so the set can be checked without leaking what it tests.

## How the gold set is built

`build.ts` reads the question sets in `~/.memory/eval/` (each question lists its required facts and its sources). For a question it takes the records of its sources (every record of a source chat, a PR by number, a commit by sha, a note by name) and keeps as gold the ones that state the most required facts. Elsewhere in the store, a record that states every fact is acceptable. A source the store does not hold falls back to the whole store, with at least half the facts required. Negative questions and, for sets older than their store, `current` questions are left out.

To check or fix a line by hand, read its records on the gold store:

```sh
THENWISE_HOME=~/.memory/eval/gold/gate THENWISE_SYNC=off thenwise get <id>
```

Rebuild a store only with the same cutoff it was frozen at, or the gold ids may no longer hold the answer.
