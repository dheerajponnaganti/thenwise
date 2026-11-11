import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maskSecrets } from '../src/core/secrets.ts'
import { bashPaths, parseSession } from '../src/ingest/transcript.ts'

test('shell commands link paths on any system: Linux, Windows, relative and after a leading cd', () => {
  assert.deepEqual(bashPaths('cat /home/me/p/a.ts', '/home/me'), ['/home/me/p/a.ts'])
  assert.deepEqual(bashPaths('cat /root/p/a.ts', '/root'), ['/root/p/a.ts'])
  assert.deepEqual(bashPaths('cat /Users/me/p/a.ts ~/b.ts', '/Users/me'), ['/Users/me/p/a.ts', '/Users/me/b.ts'])
  assert.deepEqual(bashPaths('Get-Content C:\\repo\\src\\a.ts', 'C:/Users/me'), ['C:/repo/src/a.ts'])
  assert.deepEqual(bashPaths('cat /workspace/p/a.ts /usr/bin/env', '/h', '/workspace/p'), ['/workspace/p/a.ts'])
  assert.deepEqual(bashPaths('grep -n foo src/a.ts', '/h', '/p'), ['/p/src/a.ts'])
  assert.deepEqual(bashPaths('cd /q && sed -n 1,5p src/a.ts', '/h', '/p'), ['/q/src/a.ts'])
  assert.deepEqual(bashPaths('cd sub && cat ./b/c.py', '/h', '/p'), ['/p/sub/b/c.py'])
  assert.deepEqual(bashPaths('cat .github/workflows/ci.yml', '/h', '/p'), ['/p/.github/workflows/ci.yml'])
})

test('words that look like paths are not linked', () => {
  for (const cmd of ['curl https://github.com/a/b.git', 'git clone github.com/a/b.git', 'git push origin/main', 'nvm use node/22.16', 'cat a.ts', 'ls src/', "sed 's/foo/bar/g' -i x", 'curl -H "Accept: application/vnd.api+json" x', 'echo $HOME/x', 'cat /dev/null']) {
    assert.deepEqual(bashPaths(cmd, '/h', '/p'), [], cmd)
  }
})

const chat = (cmd: string, out: string, error = false) =>
  [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', cwd: '/p', message: { role: 'user', content: 'commit it' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:01Z', cwd: '/p', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:00:02Z', cwd: '/p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: out, is_error: error }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n')
const turn = (cmd: string, out = '[main 1a2b3c4] From the output\n 1 file changed', error = false) => parseSession(chat(cmd, out, error), 's', '/h').turns[0]!

test('a commit is linked however it is written, and -m still wins over what git prints', () => {
  for (const cmd of ['git -c user.name=x commit -F msg.txt', 'git --no-pager commit --amend --no-edit', 'git -C /p commit']) {
    const t = turn(cmd)
    assert.ok(t.commitShas.has('1a2b3c4'), cmd)
    assert.deepEqual(t.commitMsgs.map((c) => c.subject), ['From the output'], cmd)
  }
  assert.deepEqual(turn('git commit -m "Typed subject"').commitMsgs.map((c) => c.subject), ['Typed subject'])
  assert.deepEqual(turn('git -c a=b commit -m "Typed subject"').commitMsgs.map((c) => c.subject), ['Typed subject'])
  assert.deepEqual(turn('git log --grep commit', 'nothing').commitMsgs, [])
})

