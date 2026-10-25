// Cost report over the masked archive: for each interactive session, turns, model calls, tokens, a weighted total,
// and how often the memory was used. A measuring tool only: no model calls, no tuning.
// Usage: node bench/cost/report.ts [--since <ISO>] [--archive <dir>]

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { globMatch, loadConfig } from '../../src/ingest/config.ts'
import { parseSession } from '../../src/ingest/transcript.ts'

export interface SessionCost {
  session: string
  project: string
  start: string
  turns: number
  calls: number // distinct assistant message ids
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  weighted: number // input + 0.1 * cacheRead + 1.25 * cacheWrite + 5 * output
  memoryCalls: number // Bash calls that ran the memory command
  credits: number // replies containing a memory credit marker
}

const MEMORY_CMD = /(?:^|[\s;&|(`])memory\s/
export const weighted = (u: { input: number; cacheRead: number; cacheWrite: number; output: number }) => u.input + 0.1 * u.cacheRead + 1.25 * u.cacheWrite + 5 * u.output

/** Totals for one transcript. A message id repeats once per content block; it counts once, with its largest usage. */
export function costOf(text: string, session: string, project = '', home = '/'): SessionCost {
  const s = parseSession(text, session, home)
  const usage = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>()
  const credited = new Set<string>()
  const bashIds = new Set<string>()
  let memoryCalls = 0
  for (const line of text.split('\n')) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const m = d?.message
    if (d?.type !== 'assistant' || !m || typeof m.id !== 'string') continue
    const u = m.usage ?? {}
    const cur = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    const old = usage.get(m.id)
    if (!old || cur.output > old.output) usage.set(m.id, cur)
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.includes('[memory:')) credited.add(m.id)
      if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && !bashIds.has(b.id) && (MEMORY_CMD.test(b.input.command) || b.input.command.includes('.memory/bin/memory'))) (bashIds.add(b.id), memoryCalls++)
    }
  }
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const u of usage.values()) (t.input += u.input, t.cacheRead += u.cacheRead, t.cacheWrite += u.cacheWrite, t.output += u.output)

  return { session, project, start: s.start, turns: s.turns.length, calls: usage.size, ...t, weighted: weighted(t), memoryCalls, credits: credited.size }
}

// Cost is measured on chats a person typed in; ingest also takes headless and SDK chats now.
const INTERACTIVE = ['cli', 'claude-vscode']
/** Interactive sessions of the archive (entrypoints and exclusions as in ingest), optionally from a date on. */
export function report(archiveDir: string, since = ''): { sessions: SessionCost[]; total: SessionCost } {
  const cfg = loadConfig()
  const sessions: SessionCost[] = []
  if (existsSync(archiveDir)) {
    for (const key of readdirSync(archiveDir).sort()) {
      if (cfg.ingestExcludeProjects.some((g) => globMatch(g, key)) || cfg.excludeProjects.some((g) => globMatch(g, key))) continue
      for (const f of readdirSync(join(archiveDir, key)).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
        const text = gunzipSync(readFileSync(join(archiveDir, key, f))).toString('utf8')
        const s = parseSession(text, '', cfg.home)
        if (!INTERACTIVE.includes(s.entrypoint) || !s.start || (since && Date.parse(s.start) < Date.parse(since))) continue
        sessions.push(costOf(text, f.replace(/\.jsonl\.gz$/, ''), key, cfg.home))
      }
    }
  }
  sessions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.session < b.session ? -1 : 1))
  const total: SessionCost = { session: 'total', project: '', start: '', turns: 0, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, weighted: 0, memoryCalls: 0, credits: 0 }
  for (const s of sessions) for (const k of ['turns', 'calls', 'input', 'cacheRead', 'cacheWrite', 'output', 'weighted', 'memoryCalls', 'credits'] as const) total[k] += s[k]

  return { sessions, total }
}

export function table(r: { sessions: SessionCost[]; total: SessionCost }): string {
  const cols = ['session', 'start', 'turns', 'calls', 'input', 'cacheRead', 'cacheWrite', 'output', 'weighted', 'memoryCalls', 'credits'] as const
  const cell = (s: SessionCost, c: (typeof cols)[number]) => (c === 'session' ? s.session.slice(0, 8) : c === 'start' ? s.start.slice(0, 16) : c === 'weighted' ? Math.round(s.weighted).toString() : String(s[c]))
  const rows = [...r.sessions, r.total].map((s) => cols.map((c) => cell(s, c)))
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((x) => x[i]!.length)))
  const fmt = (x: string[]) => x.map((v, i) => (i < 2 ? v.padEnd(w[i]!) : v.padStart(w[i]!))).join('  ')

  return [fmt([...cols]), ...rows.map(fmt)].join('\n')
}

export const summary = (t: SessionCost, n: number) => `${n} interactive sessions, ${t.turns} turns, ${t.calls} model calls, weighted total ${Math.round(t.weighted)} (in ${t.input}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}, out ${t.output}), ${t.memoryCalls} memory commands, ${t.credits} replies with a credit marker`

if (import.meta.main) {
  const i = process.argv.indexOf('--since')
  const a = process.argv.indexOf('--archive')
  const r = report(a > 0 ? process.argv[a + 1]! : join(loadConfig().memDir, 'archive/sessions'), i > 0 ? process.argv[i + 1] : '')
  console.log(table(r))
  console.log(`\n${JSON.stringify(r)}`)
  console.log(`\n${summary(r.total, r.sessions.length)}`)
}
