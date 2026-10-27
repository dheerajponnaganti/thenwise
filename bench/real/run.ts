// Asks the real-history questions in fresh `claude -p` sessions, one per question, and records answers and tokens.
// Usage: node bench/real/run.ts --arm grep|today --questions <file.jsonl.gz> --out <answers.jsonl> [--model sonnet] [--run 1] [--only even|odd] [--jobs 3] [--limit N]
// Arms: grep = a fresh folder that points at the frozen corpus (no memory of any kind); today = the owner's home folder
// with his real setup (CLAUDE.md files, Claude Code auto memory, his plugins); memory = grep plus the memory commands
// over the frozen evaluation graph (~/.memory/bin/memory). Tools are read only in all three.
// Gate arms (Standalone Plan, go or no-go): plain = plain Claude Code with no plugins and no notes, reading the two repos,
// their git history and PRs; plugin = the same plus the Thenwise plugin (built release clone) over a frozen store copy.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadJsonl, NO_PEEKING } from './score.ts'
import type { Answer, RealQuestion } from './score.ts'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? process.argv[i + 1]! : fallback
}
const arm = arg('arm')!
const out = arg('out')!
const model = arg('model', 'sonnet')!
const run = Number(arg('run', '1'))
const jobs = Number(arg('jobs', '3'))
if (!['grep', 'today', 'memory', 'plain', 'plugin'].includes(arm) || !out || !arg('questions')) throw new Error('usage: --arm grep|today|memory --questions <file> --out <answers.jsonl>')

const HOME = homedir()
const CORPUS = join(HOME, '.memory/eval/corpus')
// --set picks the frozen store and its records (see RECORDS).
const SET = arg('set', 'gate')!
// THENWISE_EVAL_ROOT holds one evaluation round: plugin/ (the built release) and one folder per set with its store.
const ROOT = process.env.THENWISE_EVAL_ROOT ?? join(HOME, 'carapace-crew/eval-ws')
const GATE = join(ROOT, SET)
const PLUGIN = process.env.THENWISE_EVAL_ROOT ? join(ROOT, 'plugin') : join(ROOT, 'gate/plugin')
// Each set names the repos and folders its questions come from. They name private projects, so they live outside the repo:
// { "<set>": { "text": "...", "dirs": ["~/..."] } } in ~/.memory/eval/records.json (or THENWISE_EVAL_RECORDS), with ~ for the home folder.
const RECORDS: Record<string, { text: string; dirs: string[] }> = JSON.parse(readFileSync(process.env.THENWISE_EVAL_RECORDS ?? join(HOME, '.memory/eval/records.json'), 'utf8').replaceAll('~/', `${HOME}/`))
const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git -C:*)', 'Bash(ls:*)', ...(arm === 'memory' ? [`Bash(${join(HOME, '.memory/bin/memory-eval')}:*)`] : []), ...(arm === 'plain' || arm === 'plugin' ? ['Bash(gh pr view:*)', 'Bash(gh pr list:*)'] : []), ...(arm === 'plugin' ? ['mcp__plugin_thenwise_thenwise__*'] : [])]
// Gate arms load no plugins and no carapace; the plugin arm adds Thenwise only.
const OFF_PLUGINS = Object.fromEntries(['swift-lsp@claude-plugins-official', 'cloudflare@cloudflare', 'ponytail@ponytail', 'impeccable@impeccable', 'typesafe@typesafe-ai', 'rasterless@dheeraj-skills'].map((p) => [p, false]))
export const MEMORY_BIN = join(HOME, '.memory/bin/memory-eval')
const MEMORY_HELP = `# Project memory: use it first
A memory of this project's whole history (chat turns, compaction summaries, PRs, commits, vault notes, rules) is searchable with one command. Use it FIRST for any question about why something is the way it is, what was tried, when something changed, what was current at a date, or how two things connect; then check details in the files if needed. Each result shows its source and date.
- ${MEMORY_BIN} search <words>
- ${MEMORY_BIN} current <topic>   (what holds now: PRs, commits and dated entries first, newest first)
- ${MEMORY_BIN} why <topic>
- ${MEMORY_BIN} tried <topic>
- ${MEMORY_BIN} asof <YYYY-MM-DD> <words>
- ${MEMORY_BIN} trace <file path, PR number, commit, note title or topic>
- ${MEMORY_BIN} resume [topic]
- ${MEMORY_BIN} path <a> <b>
- ${MEMORY_BIN} get <id>
If a search comes back thin, search again with other words.
The memory is a starting point, not the last word. When an answer has several parts (what, when, which PR or release, why, what came next), check each part: run another memory command for the part you have not seen yet, or open the note, PR or file it cites. Do not stop at the first result. For a question about a past date, use asof with that date and say what was current then, not what is current now. For what holds now, use current, and when a result says NEWER on this topic, read that newer record before answering; a PR or a dated log entry is the final word over earlier chat.

`
const PROMPT = (q: RealQuestion) => `${q.question}${q.as_of ? `\n(The question is about the state as of ${q.as_of}.)` : ''}

Answer from this project's own records (notes, PRs, git history, and anything else you can read here). Give the specific answer in a few sentences and name your sources (PR number, note name, commit or chat date). If the records do not answer it, say "not recorded" rather than guessing. Do not edit anything.`

