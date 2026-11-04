# How we measured Thenwise

<p align="center"><img src="../assets/readme/measurements.png" width="100%" alt="Field measurements with hidden answers, graded blind. Individual, on your own history: 2.5 times more questions answered right (93% against 37%), 60% fewer raw tokens, 1.9 times faster. Teams, from a teammate's shared chats: 5.3 times more questions answered right (88% against 17%), 39% fewer raw tokens, 1.5 times faster. A fresh install remembered 2,771 chats in 164 seconds. Every tool on the same questions: Claude Code 31 of 36 right with 0 of 8 decoys invented, Copilot CLI 79% of real questions right, Codex 71% of real questions right."></p>


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

- **Plain Claude Code** reads the repository, its full git history and a copy of its pull requests. No plugins and no notes.
- **Thenwise** has the same, plus the Thenwise plugin over a store frozen at a cutoff, so the history it holds is fixed for the whole round. On your own history it also has the notes.

Everything each arm can read is restored to its exact state at the cutoff, which falls before the questions were written. An operating system sandbox blocks every other file on the machine, for both arms.

For the Teams test, the Thenwise arm is a teammate who never worked on the project and has only what a colleague shared.

## Grading

A judge model checks each required fact of an answer against the gold answer. It never learns which arm wrote the answer, and it has no tools. An answer is correct when it holds every required fact and does not present an old state as current. The judge also records outdated answers, wrong answers and abstentions. Tokens are counted per answer, weighted by their price, and time is wall clock.

## Results

**Individual: your own history** (30 questions)

| | Plain Claude Code | Thenwise |
| --- | --- | --- |
| Correct | 37% | **93%** |
| Decoys answered "not recorded" | 4 of 4 | **4 of 4** |
| Raw tokens, all 30 questions | 7,118,023 | **3,558,854** (50% fewer) |
| Seconds per answer | 26 | **14** (1.9 times faster) |
| Reported cost per answer | $0.099 | **$0.095** (4% less) |

One run per arm with Thenwise 0.1.25 plus the memory fix in 0.1.26. Raw tokens count every token equally. Most of them are cheap cache reads, and cache writes cost the most, so cost falls by less than tokens. Earlier rounds on this question set scored 83% against 47%, before the frozen copies and the sandbox closed gaps on both sides.

**Teams: a teammate's shared chats** (24 questions)

| | Plain Claude Code | Thenwise |
| --- | --- | --- |
| Correct | 17% | **88%** |
| Decoys answered "not recorded" | 4 of 4 | **4 of 4** |
| Raw tokens, all 24 questions | 4,978,244 | **3,060,387** (39% fewer) |
| Seconds per answer | 24 | **16** (1.5 times faster) |
| Reported cost, all 24 questions | $2.87 | **$2.58** (10% less) |

One run per arm, with the same frozen copies and sandbox. The teammate's store holds only the 19 chats another member shared through a local team server. An earlier round scored 88% against 25%.

**Every tool, the same questions** (18 real-history questions, graded blind by the same judge)

| Tool | Result |
| --- | --- |
| Claude Code, Thenwise 0.2.0 | 31 of 36 answers right over two runs, 0 of 8 decoys invented |
| Copilot CLI | 79% of real questions right, a memory tool first on 18 of 18 |
| Codex | 71% of real questions right |

**Install:** on one real machine, a fresh store archived and masked 5,834 chats, and 2,771 of them were searchable 164 seconds after install, with the first answer at once.

## Run it yourself

The harness is in [`bench/real`](../bench/real): `run.ts` asks the questions in fresh `claude -p` sessions for each arm, `judge.ts` grades blind, and `gate.ts` compares two arms. Set `THENWISE_EVAL_SANDBOX` to a macOS sandbox profile to run each candidate inside it, as these rounds did. The question sets name private projects, so they live outside the repository; write your own from your history in the same format and point the harness at them.
