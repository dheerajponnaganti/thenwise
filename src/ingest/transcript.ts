// Parse one (already masked) Claude Code transcript into sessions, turns, compaction summaries and tool facts.

import { createHash } from 'node:crypto'
import { commandParts, isTestRun } from '../core/testrun.ts'
import { posix } from 'node:path'
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { normPath } from '../core/vault-index.ts'

export interface Turn {
  id: string
  at: string
  prompt: string
  reply: string[]
  /** The subagent reports also in `reply`, so a caller that must not carry tool output can take them out. */
  agentReports: string[]
  reads: Set<string>
  edits: Set<string>
  ran: Set<string> // paths that appear in Bash commands
  commitMsgs: { subject: string; at: string }[] // first -m line of each `git commit`
  commitShas: Set<string> // short shas printed by `git commit`
  prUrls: Set<string> // urls printed by `gh pr create`
  /** Each file change as hashes of the text before and after (no text kept), in order: an undo shows as a hash coming back. */
  changes: { file: string; oldHash: string; newHash: string; at: string }[]
  /** Each test run, its command (cut to 200 characters) and whether it failed. */
  tests: { at: string; failed: boolean; cmd?: string }[]
  /** The tool stopped this turn: a usage or rate limit, or an API error. Its text is not part of the reply. */
  cutOff?: { at: string; text: string }
}
export interface Summary {
  id: string
  at: string
  text: string
  continuedFrom: string | null
}
export interface Session {
  id: string
  cwd: string
  entrypoint: string
  start: string
  end: string
  turns: Turn[]
  summaries: Summary[]
  paths: Set<string> // every path any tool call touched
  capped: number // rows stamped later than the file's change time (plus a day) or now, moved back to the file time
  sub: boolean // a subagent file: its turns belong to session `id`, which is the parent
  /** The last tool call of the last turn that never got a result: the chat stopped mid-step. */
  openCall?: { name: string; detail: string; at: string }
  /** What the chat cost, from the tool's own running total: tokens always, dollars only where the tool gives them. */
  cost?: Cost
  /** The running total over time, one entry per change: [time, dollars or null, input, cached, output]. A window of time
   * costs the last total minus the total just before it. */
  costs?: [string, number | null, number, number, number][]
}

export interface Cost { usd?: number; input: number; cached: number; output: number }
interface CostRun { base: Cost; last: Cost | undefined; start: unknown }
const plus = (a: Cost, b: Cost): Cost => ({ ...(a.usd !== undefined || b.usd !== undefined ? { usd: (a.usd ?? 0) + (b.usd ?? 0) } : {}), input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output })
/** One running-total row into the chat's cost. A resumed chat restarts its total (a new start time, or a total that went
 * down), so the run before it is carried as a base. Rows after the cutoff never reach here. */
function addCost(s: Session, run: CostRun, c: Cost, start: unknown, at: string) {
  if (run.last && (start !== run.start || c.input + c.cached + c.output < run.last.input + run.last.cached + run.last.output)) run.base = plus(run.base, run.last)
  run.last = c
  run.start = start
  const total = plus(run.base, c)
  // Dollars count only while every row was priced: one unpriced run leaves the chat without a dollar figure.
  if (c.usd === undefined || (s.cost && s.cost.usd === undefined)) delete total.usd
  const prev = s.costs?.at(-1)
  if (!prev || prev[1] !== (total.usd ?? null) || prev[2] !== total.input || prev[3] !== total.cached || prev[4] !== total.output) (s.costs ??= []).push([at, total.usd ?? null, total.input, total.cached, total.output])
  s.cost = total
}
/** A running-total row: Claude Code's `cost-state` (dollars and tokens per model), or the same row the Codex converter makes
 * from its `token_count` (tokens only). Dollars are left out when Claude Code could not price a model. */