function workspace(): { cwd: string; extra: string[] } {
  if (arm === 'today') return { cwd: HOME, extra: [] }
  if (arm === 'plain' || arm === 'plugin') {
    const ws = join(GATE, `ws-${arm}`)
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'CLAUDE.md'), `# Project records\n${RECORDS[SET]!.text}`)
    const settings = JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '' }, enabledPlugins: OFF_PLUGINS })

    return { cwd: ws, extra: ['--settings', settings, '--add-dir', ...RECORDS[SET]!.dirs, ...(arm === 'plugin' ? ['--plugin-dir', PLUGIN] : [])] }
  }
  const ws = join(HOME, 'carapace-crew/eval-ws', arm)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'CLAUDE.md'), `${arm === 'memory' ? MEMORY_HELP : ''}# Project records
The carapace project (a Claude Code plugin) and its Memory v2 work are recorded in:
- the Obsidian vault of notes: ${CORPUS}/vault/
- the carapace repository: ${HOME}/carapace (git history is squashed per release; details are in the PRs)
- the carapace pull requests with descriptions and comments: ${CORPUS}/prs.json
- the memory-v2 repository: ${HOME}/memory-v2 (one commit per phase)
`)

  return { cwd: ws, extra: ['--add-dir', `${CORPUS}/vault`, CORPUS, join(HOME, 'carapace'), join(HOME, 'memory-v2')] }
}

function ask(q: RealQuestion): Promise<Answer> {
  const { cwd, extra } = workspace()
  const started = Date.now()

  return new Promise(resolve => {
    // The prompt goes on stdin: a trailing prompt argument would be read as one more --disallowedTools entry.
    const gate = arm === 'plain' || arm === 'plugin'
    const deny = [...NO_PEEKING, ...(gate ? ['Read(~/.memory/**)', 'Read(~/Library/Mobile Documents/**)', 'Read(~/carapace-crew/**)'] : [])]
    const child = spawn('claude', ['-p', ...(gate ? [] : [PROMPT(q)]), '--output-format', 'json', '--model', model, ...extra, '--allowedTools', ...READ_ONLY,
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Agent', ...deny], { cwd, stdio: [gate ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...NO_CARAPACE, ...(arm === 'plugin' ? { THENWISE_HOME: join(GATE, 'store'), THENWISE_SYNC: 'off' } : {}) } })
    if (gate) child.stdin!.end(PROMPT(q))
    let stdout = ''
    child.stdout!.on('data', d => (stdout += d))
    // Claude Code updates itself in place; for a moment the command is missing (ENOENT). Wait and ask again.
    let missing = false
    child.on('error', () => {
      missing = true
      setTimeout(() => resolve(ask(q)), 15000)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      if (missing) return
      // The usage limit answers with a notice instead of an answer: wait for the reset and ask again.
      if (/hit your (session|usage|weekly) limit/i.test(stdout)) {
        missing = true
        setTimeout(() => resolve(ask(q)), 5 * 60 * 1000)
        return
      }
      let r: { result?: string; usage?: Record<string, number>; total_cost_usd?: number; num_turns?: number } = {}
      try {
        r = JSON.parse(stdout)
      } catch {
        r = { result: `[no answer: ${stdout.slice(0, 200)}]` }
      }
      const u = r.usage ?? {}
      resolve({ id: q.id, arm, run, answer: r.result ?? '', costUsd: r.total_cost_usd, turns: r.num_turns, seconds: Math.round((Date.now() - started) / 1000),
        tokens: { in: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, out: u.output_tokens ?? 0 } })
    })
  })
}

// No eval chat loads carapace: the owner's shell exports its plugin folder.
const { CLAUDE_CODE_PLUGIN_DIRS: _carapace, ...NO_CARAPACE } = process.env

const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as Answer).id) : [])
const only = arg('only')
let todo = loadJsonl<RealQuestion>(arg('questions')!).filter(q => !done.has(q.id))
if (only) todo = todo.filter(q => (Number(q.id.replace(/\D/g, '')) % 2 === 0) === (only === 'even'))
todo = todo.slice(0, Number(arg('limit', '100000')))

let next = 0
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < todo.length) {
    const q = todo[next++]!
    const a = await ask(q)
    appendFileSync(out, `${JSON.stringify(a)}\n`)
    console.log(`${arm} ${q.id} ${a.seconds}s ${a.turns ?? '?'} turns`)
  }
}))
