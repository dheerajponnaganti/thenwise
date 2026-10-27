import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MASK_VERSION, maskSecrets } from '../src/core/secrets.ts'

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
