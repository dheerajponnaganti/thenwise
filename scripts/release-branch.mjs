// Builds dist/ and commits it, with the plugin files and src, to the local `release` branch.
// A plugin installs by cloning, so this branch is what users get. Never pushes. Usage: npm run release:branch
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = (args, env = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
const branch = process.env.RELEASE_BRANCH ?? 'release'
// Tests, benchmarks, fixtures and internal docs stay on main.
const NOT_SHIPPED = ['test', 'bench', 'fixtures', 'docs', 'scripts', '.github']

if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('commit your changes first')
execFileSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })

const tmp = mkdtempSync(join(tmpdir(), 'thenwise-release-'))
const env = { GIT_INDEX_FILE: join(tmp, 'index') }
try {
  const from = git(['rev-parse', 'HEAD'])
  git(['read-tree', from], env)
  git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', ...NOT_SHIPPED], env)
  git(['add', '-f', 'dist'], env)
  const tree = git(['write-tree'], env)
  let old = ''
  try { old = git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) } catch {}
  if (old && git(['rev-parse', `${old}^{tree}`]) === tree) console.log(`${branch} is up to date (${old.slice(0, 7)})`)
  else {
    const msg = `Release ${JSON.parse(git(['show', `${from}:package.json`])).version}, built from ${from.slice(0, 7)}`
    const commit = git(['commit-tree', tree, ...(old ? ['-p', old] : []), '-m', msg])
    git(['update-ref', `refs/heads/${branch}`, commit])
    console.log(`${branch} -> ${commit.slice(0, 7)}: ${msg}`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
