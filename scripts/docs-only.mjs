#!/usr/bin/env node
// Run by the changed job in ci.yml. Reads changed paths on stdin, one per line, and prints code=false when every one
// is docs only, so the test jobs can skip. Any other path, Markdown included, prints code=true.
//   git diff --name-only BASE HEAD | node scripts/docs-only.mjs

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only files no test, check or package reads. Tests read commands/, skills/, ARCHITECTURE.md, README.md, CHANGELOG.md
// and LICENSE, and plugin/ is what users install, so those are not listed.
const DOCS_ONLY = /^(docs\/.*|assets\/.*|\.github\/ISSUE_TEMPLATE\/.*|\.github\/pull_request_template\.md|(AGENTS|CLAUDE|CODE_OF_CONDUCT|CONTRIBUTING|RELEASING|ROADMAP|SECURITY)\.md|(bench|docker|fixtures)\/.*\.md)$/

/** True when a change to these paths needs the test jobs. */
export function needsTests(files) {
  return files.some((f) => f && !DOCS_ONLY.test(f))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`code=${needsTests(readFileSync(0, 'utf8').split(/\r?\n/))}`)
}
