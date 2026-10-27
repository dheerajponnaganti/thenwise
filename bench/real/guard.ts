// Edit-trap scenarios (Full Build Plan, Phase A): a task that walks into a real past dead end, run in a fresh clone.
// Pass = the change avoids the trap (checked on the diff or commit message, no model judge).
// Usage: node bench/real/guard.ts --arm grep|today --scenarios <scenarios.json> --out <guard.jsonl> [--model sonnet] [--run 1] [--jobs 2] [--ids gd-001,gd-002]

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { NO_PEEKING, norm } from './score.ts'

interface Guard {
  id: string
  repo: 'memory-v2' | 'carapace-logbook'
  commit: string
  task: string
  trap: string
  fail_if_diff?: string
  fail_if_commit_message?: string
  reason: string[][]
}

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? process.argv[i + 1]! : fallback
}
const arm = arg('arm')!
const out = arg('out')!
const model = arg('model', 'sonnet')!
const run = Number(arg('run', '1'))
const jobs = Number(arg('jobs', '2'))
// E4 arms: plain = no notes, no plugins; plugin = the same plus Thenwise over the frozen gate store (scope all, sync off).
if (!['grep', 'today', 'plain', 'plugin'].includes(arm) || !out || !arg('scenarios')) throw new Error('usage: --arm grep|today --scenarios <file> --out <guard.jsonl>')

const HOME = homedir()
const CORPUS = join(HOME, '.memory/eval/corpus')
const SOURCES: Record<Guard['repo'], string> = { 'memory-v2': join(HOME, 'memory-v2'), 'carapace-logbook': join(HOME, 'carapace') }
const ROOT = process.env.THENWISE_EVAL_ROOT
const GATE = ROOT ? join(ROOT, 'gate') : join(HOME, 'carapace-crew/eval-ws/gate')
const PLUGIN = ROOT ? join(ROOT, 'plugin') : join(GATE, 'plugin')
// No eval chat loads carapace: the owner's shell exports its plugin folder.
const { CLAUDE_CODE_PLUGIN_DIRS: _carapace, ...NO_CARAPACE } = process.env
const E4 = arm === 'plain' || arm === 'plugin'
const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run check:*)', ...(arm === 'plugin' ? ['mcp__plugin_thenwise_thenwise__*'] : [])]
const OFF_PLUGINS = Object.fromEntries(['swift-lsp@claude-plugins-official', 'cloudflare@cloudflare', 'ponytail@ponytail', 'impeccable@impeccable', 'typesafe@typesafe-ai', 'rasterless@dheeraj-skills'].map((p) => [p, false]))
const POINTER = `Project records you may read: the Obsidian vault of notes at ${CORPUS}/vault/ and the carapace pull requests at ${CORPUS}/prs.json.`
// Claude Code keys a project's auto memory by its folder path, with / . and _ turned into -.
const memoryDirFor = (dir: string) => join(HOME, '.claude/projects', dir.replace(/[/._]/g, '-'), 'memory')

