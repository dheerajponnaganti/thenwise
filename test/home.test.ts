import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { cloudWarning, expandHome, resolveDataDir } from '../src/core/home.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'tw-home-'))

test('data folder order: THENWISE_HOME, MEMORY_HOME, ~/.thenwise, ~/.memory, default ~/.thenwise', () => {
  const h = fresh()
  assert.equal(resolveDataDir(h, {}), join(h, '.thenwise'))
  mkdirSync(join(h, '.memory'))
  assert.equal(resolveDataDir(h, {}), join(h, '.memory'))
  mkdirSync(join(h, '.thenwise'))
  assert.equal(resolveDataDir(h, {}), join(h, '.thenwise'))
  assert.equal(resolveDataDir(h, { MEMORY_HOME: '/m' }), '/m')
  assert.equal(resolveDataDir(h, { MEMORY_HOME: '/m', THENWISE_HOME: '/t' }), '/t')
  assert.equal(resolveDataDir(h, { THENWISE_HOME: '~/x' }), join(h, 'x'))
})

test('cloud folders get a warning, local ones do not', () => {
  for (const p of ['/Users/a/Library/Mobile Documents/com~apple~CloudDocs/.thenwise', '/Users/a/Library/CloudStorage/OneDrive-X/.thenwise', '/Users/a/Dropbox/.thenwise', 'C:\\Users\\a\\OneDrive\\.thenwise', '/Users/a/Google Drive/x']) assert.match(cloudWarning(p) ?? '', /synced folder/, p)
  for (const p of ['/Users/a/.thenwise', '/home/a/.memory', '/Users/a/Dropboxes/x']) assert.equal(cloudWarning(p), null, p)
})

test('expandHome handles both slashes and leaves other paths alone', () => {
  assert.equal(expandHome('~', '/h'), '/h')
  assert.equal(expandHome('~/a', '/h'), join('/h', 'a'))
  assert.equal(expandHome('~\\a', '/h'), join('/h', 'a'))
  assert.equal(expandHome('/x/~y', '/h'), '/x/~y')
})
