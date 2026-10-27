# E5: what the plugin costs in small chats that do not need memory. Five one-prompt chats on a tiny repo, plain Claude Code
# against Claude Code plus Thenwise (frozen store, sync off), print mode, the same model. Prints weighted tokens per arm.
# Usage: python3 e5_small.py <out dir> [runs] [model]
import json, os, re, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

out = os.path.realpath(sys.argv[1]); runs = int(sys.argv[2]) if len(sys.argv) > 2 else 2; model = sys.argv[3] if len(sys.argv) > 3 else 'sonnet'
home = os.path.expanduser('~'); root = os.environ.get('THENWISE_EVAL_ROOT'); gate = f'{root}/gate' if root else f'{home}/carapace-crew/eval-ws/gate'; plugin = f'{root}/plugin' if root else f'{gate}/plugin'
os.makedirs(out, exist_ok=True)
store = f'{out}/store'
if not os.path.exists(store):
    os.makedirs(store); shutil.copy(f'{gate}/store/graph.db', store)
    json.dump({'version': 1, 'exclude_projects': ['*']}, open(f'{store}/config.json', 'w'))

FILES = {
    'package.json': '{ "name": "textkit", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }\n',
    'src/text.js': "// Small text helpers.\nexport function wordCount(text) {\n  return text.split(' ').length\n}\n\nexport function titleCase(text) {\n  return text.replace(/\\b\\w/g, (c) => c.toUpperCase())\n}\n",
    'test/text.test.js': "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { titleCase, wordCount } from '../src/text.js'\n\ntest('wordCount', () => {\n  assert.equal(wordCount('one two  three'), 3)\n  assert.equal(wordCount(''), 0)\n})\n\ntest('titleCase', () => assert.equal(titleCase('a tale'), 'A Tale'))\n",
}
TAG = ' [memory-eval]'
PROMPTS = [
    ('build', 'Add a slugify(text) function to src/text.js that turns a title into a URL slug (lower case, words joined by hyphens, punctuation dropped), with tests. Run the tests.'),
    ('fix', 'The wordCount test fails. Find out why and fix wordCount, then run the tests.'),
    ('ask', 'What does titleCase count as the start of a word, and where is that decided? Do not edit anything.'),
    ('add', 'Add a truncate(text, n) function that cuts text to n characters and adds "..." when it cuts, with tests. Run the tests.'),
    ('commit', 'Commit the current changes with a short message.'),
]
OFF = {p: False for p in ['swift-lsp@claude-plugins-official', 'cloudflare@cloudflare', 'ponytail@ponytail', 'impeccable@impeccable', 'typesafe@typesafe-ai', 'rasterless@dheeraj-skills']}
ALLOWED = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(git:*)', 'Bash(ls:*)', 'mcp__plugin_thenwise_thenwise__*']
DENY = ['WebSearch', 'WebFetch', 'Agent', 'Read(~/.memory/**)', 'Read(~/.claude/projects/**/*.jsonl)', 'Read(~/Library/Mobile Documents/**)', 'Read(~/carapace-crew/eval-ws/gate/**)', 'Read(~/carapace-crew/eval-ws/r0*/gate/**)', 'Read(~/carapace-crew/eval-ws/r0*/e3/**)', f'Read(~/{os.path.relpath(store, home)}/**)']

def repo(path, commit_all):
    shutil.rmtree(path, ignore_errors=True)
    for rel, text in FILES.items():
        os.makedirs(os.path.dirname(f'{path}/{rel}'), exist_ok=True); open(f'{path}/{rel}', 'w').write(text)
    g = lambda *a: subprocess.run(['git', '-C', path, *a], check=True, capture_output=True)
    g('init', '-q'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.com'); g('add', '-A'); g('commit', '-qm', 'textkit')
    if not commit_all: open(f'{path}/src/text.js', 'a').write('\nexport const VERSION = "1.0.1"\n')

def one(job):
    arm, r, pid, prompt = job
    ws = f'{out}/ws/{arm}-r{r}-{pid}'
    repo(ws, pid != 'commit')
    settings = json.dumps({'env': {'CLAUDE_CODE_PLUGIN_DIRS': ''}, 'enabledPlugins': OFF})
    cmd = ['claude', '-p', '--output-format', 'json', '--model', model, '--settings', settings, *(['--plugin-dir', plugin] if arm == 'plugin' else []), '--allowedTools', *ALLOWED, '--disallowedTools', *DENY]
    env = {**{k: v for k, v in os.environ.items() if k != 'CLAUDE_CODE_PLUGIN_DIRS'}, **({'THENWISE_HOME': store, 'THENWISE_SYNC': 'off'} if arm == 'plugin' else {})}
    while True:
        p = subprocess.run(cmd, input=prompt + TAG, cwd=ws, env=env, capture_output=True, text=True, timeout=600)
        # The usage limit answers with a notice instead of an answer: wait for the reset and ask again.
        if not re.search(r'hit your (session|usage|weekly) limit', p.stdout, re.I): break
        time.sleep(300)
    try: res = json.loads(p.stdout)
    except ValueError: res = {}
    u = res.get('usage', {})
    w = u.get('input_tokens', 0) + 0.1 * u.get('cache_read_input_tokens', 0) + 1.25 * u.get('cache_creation_input_tokens', 0) + 5 * u.get('output_tokens', 0)
    tests = subprocess.run(['node', '--test'], cwd=ws, capture_output=True).returncode == 0
    return {'arm': arm, 'run': r, 'id': pid, 'weighted': round(w), 'turns': res.get('num_turns'), 'tests_pass': tests, 'answer': (res.get('result') or '')[:300]}

jobs = [(arm, r, pid, text) for r in range(1, runs + 1) for pid, text in PROMPTS for arm in ('plain', 'plugin')]
with ThreadPoolExecutor(4) as ex:
    rows = list(ex.map(one, jobs))
json.dump(rows, open(f'{out}/e5.json', 'w'), indent=1)
for arm in ('plain', 'plugin'):
    mine = [x for x in rows if x['arm'] == arm]
    print(arm, 'mean weighted', round(sum(x['weighted'] for x in mine) / len(mine)), 'turns', round(sum((x['turns'] or 0) for x in mine) / len(mine), 1), 'tests pass', sum(x['tests_pass'] for x in mine), 'of', len(mine))
p = [x['weighted'] for x in rows if x['arm'] == 'plain']; g = [x['weighted'] for x in rows if x['arm'] == 'plugin']
print('overhead', f'{(sum(g) - sum(p)) / sum(p) * 100:.1f}%')