test('#108: a Bash call that tests and commits records every test run and commit, and a failed commit no subject', () => {
  const subjects = (t: ReturnType<typeof turn>) => t.commitMsgs.map((c) => c.subject)
  const runs = (t: ReturnType<typeof turn>) => t.tests.map((x) => [x.cmd, x.failed])
  // Tests, then a commit, in every shape: both are kept.
  for (const cmd of ['npm test && git commit -m "Fix it"', 'npm test; git commit -m "Fix it"', 'npm test || git commit -m "Fix it"', 'npm test && pytest && git commit -m "Fix it"']) {
    const t = turn(cmd, 'ok\n[main 1a2b3c4] Fix it\n 1 file changed')
    assert.deepEqual(runs(t), [[cmd, false]], cmd)
    assert.ok(t.commitShas.has('1a2b3c4'), cmd)
    assert.deepEqual(subjects(t), ['Fix it'], cmd)
  }
  // A commit, then a test that fails: the commit stands and the run failed.
  const after = turn('git commit -m "Fix it" && python -m pytest', '[main 1a2b3c4] Fix it\n1 failed', true)
  assert.deepEqual(runs(after), [['git commit -m "Fix it" && python -m pytest', true]])
  assert.deepEqual(subjects(after), ['Fix it'])
  // Tests fail, so git never runs: the run failed and nothing was committed.
  const failed = turn('npm test && git commit -m "Fix it"', '1 failing', true)
  assert.deepEqual(runs(failed), [['npm test && git commit -m "Fix it"', true]])
  assert.deepEqual(subjects(failed), [])
  assert.equal(failed.commitShas.size, 0)
  // A commit that fails alone, or behind `|| true`, records no subject. A quiet one that worked keeps it.
  assert.deepEqual(subjects(turn('git commit -m "Fix it"', 'nothing to commit, working tree clean', true)), [])
  assert.deepEqual(subjects(turn('git commit -m "Fix it" || true', 'nothing to commit, working tree clean')), [])
  assert.deepEqual(subjects(turn('git commit -q -m "Fix it"', '')), ['Fix it'])
  // Two commits in one call: both subjects; an -m of another command is no subject.
  assert.deepEqual(subjects(turn('git commit -m "One" && git commit -m "Two"', '[main 1a2b3c4] One\n[main 5d6e7f8] Two')), ['One', 'Two'])
  assert.deepEqual(subjects(turn('git commit -F msg.txt && python -m pytest', '[main 1a2b3c4] From the file\nok')), ['From the file'])
  assert.deepEqual(subjects(turn('python -m pytest && git commit -m "Fix it"', 'ok\n[detached HEAD 1a2b3c4] Fix it')), ['Fix it'])
  assert.ok(turn('git commit -m "Fix it"', '[detached HEAD 1a2b3c4] Fix it').commitShas.has('1a2b3c4'))
  // A commit and a PR in one call: both are linked.
  const pr = turn('npm test && git commit -m "Fix it" && gh pr create --fill', '[main 1a2b3c4] Fix it\nhttps://github.com/o/r/pull/7')
  assert.deepEqual([pr.tests.length, [...pr.commitShas], [...pr.prUrls]], [1, ['1a2b3c4'], ['https://github.com/o/r/pull/7']])
})

test('secrets in shell commands are masked: flags and the Windows ways to set one', () => {
  const v = 'q7Zp2Lk9Vx4Tn8Rw3Hs6'
  for (const t of [`setx API_KEY ${v}`, `setx GITHUB_TOKEN "${v}"`, `[Environment]::SetEnvironmentVariable("API_KEY","${v}","User")`, `ConvertTo-SecureString "${v}" -AsPlainText -Force`, `--password ${v}`, `-Password ${v}`, `mysql --user x --password "${v}"`, `--api-key ${v}`, `New-Object PSCredential("u", "${v}")`, `$env:API_KEY = "${v}"`, `set API_KEY=${v}`]) {
    const once = maskSecrets(t).text
    assert.ok(!once.includes(v), t)
    assert.equal(maskSecrets(once).text, once, `masking twice changes nothing: ${t}`)
  }
  for (const t of ['--token-file /etc/app/creds.txt', 'docker login --password-stdin registry', '--password $DB_PASSWORD', '-Token $tok', '--max-token 4096', 'setx PATH C:/tools/bin/longpath', 'pre-token generation runs before', 'SetEnvironmentVariable("PATH","C:/tools","User")']) {
    assert.equal(maskSecrets(t).text, t, t)
  }
})
