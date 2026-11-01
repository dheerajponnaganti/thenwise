#!/usr/bin/env node
// Makes README.md work on npmjs.com, where relative links and images break. Run only on the throwaway release checkout:
//   node scripts/npm-readme.mjs
// It rewrites the file in place and exits 1 if a relative link is left.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'dheerajponnaganti/thenwise'
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`
const BLOB = `https://github.com/${REPO}/blob/main/`
const TREE = `https://github.com/${REPO}/tree/main/`

const isRelative = (url) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)
const page = (url) => (url.endsWith('/') ? TREE : BLOB) + url.replace(/^\.\//, '')

/** Images go to the raw file, other links to the page on GitHub. Absolute links and #anchors stay as they are. */
export function absoluteLinks(text) {
  return text
    .replace(/\bsrc="([^"]+)"/g, (all, url) => (isRelative(url) ? `src="${RAW}${url.replace(/^\.\//, '')}"` : all))
    .replace(/\bhref="([^"]+)"/g, (all, url) => (isRelative(url) ? `href="${page(url)}"` : all))
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, image, label, url) => (isRelative(url) ? `${image}[${label}](${image ? RAW + url.replace(/^\.\//, '') : page(url)})` : all))
}

/** The relative links still in the text. */
export function relativeLinks(text) {
  const urls = [...text.matchAll(/\b(?:src|href)="([^"]+)"/g), ...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
  return urls.filter(isRelative)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const file = resolve(fileURLToPath(import.meta.url), '../../README.md')
  const out = absoluteLinks(readFileSync(file, 'utf8'))
  const left = relativeLinks(out)
  if (left.length) {
    console.error(`npm-readme: relative links left: ${left.join(', ')}`)
    process.exit(1)
  }
  writeFileSync(file, out)
  console.log('npm-readme: all links are absolute')
}
