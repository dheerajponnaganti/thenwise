# How we measured Thenwise

Every number in the README comes from questions about real project history, answered by Claude Code in fresh sessions and graded blind against answers it never saw.

## The questions

Each question is written from a project's real records: its chats, commits, pull requests and notes. It comes with a gold answer, the facts an answer must contain, and the sources that hold them. The gold answers are sealed outside the repository, and no session that answers can read them.

The questions cover what people ask about a project's past:

| Kind | Example |
| --- | --- |
| Why | Why did we split the cache into shards? |
| Tried | What did we already try for the fetch retries? |
| When | On which day did we move to the new queue? |
| Current | What is the setup now? |
| As of a date | What was the latest release on 25 October? |
| Connect | Which release carried the fix for the login bug? |
| Decoy | A question nothing in the records answers. The right reply says it is not recorded. |

## The two arms

Both arms are Claude Code with the same model, the same question and a fresh session per question. Tools are read only.

- **Plain Claude Code** reads the repository, its full git history and its pull requests through `gh`. No plugins and no notes.
- **Thenwise** has the same, plus the Thenwise plugin over a store frozen at a cutoff, so the history it holds is fixed for the whole round.

For the Teams test, the Thenwise arm is a teammate who never worked on the project and has only what a colleague shared.

## Grading

A judge model checks each required fact of an answer against the gold answer. It never learns which arm wrote the answer, and it has no tools. An answer is correct when it holds every required fact and does not present an old state as current. The judge also records outdated answers, wrong answers and abstentions. Tokens are counted per answer, weighted by their price, and time is wall clock.

## Results

**Individual: your own history** (30 questions)

| | Plain Claude Code | Thenwise |
| --- | --- | --- |
| Correct | 47% | **83%** |
| Tokens per answer | 67,987 | **41,136** (40% fewer) |
| Seconds per answer | 51 | **23** (2.2 times faster) |

Plain's score and the times come from a re-run that kept plain away from leftover copies of our records on the test machine. An earlier round let plain read them, and scored it 63%.

**Teams: a teammate's shared chats** (24 questions, Thenwise 0.1.17)

| | Plain Claude Code | Thenwise |
| --- | --- | --- |
| Correct | 25% | **88%** |
| Decoys answered "not recorded" | 4 of 4 | **4 of 4** |
| Tokens per answer | 55,045 | **42,030** (24% fewer) |
| Seconds per answer | 33 | **22** (1.5 times faster) |

**Install:** 2,500 chats archived, masked and searchable 84 seconds after install.

## Run it yourself

The harness is in [`bench/real`](../bench/real): `run.ts` asks the questions in fresh `claude -p` sessions for each arm, `judge.ts` grades blind, and `gate.ts` compares two arms. The question sets name private projects, so they live outside the repository; write your own from your history in the same format and point the harness at them.