function prepare(g: Guard): string {
  const dir = join(HOME, 'carapace-crew/eval-ws/guard', `${arm}-${g.id}-r${run}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['clone', '--quiet', SOURCES[g.repo], dir])
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', g.commit])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Dheeraj Ponnaganti'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'dheerajponnaganti@gmail.com'])
  // today: the owner's real auto memory, as his home-folder sessions see it.
  if (arm === 'today') cpSync(join(HOME, '.claude/projects/-Users-dheeraj/memory'), memoryDirFor(dir), { recursive: true })

  return dir
}

function ask(g: Guard, dir: string): Promise<{ answer: string; usage: Record<string, number>; turns?: number }> {
  return new Promise(resolve => {
    // E4 arms get no notes: no corpus pointer, no vault, no memory folder; the task goes on stdin.
    const e4 = ['--settings', JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '' }, enabledPlugins: OFF_PLUGINS }), ...(arm === 'plugin' ? ['--plugin-dir', PLUGIN] : [])]
    const child = spawn('claude', E4
      ? ['-p', '--output-format', 'json', '--model', model, '--permission-mode', 'acceptEdits', ...e4, '--allowedTools', ...TOOLS, '--disallowedTools', 'WebSearch', 'WebFetch', 'Agent', ...NO_PEEKING, 'Read(~/.memory/**)', 'Read(~/Library/Mobile Documents/**)', 'Read(~/carapace-crew/eval-ws/gate/**)', 'Read(~/carapace-crew/eval-ws/r0*/**)']
      : ['-p', g.task, '--output-format', 'json', '--model', model, '--permission-mode', 'acceptEdits', '--append-system-prompt', POINTER,
      '--allowedTools', ...TOOLS, '--disallowedTools', 'WebSearch', 'WebFetch', 'Agent', ...NO_PEEKING, '--add-dir', CORPUS], { cwd: dir, stdio: [E4 ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...NO_CARAPACE, ...(arm === 'plugin' ? { THENWISE_HOME: join(GATE, 'store'), THENWISE_SYNC: 'off' } : {}) } })
    if (E4) child.stdin!.end(g.task)
    let stdout = ''
    child.stdout!.on('data', d => (stdout += d))
    // Claude Code updates itself in place; for a moment the command is missing (ENOENT). Wait and ask again.
    let missing = false
    child.on('error', () => {
      missing = true
      setTimeout(() => resolve(ask(g, dir)), 15000)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      if (missing) return
      // The usage limit answers with a notice instead of an answer: wait for the reset and ask again.
      if (/hit your (session|usage|weekly) limit/i.test(stdout)) {
        missing = true
        setTimeout(() => resolve(ask(g, dir)), 5 * 60 * 1000)
        return
      }
      try {
        const r = JSON.parse(stdout) as { result?: string; usage?: Record<string, number>; num_turns?: number }
        resolve({ answer: r.result ?? '', usage: r.usage ?? {}, turns: r.num_turns })
      } catch {
        resolve({ answer: `[no answer: ${stdout.slice(0, 200)}]`, usage: {} })
      }
    })
  })
}

const raw = readFileSync(arg('scenarios')!)
const guards = (JSON.parse((arg('scenarios')!.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as { guard: Guard[] }).guard
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { id: string }).id) : [])
const ids = arg('ids')?.split(',')
const todo = guards.filter(g => !done.has(g.id) && (!ids || ids.includes(g.id)))
let next = 0
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < todo.length) {
    const g = todo[next++]!
    const dir = prepare(g)
    const started = Date.now()
    const r = await ask(g, dir)
    const diff = execFileSync('git', ['-C', dir, 'diff', g.commit], { encoding: 'utf8', maxBuffer: 1 << 26 })
    const messages = execFileSync('git', ['-C', dir, 'log', '--format=%B', `${execFileSync('git', ['-C', dir, 'rev-parse', g.commit], { encoding: 'utf8' }).trim()}..HEAD`], { encoding: 'utf8' })
    const trapped = (g.fail_if_diff !== undefined && new RegExp(g.fail_if_diff, 'mi').test(diff)) || (g.fail_if_commit_message !== undefined && messages.toLowerCase().includes(g.fail_if_commit_message))
    const text = norm(r.answer)
    const gaveReason = g.reason.every(alts => alts.some(p => text.includes(norm(p))))
    const u = r.usage
    const row = { id: g.id, arm, run, pass: !trapped, changed: diff.trim() !== '' || messages.trim() !== '', gaveReason, answer: r.answer, turns: r.turns, seconds: Math.round((Date.now() - started) / 1000),
      tokens: { in: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, out: u.output_tokens ?? 0 } }
    appendFileSync(out, `${JSON.stringify(row)}\n`)
    console.log(`${arm} ${g.id} ${row.pass ? 'avoided the trap' : 'TRAPPED'} ${gaveReason ? '(gave the reason)' : ''} ${row.seconds}s`)
  }
}))
