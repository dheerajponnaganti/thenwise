// `thenwise cost`: what the chats cost, from each tool's own running total. Tokens wherever a tool records them, dollars
// only where it gives them (Claude Code); a tool that records none is named as such, never guessed. No model.

import type { Cost } from '../ingest/transcript.ts'
import { Graph, local } from './engine.ts'
import type { Node } from './engine.ts'

type Point = [string, number | null, number, number, number]
interface Sum { chats: number; costed: number; priced: number; usd: number; input: number; cached: number; output: number }

const TOOLS = ['Claude Code', 'Codex', 'Copilot', 'Antigravity']
const TOKENS = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const USD = (n: number) => `$${n.toFixed(2)}`
const empty = (): Sum => ({ chats: 0, costed: 0, priced: 0, usd: 0, input: 0, cached: 0, output: 0 })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** What a chat spent after `since`: its last running total minus the total just before `since` (none when it began
 * after). A store from before the running total was kept has only the final total, which then counts whole. */
export function spentSince(s: Node, since: number): Cost | undefined {
  const c = s.extra?.cost as Cost | undefined
  if (!c) return undefined
  const pts = (s.extra?.costs as Point[] | undefined) ?? []
  const before = pts.filter((p) => Date.parse(p[0]) < since).at(-1)
  if (!before) return c
  const d: Cost = { input: c.input - before[2], cached: c.cached - before[3], output: c.output - before[4] }
  if (typeof c.usd === 'number' && typeof before[1] === 'number') d.usd = c.usd - before[1]
  return d
}

function add(s: Sum, c: Cost | undefined) {
  s.chats++
  if (!c) return
  s.costed++
  s.input += c.input
  s.cached += c.cached
  s.output += c.output
  if (typeof c.usd === 'number') (s.usd += c.usd, s.priced++)
}
const tokens = (s: Sum) => `${TOKENS(s.input)} tokens in, ${TOKENS(s.cached)} from cache, ${TOKENS(s.output)} out`
/** Dollars with what they cover, so a figure for 7 of 10 chats never reads as all 10. */
const dollars = (s: Sum) => (s.priced === s.chats ? USD(s.usd) : `${USD(s.usd)} for ${s.priced} of ${s.chats} chats`)

/** Own chats in scope that were active since `since` (optionally only those whose turns in that time match `q`): what they
 * spent in that time, per tool and per project, and the share spent in chats that hit a dead end. */
export function costReport(g: Graph, since: number, q = ''): string {
  let ses = g.ofKind('session').filter((s) => g.inScope(s) && !s.extra?.team && Date.parse(s.until || s.at) >= since)
  if (q) {
    const hit = new Set(g.search(q, { filter: (n) => n.kind === 'turn' && Date.parse(n.at) >= since }).good.map((h) => h.node.source))
    ses = ses.filter((s) => hit.has(s.id))
  }
  const where = `cost since ${local(new Date(since).toISOString())}${q ? ` of chats about "${q}"` : ''}`
  if (!ses.length) return `${where}: none recorded`
  // One query for the chats that hit a dead end the store saw happen (not a phrase in a reply).
  const deadSet = new Set((g.db.prepare("SELECT DISTINCT source FROM nodes WHERE kind = 'turn' AND json_extract(extra, '$.deadEnd') IS NOT NULL AND coalesce(json_extract(extra, '$.deadEndKind'), 'phrase') != 'phrase'").all() as { source: string }[]).map((r) => r.source))
  const byTool = new Map<string, Sum>()
  const byProject = new Map<string, Sum>()
  const dead = empty()
  const all = empty()
  for (const s of ses) {
    const c = spentSince(s, since)
    const tool = String(s.extra?.tool ?? 'Claude Code')
    add(byTool.get(tool) ?? byTool.set(tool, empty()).get(tool)!, c)
    const p = g.projectName(s)
    add(byProject.get(p) ?? byProject.set(p, empty()).get(p)!, c)
    add(all, c)
    if (deadSet.has(s.id)) add(dead, c)
  }
  const out = [`${where}: ${plural(ses.length, 'chat')}, counting only what they spent since then`]
  for (const tool of [...TOOLS, ...[...byTool.keys()].filter((t) => !TOOLS.includes(t))]) {
    const s = byTool.get(tool)
    if (!s) continue
    if (!s.costed) out.push(`- ${tool}: ${plural(s.chats, 'chat')}; no cost found in its chat files`)
    else out.push(`- ${tool}: ${s.priced ? `${dollars(s)}, ` : ''}${tokens(s)} over ${plural(s.chats, 'chat')}${!s.priced ? ` (${tool} records tokens, not dollars)` : ''}${s.costed < s.chats ? `; ${s.chats - s.costed} without a record` : ''}`)
  }
  const projects = [...byProject].sort((a, b) => b[1].usd - a[1].usd || b[1].input + b[1].output - (a[1].input + a[1].output)).slice(0, 5)
  if (byProject.size > 1) out.push(`by project: ${projects.map(([p, s]) => `${p} ${s.priced ? USD(s.usd) : `${TOKENS(s.input + s.output)} tokens`} (${s.chats})`).join(', ')}`)
  if (dead.priced && all.priced) out.push(`in chats that hit a dead end (a failed test, an undone edit, a revert, a marked one): ${USD(dead.usd)} of ${USD(all.usd)} priced (${Math.round((100 * dead.usd) / (all.usd || 1))}%), ${plural(dead.chats, 'chat')}`)
  else if (dead.costed) out.push(`in chats that hit a dead end: ${tokens(dead)} over ${plural(dead.chats, 'chat')}`)
  // Claude Code prices every chat at API rates, also on a subscription, so the figure is a measure, not a bill.
  if (all.priced) out.push('dollars are what Claude Code reports at API prices; a subscription bills differently')
  return out.join('\n')
}
