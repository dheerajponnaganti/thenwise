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

const chat = (cmd: string, out: string) =>
  [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', cwd: '/p', message: { role: 'user', content: 'commit it' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:01Z', cwd: '/p', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:00:02Z', cwd: '/p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: out }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n')
const turn = (cmd: string, out = '[main 1a2b3c4] From the output\n 1 file changed') => parseSession(chat(cmd, out), 's', '/h').turns[0]!

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
