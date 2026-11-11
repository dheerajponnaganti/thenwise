import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MASK, MASK_VERSION, maskDeep, maskSecrets } from '../src/core/secrets.ts'

test('SRE-07 mask shapes the report found missing', () => {
  assert.ok(MASK_VERSION >= 6)
  for (const s of [
    'https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    'ya29.a0AfH6SMBx3bQ-abcdefghijklmnopqrstuvwxyz0123456789',
    'redis://:supersecretpass@host:6379',
    '{"auths":{"r":{"auth":"dXNlcjpwYXNzd29yZDEyMzQ1Ng=="}}}',
    'export openai_key=sk_abcdefghijklmnop1234',
    'MY_TOKEN: "abcdefgh12345678"',
    'client_secret=abcdefgh12345678',
  ]) {
    const r = maskSecrets(s)
    assert.ok(r.count > 0, s)
    assert.ok(!/supersecretpass|XXXXXXXX|abcdefghijklmnop1234|dXNlcjpw|a0AfH6|abcdefgh12345678|T0000000/.test(r.text), r.text)
  }
  assert.equal(maskSecrets('redis://:supersecretpass@host:6379').text, 'redis://:[secret masked]@host:6379')
})

test('SRE-07 held samples hold and prose stays readable', () => {
  for (const s of ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'X-Api-Key: 7f9c2ba4e88f827d616045507605853e', 'PGPASSWORD=s3cr3tpassword psql']) assert.ok(maskSecrets(s).count > 0, s)
  for (const s of ['Set the api_key setting in the config.', 'the monkey_key_value is a name', 'sort_key is used for ordering', 'redis://host:6379/0 is the default', 'the auth field is required']) assert.equal(maskSecrets(s).text, s)
})

test('SRE-07: a <word>_key in ordinary code stays readable; a token-like value is masked', async () => {
  const { maskSecrets } = await import('../src/core/secrets.ts')
  for (const s of ['foreign_key: users.id', 'sort_key = "created_at"', 'cache_key=user_42_profile', 'partition_key: tenant_id']) assert.equal(maskSecrets(s).count, 0, s)
  for (const s of ['export openai_key=sk_abcdefghijklmnop1234', 'stripe_key: sk_live_abcdefghijklmnopqrstuv']) assert.equal(maskSecrets(s).count, 1, s)
})

test('SRE-15: environment references and plain config values stay readable', async () => {
  const { maskSecrets } = await import('../src/core/secrets.ts')
  for (const s of ['api_key = process.env.API_KEY', 'token: ${GITHUB_TOKEN}', 'password = os.environ["DB_PASS"]', 'cache_key="user_profile_settings_v2"', '"auth": "required"']) assert.equal(maskSecrets(s).count, 0, s)
  assert.equal(maskSecrets('{"auths":{"r":{"auth":"dXNlcjpwYXNzd29yZDEyMzQ1Ng=="}}}').count, 1)
})

test('masking stays linear on long hyphenated text, and long secret names still mask', () => {
  const t = Date.now()
  maskSecrets('a-'.repeat(50_000))
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms for 100 KB`)
  assert.match(maskSecrets('my-very-long-service-name-for-billing-api_key = abcd1234efgh5678ijkl').text, /\[secret masked\]/)
  assert.match(maskSecrets('postgres://user:supersecretpass@db:5432').text, /\[secret masked\]/)
})

test('GHSA-84q4 item 1: a URL password holding @ is masked whole; ports, npm scopes and git remotes stay readable', () => {
  const cases: [string, string][] = [
    ['postgres://admin:p@ss!word@db.local/x', 'postgres://admin:[secret masked]@db.local/x'],
    ['postgres://admin:hun@ter2xyz@db.local', 'postgres://admin:[secret masked]@db.local'],
    ['DATABASE_URL="mysql://root:Pa@ss@w0rd2024@db.example.com:3306/app"', 'DATABASE_URL="mysql://root:[secret masked]@db.example.com:3306/app"'],
    ['postgres://admin:p%40ss%2Fw0rd@db.local/x', 'postgres://admin:[secret masked]@db.local/x'],
  ]
  for (const [s, want] of cases) assert.equal(maskSecrets(s).text, want)
  for (const s of ['http://localhost:4873/@scope/pkg', 'https://example.com:8443/users/@alice', 'https://h:8080/a?mail=x@y.z', 'git+ssh://git@github.com:org/repo.git', 'git@github.com:org/repo.git', 'npm i @scope/pkg@1.2.3', 'https://registry.npmjs.org/@types%2fnode']) assert.equal(maskSecrets(s).text, s)
})

test('GHSA-84q4 item 2: maskDeep masks a value by its key; common keys stay readable unless the value is a secret', () => {
  const input = { host: 'db.local', password: 'hunter2hunter2', api_key: 'abcd1234efgh5678', env: { DB_PASSWORD: 'correcthorse', PATH: '/usr/bin' }, headers: { Authorization: 'Bearer abcdef1234567890xyz' } }
  assert.deepEqual(maskDeep({ type: 'tool_use', name: 'mcp__db__connect', input }), { type: 'tool_use', name: 'mcp__db__connect', input: { host: 'db.local', password: MASK, api_key: MASK, env: { DB_PASSWORD: MASK, PATH: '/usr/bin' }, headers: { Authorization: `Bearer ${MASK}` } } })
  const keep = { name: 'deploy', path: '/srv/app/config.yml', id: 'toolu_01ABCdef', file_path: '/a/b/token.ts', command: 'npm test -- --grep token', description: 'Rotate the token weekly', token_count: '1234', max_tokens: '4096', password_hint: 'the dog', secret: 'process.env.SECRET_KEY', tokenizer: 'cl100k_base', cache_key: 'user_42_profile' }
  assert.deepEqual(maskDeep(keep), keep)
  const ghp = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  assert.deepEqual(maskDeep({ command: `GITHUB_TOKEN=${ghp} gh pr list`, name: ghp }), { command: `GITHUB_TOKEN=${MASK} gh pr list`, name: MASK })
})
