#!/usr/bin/env python3
"""The demo shop behind the README recordings: a tiny repo with a dated history and two earlier Claude Code chats.

Usage: python3 seed.py <folder> [--handoff | --stopped | --teammate]   writes <folder>/home/shop (the repo) and <folder>/home/.claude/projects/... (the chats).
Nothing here is real: the people, the project and the chats are made up, so anyone can rebuild the recordings.
The 06 Oct commit is searched within its day for the hash e0a23e3, the one the first recording (g1) and the plates show.
"""

import hashlib, json, os, subprocess, sys, zlib
from datetime import datetime, timedelta, timezone
from multiprocessing import Pool

IST = timezone(timedelta(hours=5, minutes=30))
WHO = 'maya <maya@example.com>'

FILES = {
    'package.json': '{ "name": "shop", "version": "1.4.0", "type": "module", "scripts": { "test": "node --experimental-strip-types --test test/*.test.ts" } }\n',
    'prices.json': '{ "apple": 0.55, "fig": 1.005, "pear": 0.8 }\n',
    'src/fetch.ts': "/** The price list from the pricing service. */\nexport async function fetchPrices(url: string): Promise<Record<string, number>> {\n  const res = await fetch(url)\n  if (!res.ok) throw new Error(`prices: ${res.status}`)\n\n  return (await res.json()) as Record<string, number>\n}\n",
    'test/cache.test.ts': "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { priceOf } from '../src/cache.ts'\n\ntest('a price comes from the cache', () => {\n  assert.equal(priceOf('apple', 's1'), 0.55)\n})\n",
}
CACHE_ONE = "import { readFileSync } from 'node:fs'\n\n/** One JsonFileCache on prices.json: every store reads and writes the same file. */\nlet cache: Record<string, number> | undefined\n\nexport function priceOf(sku: string, _store: string): number {\n  cache ??= JSON.parse(readFileSync('prices.json', 'utf8')) as Record<string, number>\n\n  return cache[sku] ?? 0\n}\n"
CACHE_SHARDS = "import { readFileSync } from 'node:fs'\n\n/** Eight shards keyed by store id: each has its own file and its own writer, so one slow write blocks one shard. */\nconst SHARDS = 8\nconst shards = new Map<number, Record<string, number>>()\nconst shardOf = (store: string) => [...store].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SHARDS\n\nexport function priceOf(sku: string, store: string): number {\n  const n = shardOf(store)\n  if (!shards.has(n)) shards.set(n, JSON.parse(readFileSync('prices.json', 'utf8')) as Record<string, number>)\n\n  return shards.get(n)![sku] ?? 0\n}\n"
CHARGE = "/** Every charge carries an idempotency key, so a retried request never bills twice. */\nexport function chargeKey(order: string, attempt: number): string {\n  return `${order}:${attempt === 0 ? 'first' : 'retry'}`\n}\n"
FETCH_RETRY = FILES['src/fetch.ts'].replace("export async function fetchPrices(url: string): Promise<Record<string, number>> {\n  const res = await fetch(url)",
    "export async function fetchPrices(url: string): Promise<Record<string, number>> {\n  let res = await fetch(url)\n  for (let i = 0; i < 4 && !res.ok; i++) res = await fetch(url)")

def run(cwd, *a, env=None):
    return subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()

def write(repo, files):
    for path, text in files.items():
        os.makedirs(os.path.dirname(os.path.join(repo, path)) or repo, exist_ok=True)
        with open(os.path.join(repo, path), 'w') as f:
            f.write(text)

