#!/bin/zsh
# Builds one evaluation round: a clone of the release branch (plugin/) and frozen stores gate/ (the owner's history) and
# e3/ (a second project, its folders from the e3 set in ~/.memory/eval/records.json). Chats still running at the freeze (written in the last 15 minutes) are forgotten,
# so the session that builds or runs the evaluation never answers its own questions.
# Usage: bench/real/freeze.sh <round dir> [until ISO, default now]   Then: THENWISE_EVAL_ROOT=<round dir> node bench/real/run.ts ...
set -e
R=${1:?usage: freeze.sh <round dir> [until]}; UNTIL=${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
mkdir -p $R/gate/store $R/e3/store; echo $UNTIL > $R/frozen-at
[ -d $R/plugin ] || git clone -q --single-branch --branch release ~/memory-v2 $R/plugin
python3 - $R <<'EOF'
import json, os, sys
r = sys.argv[1]
c = json.load(open(os.path.expanduser('~/.memory/config.json')))
# A frozen store never writes outside its folder: forget would rewrite a configured vault, backups or team notes.
for k in ('views', 'vault', 'backup', 'team', 'teams'): c.pop(k, None)
c['exclude_projects'] = sorted(set(c.get('exclude_projects', []) + ['*-eval-ws*'])); c['scope'] = 'all'
json.dump(c, open(f'{r}/gate/store/config.json', 'w'), indent=1)
e3 = json.load(open(os.path.expanduser('~/.memory/eval/records.json')))['e3']['dirs']
json.dump({'version': 1, 'scope': 'all', 'exclude_projects': c['exclude_projects'], 'ingest': {'roots': e3, 'repos': e3, 'github_repos': [], 'vaults': [], 'prs': False}}, open(f'{r}/e3/store/config.json', 'w'), indent=1)
EOF
# Session ids of chats written in the last 15 minutes, outside evaluation folders.
LIVE=($(find ~/.claude/projects -maxdepth 2 -name '*.jsonl' -mmin -15 ! -path '*eval-ws*' -exec basename {} .jsonl \;))
for s in gate:$UNTIL e3:2026-10-15T00:00:00Z; do
  n=${s%%:*}; u=${s#*:}; export THENWISE_HOME=$R/$n/store THENWISE_SYNC=off
  node $R/plugin/dist/cli.js archive | tail -1
  node $R/plugin/dist/cli.js ingest --full --until $u | tail -1
  for id in $LIVE; do node $R/plugin/dist/cli.js forget $id --yes 2>&1 | grep -q 'Nothing found' || echo "$n: left out live chat $id"; done
  rm -rf $R/$n/store/archive $R/$n/store/hook-state
done
