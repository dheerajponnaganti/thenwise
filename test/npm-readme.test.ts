import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// @ts-expect-error a plain script with no types
import { absoluteLinks, relativeLinks } from '../scripts/npm-readme.mjs'

const RAW = 'https://raw.githubusercontent.com/dheerajponnaganti/thenwise/main/'
const PAGE = 'https://github.com/dheerajponnaganti/thenwise'

test('npm README: images go to raw files, links to GitHub pages, and the rest stays', () => {
  assert.equal(absoluteLinks('<img src="assets/readme/a.png" alt="x">'), `<img src="${RAW}assets/readme/a.png" alt="x">`)
  assert.equal(absoluteLinks('![x](./a.png)'), `![x](${RAW}a.png)`)
  assert.equal(absoluteLinks('<a href="LICENSE">l</a>'), `<a href="${PAGE}/blob/main/LICENSE">l</a>`)
  assert.equal(absoluteLinks('[t](docs/teams.md)'), `[t](${PAGE}/blob/main/docs/teams.md)`)
  assert.equal(absoluteLinks('[d](docker/)'), `[d](${PAGE}/tree/main/docker/)`)
  const same = '[a](https://x.dev/y) [b](#install) <img src="https://x.dev/i.png"> [m](mailto:a@b.dev)'
  assert.equal(absoluteLinks(same), same)
})

test('npm README: the real README ends with no relative link', () => {
  const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(relativeLinks(text).length > 0, 'the real README has relative links to rewrite')
  assert.deepEqual(relativeLinks(absoluteLinks(text)), [])
})