def commit(repo, msg, when):
    stamp = when.strftime('%Y-%m-%dT%H:%M:%S%z')
    env = dict(os.environ, GIT_AUTHOR_NAME='maya', GIT_AUTHOR_EMAIL='maya@example.com', GIT_COMMITTER_NAME='maya', GIT_COMMITTER_EMAIL='maya@example.com', GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    run(repo, 'git', 'add', '-A')
    run(repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, env=env)

def body(tree, parent, a, c, msg):
    return f'tree {tree}\nparent {parent}\nauthor {WHO} {a} +0530\ncommitter {WHO} {c} +0530\n\n{msg}\n'.encode()

def search(args):
    """One slice of committer times; returns (author, committer) whose commit hash starts with the prefix."""
    tree, parent, msg, a0, c_from, c_to, prefix = args
    for a in range(a0, a0 + 7200):
        for c in range(c_from, c_to):
            b = body(tree, parent, a, c, msg)
            if hashlib.sha1(b'commit %d\0' % len(b) + b).hexdigest().startswith(prefix):
                return a, c
    return None

def vanity_commit(repo, msg, day, prefix, found=None):
    """Commits the staged tree as `msg` on `day`, at the author and committer seconds that give a hash starting with
    `prefix`. `found` skips the search when the seconds are already known."""
    run(repo, 'git', 'add', '-A')
    tree = run(repo, 'git', 'write-tree')
    parent = run(repo, 'git', 'rev-parse', 'HEAD')
    start = int(day.timestamp())
    if not found:
        a0 = start + 16 * 3600
        slices = [(tree, parent, msg, a0, start + i * 10800, start + (i + 1) * 10800, prefix) for i in range(8)]
        with Pool(8) as pool:
            for hit in pool.imap_unordered(search, slices):
                if hit:
                    found = hit
                    pool.terminate()
                    break
    if not found:
        sys.exit(f'no {prefix} commit found on {day:%Y-%m-%d}')
    b = body(tree, parent, found[0], found[1], msg)
    p = subprocess.run(['git', 'hash-object', '-w', '-t', 'commit', '--stdin'], cwd=repo, input=b, capture_output=True, check=True)
    sha = p.stdout.decode().strip()
    run(repo, 'git', 'update-ref', 'HEAD', sha)
    run(repo, 'git', 'reset', '-q', '--hard', 'HEAD')
    return sha, found

def chat(home, proj, sid, start, turns):
    """A Claude Code chat as Claude Code writes it: one JSON line per message, in the project's folder under ~/.claude."""
    key = ''.join(c if c.isalnum() else '-' for c in proj)
    folder = os.path.join(home, '.claude', 'projects', key)
    os.makedirs(folder, exist_ok=True)
    rows, t = [], start
    for i, (role, content, *extra) in enumerate(turns):
        rows.append(json.dumps({'type': role, 'uuid': f'{sid}-{i}', 'parentUuid': f'{sid}-{i - 1}' if i else None, 'timestamp': t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'), 'cwd': proj, 'sessionId': sid, 'entrypoint': 'cli', 'version': '2.1.290', **(extra[0] if extra else {}), 'message': {'role': role, 'content': content}}))
        t += timedelta(seconds=40)
    path = os.path.join(folder, f'{sid}.jsonl')
    with open(path, 'w') as f:
        f.write('\n'.join(rows) + '\n')
    os.utime(path, (t.timestamp(), t.timestamp()))

def tool(i, name, args, result, error=False):
    return [('assistant', [{'type': 'tool_use', 'id': f'tu{i}', 'name': name, 'input': args}]), ('user', [{'type': 'tool_result', 'tool_use_id': f'tu{i}', 'content': result, **({'is_error': True} if error else {})}])]

def main(out):
    home = os.path.join(out, 'home')
    repo = os.path.join(home, 'shop')
    os.makedirs(repo, exist_ok=True)
    run(repo, 'git', 'init', '-q', '-b', 'main')
    write(repo, {**FILES, 'src/cache.ts': CACHE_ONE})
    commit(repo, 'Cache lives in one file', datetime(2026, 8, 4, 10, 12, tzinfo=IST))
    write(repo, {'src/api/charge.ts': CHARGE})
    commit(repo, 'Every charge carries an idempotency key (#112)', datetime(2026, 9, 9, 11, 40, tzinfo=IST))
    write(repo, {'src/cache.ts': CACHE_SHARDS})
    split, seconds = vanity_commit(repo, 'Split the price cache into eight shards keyed by store id\n\nOne prices.json had a single writer that held the lock for up to 900 ms at the Friday peak.\nA mutex pool made it worse and was reverted. Eight shards brought p99 back to 120 ms.', datetime(2026, 10, 6, tzinfo=IST), 'e0a23e3', FOUND)
    write(repo, {'src/fetch.ts': FETCH_RETRY})
    commit(repo, 'Retry the price fetch four times', datetime(2026, 10, 14, 15, 2, tzinfo=IST))
    run(repo, 'git', 'revert', '--no-edit', 'HEAD', env=dict(os.environ, GIT_AUTHOR_NAME='maya', GIT_AUTHOR_EMAIL='maya@example.com', GIT_COMMITTER_NAME='maya', GIT_COMMITTER_EMAIL='maya@example.com', GIT_AUTHOR_DATE='2026-10-14T17:45:00+0530', GIT_COMMITTER_DATE='2026-10-14T17:45:00+0530'))

    chat(home, repo, '6b1c0e2a-0d6f-4c1e-9a5e-0c06d3c1a0e6', datetime(2026, 10, 6, 15, 10, tzinfo=IST), [
        ('user', 'Checkout timed out again at the Friday peak. Every price sits in one prices.json with a single writer that holds the lock for up to 900 ms. Fix it.'),
        ('assistant', [{'type': 'text', 'text': 'First try: a mutex pool around the writer, so reads stop queueing behind one lock.'}]),
        *tool(1, 'Bash', {'command': 'npm run load-test'}, 'p99 1,480 ms (was 900 ms)'),
        ('assistant', [{'type': 'text', 'text': 'The mutex pool made it worse: p99 went from 900 ms to 1,480 ms, because every store still waits on the same file. Reverted it.'}]),
        ('user', 'Split the price cache into eight shards keyed by store id.'),
        *tool(2, 'Edit', {'file_path': os.path.join(repo, 'src/cache.ts'), 'old_string': 'let cache', 'new_string': 'const SHARDS = 8'}, 'File updated'),
        *tool(3, 'Bash', {'command': 'npm run load-test'}, 'p99 120 ms'),
        ('assistant', [{'type': 'text', 'text': 'Decision: the price cache is eight shards keyed by store id, each with its own file and writer, because one prices.json with a single writer locked up under load. p99 is back to 120 ms. Committed as ' + split[:7] + '.'}]),
    ])
    chat(home, repo, '9d2a7f31-5b0e-4e8c-8a14-1410c0ffee14', datetime(2026, 10, 14, 14, 50, tzinfo=IST), [
        ('user', 'The price fetch fails now and then. Add retries.'),
        *tool(1, 'Edit', {'file_path': os.path.join(repo, 'src/fetch.ts'), 'old_string': 'const res = await fetch(url)', 'new_string': 'let res = await fetch(url)\n  for (let i = 0; i < 4 && !res.ok; i++) res = await fetch(url)'}, 'File updated'),
        ('assistant', [{'type': 'text', 'text': 'Added four plain retries to the price fetch.'}]),
        ('user', 'The pricing service fell over at the peak. Every client retried at the same moment.'),
        ('assistant', [{'type': 'text', 'text': 'Reverted the four plain retries: every client retried at once and the pricing service fell over. Plain retries are a dead end here; next time, retries need jitter.'}]),
    ])
    print(f'shop at {repo}; 06 Oct commit {split} (author and committer seconds {seconds})')

FETCH_JITTER = FILES['src/fetch.ts'].replace("export async function fetchPrices(url: string): Promise<Record<string, number>> {\n  const res = await fetch(url)",
    "const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))\n\nexport async function fetchPrices(url: string): Promise<Record<string, number>> {\n  let res = await fetch(url)\n  for (let i = 0; i < 3 && !res.ok; i++) {\n    await pause(100 * 2 ** i + Math.random() * 100) // jitter: clients spread out instead of retrying at once\n    res = await fetch(url)\n  }")

def handoff(out):
    """For the handoff recording: a Claude Code chat from a few minutes ago that edited src/fetch.ts and stopped before
    the tests ran, its edit left uncommitted. Run it just before recording, since a handoff reads recent chats."""
    home = os.path.join(out, 'home')
    repo = os.path.join(home, 'shop')
    write(repo, {'src/fetch.ts': FETCH_JITTER})
    start = datetime.now(IST) - timedelta(minutes=12)
    chat(home, repo, '3c0de11a-77aa-4b52-9e10-handoff0001', start, [
        ('user', 'Add retries with jitter to the price fetch, then run the tests.'),
        *tool(1, 'Read', {'file_path': os.path.join(repo, 'src/fetch.ts')}, FILES['src/fetch.ts']),
        *tool(2, 'Edit', {'file_path': os.path.join(repo, 'src/fetch.ts'), 'old_string': 'const res = await fetch(url)', 'new_string': 'let res = await fetch(url)'}, 'File updated'),
        ('assistant', [{'type': 'text', 'text': 'Added three retries with exponential backoff and jitter to fetchPrices. Next: run the tests.'}]),
    ])
    print(f'handoff chat written; src/fetch.ts edited and uncommitted in {repo}')

FETCH_TEST = "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { fetchPrices } from '../src/fetch.ts'\n\ntest('a failing fetch is tried three more times', async () => {\n  let calls = 0\n  globalThis.fetch = (async () => (calls++, new Response('', { status: 503 }))) as typeof fetch\n  await assert.rejects(fetchPrices('http://prices'))\n  assert.equal(calls, 3)\n})\n"

def stopped(out):
    """For the handoff still: a Claude Code chat from 20 minutes ago that added jitter and a test, saw the test fail, left a
    question for whoever comes next, and was stopped by a usage limit. Run it just before capturing."""
    home = os.path.join(out, 'home')
    repo = os.path.join(home, 'shop')
    write(repo, {'src/fetch.ts': FETCH_JITTER, 'test/fetch.test.ts': FETCH_TEST})
    start = datetime.now(IST) - timedelta(minutes=26)
    chat(home, repo, '7f4e2b90-1c3d-4a8e-b5f6-stopped00001', start, [
        ('user', 'Add retries with jitter to the price fetch, with a test, then run the tests.\n[question] Should the retry cap be 3 or 5? The pricing team never said.'),
        *tool(1, 'Read', {'file_path': os.path.join(repo, 'src/fetch.ts')}, FILES['src/fetch.ts']),
        *tool(2, 'Edit', {'file_path': os.path.join(repo, 'src/fetch.ts'), 'old_string': 'const res = await fetch(url)', 'new_string': 'let res = await fetch(url)'}, 'File updated'),
        *tool(3, 'Write', {'file_path': os.path.join(repo, 'test/fetch.test.ts'), 'content': FETCH_TEST}, 'File created'),
        *tool(4, 'Bash', {'command': 'npm test'}, "not ok 2 - a failing fetch is tried three more times\n  AssertionError: 4 !== 3\n# pass 1\n# fail 1", error=True),
        ('assistant', [{'type': 'text', 'text': 'The new test fails: the loop calls fetch four times in all, and the test expects three. Fixing the count next.'}]),
        ('assistant', [{'type': 'text', 'text': f"5-hour limit reached · resets {(start + timedelta(hours=4)).strftime('%-I%p').lower()}"}], {'isApiErrorMessage': True}),
    ])
    print(f'stopped chat written; src/fetch.ts and test/fetch.test.ts uncommitted in {repo}')

FETCH_BREAKER = FILES['src/fetch.ts'].replace("/** The price list from the pricing service. */", "/** The price list from the pricing service. After three failures in a minute it fails fast for 30 s. */")

def teammate(out):
    """For the teammate still: alice's machine, her clone of the shop, and a Copilot CLI chat from 8 minutes ago that started a
    circuit breaker in src/fetch.ts and was stopped when her premium requests ran out. The team steps run after this."""
    home = os.path.join(out, 'alice')
    repo = os.path.join(home, 'shop')
    if not os.path.isdir(repo):
        os.makedirs(home, exist_ok=True)
        run(home, 'git', 'clone', '-q', os.path.join(out, 'home', 'shop'), 'shop')
    write(repo, {'src/fetch.ts': FETCH_BREAKER})
    sid = '0c9e5d27-4b1a-4f63-9d8e-2a7b5c1f3e60'
    folder = os.path.join(home, '.copilot', 'session-state', sid)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'workspace.yaml'), 'w') as f:
        f.write(f'cwd: {repo}\n')
    t = datetime.now(timezone.utc) - timedelta(minutes=8)
    def ev(i, kind, data):
        return json.dumps({'type': kind, 'id': f'{sid}-{i}', 'timestamp': (t + timedelta(seconds=30 * i)).strftime('%Y-%m-%dT%H:%M:%S.000Z'), 'data': data})
    rows = [
        ev(0, 'session.start', {'sessionId': sid, 'copilotVersion': '1.0.105', 'context': {'cwd': repo}}),
        ev(1, 'user.message', {'content': 'Put the price fetch behind a circuit breaker, so a dead pricing service fails fast instead of hanging checkout.'}),
        ev(2, 'assistant.message', {'content': 'Starting with a breaker around fetchPrices: open after three failures in a minute, half-open after 30 s.', 'toolRequests': [{'toolCallId': 'c1', 'name': 'edit', 'arguments': {'path': os.path.join(repo, 'src/fetch.ts'), 'old_str': '/** The price list from the pricing service. */', 'new_str': '/** The price list from the pricing service. After three failures in a minute it fails fast for 30 s. */'}}]}),
        ev(3, 'tool.execution_complete', {'toolCallId': 'c1', 'success': True, 'result': {'content': 'File updated'}}),
        ev(4, 'assistant.message', {'content': 'The breaker state goes next, then a test for the half-open step.'}),
        ev(5, 'abort', {'reason': 'premium request limit reached'}),
    ]
    with open(os.path.join(folder, 'events.jsonl'), 'w') as f:
        f.write('\n'.join(rows) + '\n')
    print(f'alice at {home}; her Copilot chat {sid[:8]} stopped in src/fetch.ts')

# The author and committer seconds for e0a23e3, found once; delete to search again (about a minute on eight cores).
FOUND = (1791282837, 1791287331)

if __name__ == '__main__':
    (teammate if '--teammate' in sys.argv else stopped if '--stopped' in sys.argv else handoff if '--handoff' in sys.argv else main)(os.path.abspath(sys.argv[1]))