export function costOf(d: Record<string, any>): Cost | undefined {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  if (d.modelUsage && typeof d.modelUsage === 'object') {
    const m = Object.values(d.modelUsage) as Record<string, unknown>[]
    const sum = (k: string) => m.reduce((a, x) => a + n(x?.[k]), 0)
    // Thinking is counted inside outputTokens (on 2,820 real entries it never exceeded it), so it is not added again.
    return { ...(typeof d.totalCostUSD === 'number' && !d.hasUnknownModelCost ? { usd: d.totalCostUSD } : {}), input: sum('inputTokens') + sum('cacheCreationInputTokens'), cached: sum('cacheReadInputTokens'), output: sum('outputTokens') }
  }
  if (d.tokens && typeof d.tokens === 'object') return { input: n(d.tokens.input), cached: n(d.tokens.cached), output: n(d.tokens.output) }
  return undefined
}

const BASH_PATH = /(?:^|[\s"'=:(])((?:~|\/Users|\/home|\/root)\/[^\s"'`;|&)<>]+|[A-Za-z]:[\\/][^\s"'`;|&)<>]+)/g
const BASH_ABS = /(?:^|[\s"'=(])(\/[^\s"'`;|&)<>]+)/g
// src/a.ts or ./a/b.py: a folder and a file with an extension. github.com/x/y.git is a site, not a folder.
const BASH_REL = /(?:^|[\s"'=(])((?:\.\.?\/)?[\w.@-]+(?:\/[\w.@+-]+)*\/[\w.@+-]+\.[A-Za-z]\w{0,7})(?=$|[\s"'`;|&)<>:,])/g
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/
const GIT_COMMIT = /\bgit(?:\s+(?:-[cC]\s+\S+|--\S+))*\s+commit\b/
// What git prints for a commit it made: `[main 1a2b3c4] Subject`, `[main (root-commit) ...]`, `[detached HEAD ...]`.
const COMMIT_LINE = /\[(?:detached HEAD|[\w./-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\](?: (.+))?/g
// What git prints when it commits nothing. Seen even when `|| true` or a later command hides the failed exit code.
const GIT_FAILED = /^(?:fatal|error): |^nothing (?:added )?to commit|^no changes added to commit|^Aborting commit/m
const GH_PR = /\bgh\s+pr\s+create\b/
// Output that shows a command ran at all, which proves every test before it in an && chain passed. A commit line or git's
// own refusal; a PR url or gh's own refusal. A bare `fatal:` or `error:` is no proof: a failing test prints those too
// (`cargo test` ends with `error: test failed`, and tests that run git echo its `fatal:` lines).
const RAN = {
  commit: new RegExp(`${COMMIT_LINE.source}|^(?:nothing (?:added )?to commit|no changes added to commit|Aborting commit)`, 'm'),
  pr: /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|^(?:pull request create failed|a pull request for branch .* already exists|No commits between|could not find any commits between|aborted: you must first push)/m,
}
/** For each test part of a command, the commands after it in its && chain whose output can show they ran: `b` in
 * `a && b` runs only if `a` passed. Undefined when some test part has none, since then its result is only the exit code.
 * Past a `;`, `||` or `|` nothing is known: the next command runs whether the test passed or not (or, for `|`, the
 * pipeline's exit code is the last command's). */
function testProof(cmd: string): ('commit' | 'pr')[][] | undefined {
  const parts = commandParts(cmd)
  const proof: ('commit' | 'pr')[][] = []
  for (const [i, p] of parts.entries()) {
    if (!isTestRun(p.text)) continue
    const after: ('commit' | 'pr')[] = []
    for (let j = i; parts[j]!.op === '&&' && j + 1 < parts.length; j++) {
      const next = parts[j + 1]!.text
      if (GIT_COMMIT.test(next)) after.push('commit')
      else if (GH_PR.test(next)) after.push('pr')
    }
    if (!after.length) return undefined
    proof.push(after)
  }
  return proof.length ? proof : undefined
}
const TAGS = 'local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|command-message|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|ide_opened_file|ide_selection|ide_diagnostics'
const WRAPPER = new RegExp(`^<(${TAGS})>[\\s\\S]*?</\\1>\\s*`)
const WRAPPER_OPEN = new RegExp(`^<(${TAGS})>`)
const AGENT_TOOLS = /^(Agent|Task)$/
/** A subagent's report without the tool's own bookkeeping: a background launch is only an acknowledgement (no report),
 * and neither is a pointer to a report sent as a message; a report ends with its agent id and usage, which are not what
 * the subagent found. */
export const agentReport = (out: string): string =>
  /^\s*(Async agent launched successfully\b|This agent's report was delivered to you as a message\b)/.test(out)
    ? ''
    : out.replace(/<usage>[\s\S]*?<\/usage>/g, '').split('\n').filter((l) => !/^agentId: \S+ \(/.test(l) && !/^\s*\[Harness note\b/.test(l)).join('\n').trim()
// A short fingerprint of edited text: an edit that puts back an earlier one's old text is found by it. It protects nothing.
const h = (s: unknown) => (typeof s === 'string' ? createHash('sha256').update(s).digest('hex').slice(0, 16) : '')
const TRANSCRIPT_REF = /read the full transcript at:\s*(\S+?\.jsonl)/i

export function normalizePath(path: string, home: string, cwd = '/'): string {
  const p = normPath(path)
  const abs = p.startsWith('~/') ? posix.join(normPath(home), p.slice(2)) : p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : posix.join(normPath(cwd) || '/', p)

  return posix.normalize(abs).replace(/\/+$/, '') || '/'
}

export function bashPaths(cmd: string, home: string, cwd = ''): string[] {
  const out = new Set<string>()
  for (const m of cmd.matchAll(BASH_PATH)) {
    const p = m[1]!.replace(/[.,:]+$/, '')
    if (p.length > 3 && !p.endsWith('/')) out.add(normalizePath(p, home))
  }
  if (!cwd) return [...out]
  // Other paths need the folder the command ran in: a `cd` leading the command, else the chat's own.
  const top = normPath(cwd)
  for (const m of cmd.matchAll(BASH_ABS)) {
    const p = m[1]!.replace(/[.,:]+$/, '')
    if (p.startsWith(`${top}/`)) out.add(normalizePath(p, home))
  }
  const cd = LEADING_CD.exec(cmd)?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
  const base = cd ? normalizePath(cd, home, cwd) : cwd
  for (const m of cmd.matchAll(BASH_REL)) if (!/^[\w-]+\.[\w.-]+\//.test(m[1]!)) out.add(normalizePath(m[1]!, home, base))

  return [...out]
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : ''

function promptText(content: unknown): string | null {
  let t: string
  if (typeof content === 'string') t = content
  else if (Array.isArray(content) && content.length && !content.some((b: any) => b?.type === 'tool_result')) t = textOf(content.filter((b: any) => b?.type === 'text'))
  else return null
  t = t.trim()
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)
  if (t.startsWith('<') && cmd?.[1]) {
    // A typed slash command: "/review args" is the prompt.
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()

    return args ? `${cmd[1]} ${args}` : cmd[1]
  }
  // System and editor wrappers are not prompts; text after them is. Any other "<..." (say "<div>") is the user's.
  for (let m: RegExpExecArray | null; (m = WRAPPER.exec(t)); ) t = t.slice(m[0].length).trim()

  return !t || WRAPPER_OPEN.test(t) || t.startsWith('[Request interrupted') ? null : t
}

/** The text of an archived chat. An empty file is a chat with nothing in it yet: a chat holds nothing for a moment when it starts. */
export const chatText = (gz: Buffer): string => (gz.length ? gunzipSync(gz).toString('utf8') : '')

const WINDOW = 8 << 20 // compressed bytes read at once: more than one archive member
/** The size of a gzip file's last member, from its trailer. */
export function lastMemberSize(path: string): number {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const tail = Buffer.alloc(4)
    readSync(fd, tail, 0, 4, Math.max(0, size - 4))

    return tail.readUInt32LE(0)
  } finally {
    closeSync(fd)
  }
}

/**
 * The lines of a gzipped chat file, one gzip member at a time and with no string of the whole file: a long chat can be hundreds of MB,
 * and as one string it costs several times that. Node has no sync gunzip in parts, but the archive writes members of about 4 MB.
 */
export function* chatLines(path: string): Generator<string> {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const last = size >= 4 ? lastMemberSize(path) : 0
    // A large last member means a chat written whole by an older version: read it whole, once, in place of doubling up to it.
    let buf = Buffer.allocUnsafe(Math.min(size, last > WINDOW ? size : WINDOW))
    let carry: Buffer = Buffer.alloc(0)
    for (let at = 0; at < size;) {
      const got = readSync(fd, buf, 0, buf.length, at)
      // Only the plain 10-byte header gzipSync writes is walked; anything else goes through gunzip whole.
      if (buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8 || buf[3] !== 0) {
        const rest = Buffer.allocUnsafe(size - at)
        readSync(fd, rest, 0, rest.length, at)
        carry = Buffer.concat([carry, gunzipSync(rest)])
        break
      }
      let out: { buffer: Buffer; engine: { bytesWritten: number } }
      try {
        out = inflateRawSync(buf.subarray(10, got), { info: true, chunkSize: Math.max(1 << 16, Math.min(last + 1, 1 << 30)) }) as never
      } catch (e) {
        // The member runs past what was read: read more. Past the end of the file, it is broken.
        if ((e as NodeJS.ErrnoException).code !== 'Z_BUF_ERROR' || at + got >= size) throw e
        buf = Buffer.allocUnsafe(Math.min(size - at, buf.length * 2))
        continue
      }
      const end = 10 + out.engine.bytesWritten
      if (end + 8 > got) {
        // The trailer is past what was read.
        if (at + got >= size) throw new Error('unexpected end of file')
        buf = Buffer.allocUnsafe(Math.min(size - at, buf.length * 2))
        continue
      }
      if (crc32(out.buffer) !== buf.readUInt32LE(end)) throw new Error('incorrect data check')
      at += end + 8
      let from = 0
      for (let nl = out.buffer.indexOf(10); nl !== -1; from = nl + 1, nl = out.buffer.indexOf(10, from)) {
        // A line can cross members, and a character can too, so the bytes are joined before decoding.
        yield carry.length ? Buffer.concat([carry, out.buffer.subarray(from, nl)]).toString('utf8') : out.buffer.toString('utf8', from, nl)
        carry = Buffer.alloc(0)
      }
      carry = Buffer.concat([carry, out.buffer.subarray(from)])
    }
    let from = 0
    for (let nl = carry.indexOf(10); nl !== -1; from = nl + 1, nl = carry.indexOf(10, from)) yield carry.toString('utf8', from, nl)
    if (from < carry.length) yield carry.toString('utf8', from)
  } finally {
    closeSync(fd)
  }
}

/** `until` (ISO) drops every entry stamped after it. */
/** `sub`: a subagent file, whose lines are all sidechain and whose turns attach to the parent session `id`. */
export function parseSession(text: string | Iterable<string>, id: string, home: string, until = '', sub = false, fileMs = 0): Session {
  const limit = fileMs ? Math.min(fileMs + 864e5, Date.now()) : Infinity
  const cut = until ? Date.parse(until) : Infinity
  const s: Session = { id, cwd: '', entrypoint: '', start: '', end: '', turns: [], summaries: [], paths: new Set(), capped: 0, sub }
  let lastAt = ''
  let pastCut = false
  const run: CostRun = { base: { input: 0, cached: 0, output: 0 }, last: undefined, start: undefined }
  // `cmd` is a test run the call makes, whatever else it does: `npm test && git commit` is a commit and a test run.
  const pending = new Map<string, { turn: Turn; kind: 'commit' | 'pr' | 'agent' | 'test' | 'edit'; at?: string; cmd?: string; msg?: Turn['commitMsgs'][number]; pr?: boolean; proof?: ('commit' | 'pr')[][]; file?: string; changes?: Turn['changes'] }>()
  // Edit calls per turn and file still standing: a failed call (denied, or its text not found) changed nothing.
  const editCalls = new Map<Turn, Map<string, number>>()
  const open = new Map<string, { turn: Turn; name: string; detail: string; at: string }>() // tool calls with no result yet
  let turn: Turn | null = null
  for (const line of typeof text === 'string' ? text.split('\n') : text) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    // A line's time dates the cost row after it, which carries none of its own; once a line is past the cutoff, so is
    // every cost row after it.
    if (typeof d?.timestamp === 'string') Date.parse(d.timestamp) > cut ? (pastCut = true) : (lastAt = d.timestamp)
    if (d?.type === 'cost-state') {
      const c = costOf(d)
      if (c && lastAt && !pastCut) addCost(s, run, c, d.startTime, lastAt)
      continue
    }
    if (!d || typeof d !== 'object' || (d.type !== 'user' && d.type !== 'assistant') || (d.isSidechain && !sub)) continue
    if (typeof d.timestamp === 'string' && Date.parse(d.timestamp) > limit) {
      d.timestamp = new Date(fileMs).toISOString() // a clock that ran ahead must not outrank real rows
      s.capped++
    }
    if (typeof d.timestamp === 'string' && Date.parse(d.timestamp) > cut) continue
    if (!s.entrypoint && typeof d.entrypoint === 'string') s.entrypoint = d.entrypoint
    if (!s.cwd && typeof d.cwd === 'string') s.cwd = d.cwd
    if (typeof d.timestamp === 'string') {
      if (!s.start || d.timestamp < s.start) s.start = d.timestamp
      if (d.timestamp > s.end) s.end = d.timestamp
    }
    const content = d.message?.content
    if (d.type === 'user') {
      if (d.isCompactSummary) {
        const t = textOf(content)
        s.summaries.push({ id: d.uuid, at: d.timestamp ?? '', text: t, continuedFrom: TRANSCRIPT_REF.exec(t)?.[1]?.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? null })
        continue
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') open.delete(b.tool_use_id)
          const hit = b?.type === 'tool_result' ? pending.get(b.tool_use_id) : undefined
          if (!hit) continue
          if (hit.kind === 'edit') {
            // One result answers a patch that became one edit per file (ids <call>, <call>#1, ...).
            for (let j = 0; ; j++) {
              const id = j ? `${b.tool_use_id}#${j}` : b.tool_use_id
              const e = pending.get(id)
              if (e?.kind !== 'edit') break
              pending.delete(id)
              if (b.is_error !== true) continue
              const n = (editCalls.get(e.turn)?.get(e.file!) ?? 1) - 1
              editCalls.get(e.turn)?.set(e.file!, n)
              if (n <= 0) e.turn.edits.delete(e.file!)
              e.turn.changes = e.turn.changes.filter((c) => !e.changes!.includes(c))
            }
            continue
          }
          const out = textOf(b.content)
          // A nonzero exit is the tests' only when no later command in their && chain shows it ran.
          const passed = !!hit.proof?.every((after) => after.some((k) => RAN[k].test(out)))
          if (hit.cmd) hit.turn.tests.push({ at: hit.at ?? hit.turn.at, failed: b.is_error === true && !passed, cmd: hit.cmd })
          if (hit.kind === 'agent') {
            const report = agentReport(out).slice(0, 8000) // a subagent's report to the turn that asked
            if (report) (hit.turn.reply.push(report), hit.turn.agentReports.push(report))
          }
          else if (hit.kind === 'commit') {
            const made = [...out.matchAll(COMMIT_LINE)]
            // The typed -m subject stands for the first commit git prints; any later commit in the call keeps git's subject.
            for (const [i, m] of made.entries()) {
              hit.turn.commitShas.add(m[1]!)
              if (m[2]?.trim() && !(i === 0 && hit.msg)) hit.turn.commitMsgs.push({ subject: m[2].trim(), at: hit.at! })
            }
            // No commit printed and git or the call failed: nothing was committed, so the typed subject goes. A quiet
            // commit prints no line and keeps it.
            if (hit.msg && !made.length && (b.is_error === true || GIT_FAILED.test(out))) hit.turn.commitMsgs = hit.turn.commitMsgs.filter((c) => c !== hit.msg)
          }
          if (hit.pr) for (const m of out.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) hit.turn.prUrls.add(m[0])
        }
      }
      const p = d.isMeta ? null : promptText(content)
      if (p && typeof d.uuid === 'string') {
        turn = { id: d.uuid, at: d.timestamp ?? '', prompt: p, reply: [], agentReports: [], reads: new Set(), edits: new Set(), ran: new Set(), commitMsgs: [], commitShas: new Set(), prUrls: new Set(), changes: [], tests: [] }
        s.turns.push(turn)
      }
    } else if (d.isApiErrorMessage === true) {
      // "You've hit your session limit · resets 10pm": the tool stopped the turn. Not a reply, and never searched as one.
      if (turn) turn.cutOff = { at: d.timestamp ?? turn.at, text: textOf(content).replace(/\s+/g, ' ').trim().slice(0, 160) }
    } else if (typeof content === 'string') {
      if (turn && content) (delete turn.cutOff, turn.reply.push(content)) // work after an error means the turn went on
    } else if (Array.isArray(content)) {
      if (turn && content.length) delete turn.cutOff
      for (const b of content) {
        if (b?.type === 'text' && turn && typeof b.text === 'string') turn.reply.push(b.text)
        if (b?.type !== 'tool_use') continue
        const inp = b.input ?? {}
        const file = inp.file_path ?? inp.notebook_path
        if (turn && typeof b.id === 'string') open.set(b.id, { turn, name: String(b.name), detail: String(typeof inp.command === 'string' ? inp.command : (file ?? '')).replace(/\s+/g, ' ').slice(0, 120), at: d.timestamp ?? turn.at })
        if (typeof file === 'string') {
          const p = normalizePath(file, home, s.cwd || '/')
          s.paths.add(p)
          const edit = /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name)
          if (turn) (b.name === 'Read' ? turn.reads : edit ? turn.edits : turn.reads).add(p)
          const at = d.timestamp ?? turn?.at ?? ''
          const made: Turn['changes'] = []
          if (turn && b.name === 'Edit') made.push({ file: p, oldHash: h(inp.old_string), newHash: h(inp.new_string), at })
          if (turn && b.name === 'MultiEdit' && Array.isArray(inp.edits)) for (const e of inp.edits) made.push({ file: p, oldHash: h(e?.old_string), newHash: h(e?.new_string), at })
          if (turn && b.name === 'Write') made.push({ file: p, oldHash: '', newHash: h(inp.content), at })
          if (turn) turn.changes.push(...made)
          if (turn && edit && typeof b.id === 'string') {
            const calls = editCalls.get(turn) ?? editCalls.set(turn, new Map()).get(turn)!
            calls.set(p, (calls.get(p) ?? 0) + 1)
            pending.set(b.id, { turn, kind: 'edit', file: p, changes: made })
          }
        }
        if (turn && AGENT_TOOLS.test(b.name)) pending.set(b.id, { turn, kind: 'agent' })
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          for (const p of bashPaths(inp.command, home, s.cwd)) {
            s.paths.add(p)
            turn?.ran.add(p)
          }
          // One entry per call, whatever it combines: `npm test && git commit && gh pr create` is a test run, a commit and a PR.
          const cmd = isTestRun(inp.command) ? inp.command.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
          const pr = GH_PR.test(inp.command)
          const commit = GIT_COMMIT.exec(inp.command)
          let typed: Turn['commitMsgs'][number] | undefined
          if (turn && commit) {
            const tail = inp.command.slice(commit.index)
            const m = /\s-[a-zA-Z]*m\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(tail)
            // An -m past the end of this git command is another command's: `git commit -F f && python -m pytest`.
            const own = m && !/[;&|\n]/.test(tail.slice(0, m.index).replace(/"[^"]*"|'[^']*'/g, ''))
            const msg = own ? (m[1] ?? m[2] ?? m[3] ?? '').split('\n') : ['']
            // -m "$(cat <<'EOF' ... EOF)": the subject is the first line after the heredoc opener.
            const subject = (/^\$\(cat\s*<</.test(msg[0]!) ? (msg.slice(1).find((l) => l.trim()) ?? '') : msg[0]!).trim()
            // -F file, --amend or an editor: the subject comes from what git prints. A typed subject is kept now, so a
            // commit whose result never came still counts; a result that shows the commit failed takes it back.
            if (subject) turn.commitMsgs.push((typed = { subject, at: d.timestamp ?? turn.at }))
          }
          if (turn && (cmd || pr || commit)) pending.set(b.id, { turn, kind: commit ? 'commit' : pr ? 'pr' : 'test', at: d.timestamp ?? turn.at, cmd, msg: typed, pr, ...(cmd ? { proof: testProof(inp.command) } : {}) })
        }
      }
    }
  }
  const last = s.turns.at(-1)
  const stuck = [...open.values()].filter((o) => o.turn === last).pop()
  if (stuck) s.openCall = { name: stuck.name, detail: stuck.detail, at: stuck.at }

  return s
}
