// The Phase C commands: search, why, tried, asof, trace, resume, path, get. Each prints a short header, then
// numbered results with kind, id, date, source and the part of the passage around the match. Pure functions: db in, text out.

import { endOf, GOOD, Graph, local, localDay, queryTerms } from './engine.ts'
import type { Hit, Node, Search } from './engine.ts'

const WHY = [/\bbecause\b/i, /\bso that\b/i, /\bsince\b/i, /\bthe reason\b/i, /\bwhy:/i, /\bdecision:/i, /\bso we\b/i, /\bto avoid\b/i, /\botherwise\b/i]
const TRIED = [/\btried\b/i, /didn'?t work/i, /\bfailed\b/i, /\bbroke\b/i, /\breverted?\b/i, /\bdead[- ]end\b/i, /\binstead\b/i, /\babandoned\b/i, /\bdropped\b/i, /\brolled back\b/i, /\bturned out\b/i, /\bwrong\b/i]
const STRONG = /\b(why|decision|dead-end):/i
const UNDATED = new Set(['rule', 'doc', 'memory']) // no real date, so as-of cannot place them
// Curated notes (accepted decisions, rules, dead ends) carry real dates, even when their kind is rule.
// A CLAUDE.md section dated by git takes part in as-of; one dated by its file's mtime does not.
const undated = (n: Node) => (n.kind === 'doc' ? n.extra?.dateFrom !== 'git' : UNDATED.has(n.kind)) && !n.extra?.curated

const ms = (at: string) => Date.parse(at)
/** A curated note is closed once its valid_to has passed (or it is superseded, when asking about now). */
const closed = (n: Node, t: number, now = false) => !!n.extra?.curated && (n.until ? ms(n.until) <= t : now && n.extra.status === 'superseded')
const short = (id: string) => id.replace(/^(ses|turn|sum):(.{8}).*$/, '$1:$2')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Commits not on main or gone from git carry a label; a stash is never a commit worth citing. */
const offMain = (n: Node) => n.kind === 'commit' && (n.extra?.onMain === false || !!n.extra?.unreachable)
const isStash = (n: Node) => n.kind === 'commit' && (!!n.extra?.stash || /^(WIP on|index on|On) [^\s:]+:/.test(n.title))
const branchNote = (n: Node) => (n.kind !== 'commit' ? '' : n.extra?.unreachable ? ' (no longer in git)' : n.extra?.onMain === false ? (n.extra.branch ? ` (on branch ${n.extra.branch}, not on main)` : ' (not on main)') : '')

const owner = (n: Node) => String(n.extra?.sharedBy ?? '')
function sourceOf(n: Node): string {
  if (n.extra?.team && (n.kind === 'turn' || n.kind === 'summary' || n.kind === 'session')) return `chat of ${owner(n)}, ${localDay(n.at)} (team)`
  if (n.kind === 'turn' || n.kind === 'summary') return `session ${short(n.source)} at ${local(n.at)}`
  if (n.kind === 'pr') return `PR #${n.id.split('#').pop()} ${n.extra.url ?? n.source}${n.until ? `, merged ${n.until}` : `, ${n.extra.state ?? 'open'}`}`
  if (n.kind === 'commit') return `commit ${n.id.split(':').pop()!.slice(0, 7)} in ${n.project}${branchNote(n)}`
  if (n.kind === 'session') return `session ${short(n.id)} ${local(n.at)} to ${local(n.until)}`
  if (n.kind === 'section') return `${n.source}, section dated ${n.at}`
  if (n.kind === 'team') return `shared by ${n.extra?.sharedBy ?? n.source.replace(/^team:/, '')} (team)`
  if (n.kind === 'doc') return `${n.source}, section "${cut(n.title, 60)}"${n.extra?.dateFrom === 'git' ? `, file last committed ${local(n.at)}` : ''}`
  return n.source
}
export function label(g: Graph, id: string): string {
  const n = g.nodes.get(id)
  if (!n) return id
  const d = localDay(n.at)
  if (n.extra?.team && n.kind === 'turn') return `turn of ${owner(n)} on ${d} ("${cut(flat(n.title), 60)}")`
  if (n.extra?.team && n.kind === 'session') return `chat of ${owner(n)} (${d})`
  if (n.kind === 'turn') return `turn on ${d} ("${cut(flat(n.title), 60)}")`
  if (n.kind === 'summary') return `compaction summary on ${d}`
  if (n.kind === 'session') return `session ${short(n.id)} (${d})`
  if (n.kind === 'pr') return `PR #${n.id.split('#').pop()} "${cut(n.title, 60)}"`
  if (n.kind === 'commit') return `commit ${n.id.split(':').pop()!.slice(0, 7)} "${cut(n.title, 60)}"${branchNote(n)}`
  if (n.kind === 'note') return `note "${n.title}"`
  if (n.kind === 'file') return (n.extra.aliases as string[] | undefined)?.[0] ?? id.slice(5)
  return `${n.kind} ${cut(n.title || n.id, 60)}`
}
const VERB: Record<string, string> = { dead_end: 'records a dead end on', derived_from: 'was derived from', supersedes: 'supersedes', touches: 'touches', changed: 'changed', read: 'read', edited: 'edited', ran_in: 'ran a command in', made: 'made', opened: 'opened', merged_as: 'was merged as', links_to: 'links to', continued_from: 'continues', mentions: 'mentions' }
export function sentence(g: Graph, src: string, dst: string, kind: string, extra: any): string {
  const why = kind === 'mentions' && extra?.match ? ` (as "${extra.match}")` : ''
  return `${label(g, src)} ${VERB[kind] ?? kind} ${label(g, dst)}${why}`
}

/** The part of a passage around its matches (the **highlights**, else the first of `keys`), about `max` characters. */
export function excerpt(text: string, max = 360, keys: string[] = [], idf: (word: string) => number = () => 1): string {
  if (text.length <= max) return text
  const lower = text.toLowerCase()
  let at = [...text.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) => ({ i: m.index!, w: m[1]!.toLowerCase() }))
  if (!at.length) at = keys.map((k) => ({ i: lower.indexOf(k.toLowerCase()), w: k.toLowerCase() })).filter((a) => a.i >= 0)
  // The window with the most weight in distinct matched words (rare words count more, a repeat counts once), starting a little before the first of them.
  let start = 0
  let most = -1
  for (const { i } of at) {
    const s = Math.max(0, i - 80)
    const c = [...new Set(at.filter((q) => q.i >= s && q.i < s + max).map((q) => q.w))].reduce((a, w) => a + idf(w), 0)
    if (c > most) (most = c, (start = s))
  }
  const sp = text.slice(start, start + 30).search(/\s/)
  if (start > 0 && sp >= 0) start += sp + 1
  let end = Math.min(text.length, start + max)
  if (end < text.length) end = text.lastIndexOf(' ', end) > start ? text.lastIndexOf(' ', end) : end
  return `${start > 0 ? '... ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' ...' : ''}`
}
const quoted = (text: string) => text.split('\n').filter((l) => l.trim()).map((l) => `   | ${l}`).join('\n')

/** Automatic dead ends (phrase rules at ingest, not curated notes) say so. */
const deadNote = (n: Node) => (n.extra?.deadEnd ? `\n   dead end (automatic, ${n.extra.deadEndKind ?? 'phrase'}): ${cut(flat(String(n.extra.deadEnd)), 160)}` : '')
/** Dead ends from what happened (an undo, a failed test, a revert, a closed PR, the person's own mark) weigh more than a phrase. */
export const deadWeight = (n: Node) => (!n.extra?.deadEnd ? 0 : (n.extra.deadEndKind ?? 'phrase') === 'phrase' ? 1 : 2)

function result(i: number, h: Hit, extra = ''): string {
  const n = h.node
  return `${i}. [${n.kind}] ${n.id}\n   date: ${local(n.at)}   project: ${h.project}   source: ${sourceOf(n)}   passage: ${h.pid.split('#').pop()}   found by: ${h.lanes.join('+')}${deadNote(n)}${extra}\n${quoted(excerpt(h.shown, 360, [], h.idf))}`
}
/** A chat turn read as one unit: what was asked (when the match is further down the turn) and how the next turn answered.
 * The question and the answer are often in different passages from the words that matched. */
function turnAround(g: Graph, h: Hit): string {
  const n = h.node
  if (n.kind !== 'turn') return ''
  const asked = h.pid.endsWith('#p0') ? '' : `\n   asked: ${cut(flat(g.fullText(n.id).split('\n\n')[0] ?? n.title), 200)}`
  const sib = g.bySource(n.source).filter((x) => x.kind === 'turn').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
  const next = sib[sib.findIndex((x) => x.id === n.id) + 1]
  const reply = next ? flat(g.fullText(next.id).split('\n\n').slice(1).join(' ')) || flat(next.title) : ''

  return `${asked}${next ? `\n   same chat, next (${next.id}): ${cut(reply, 150)}` : ''}`
}
/** The output budget of one memory answer, in characters: THENWISE_OUTPUT_CHARS, else 4,000 (the server sets the variable
 * from `tools.output_chars` in config.json). More room shows more results in full. */
export const outputChars = () => Math.max(2000, Math.min(Number(process.env.THENWISE_OUTPUT_CHARS) || 4000, 20000))
/** One line for a lower result: kind, id, date and the words around the match. */
const brief = (i: number, h: Hit) => `${i}. ${h.node.id} ${local(h.node.at).slice(0, 10)} project: ${h.project} | ${flat(excerpt(h.shown, 80, [], h.idf)).replace(/\*\*/g, '')}`
/** The top 3 in full (with the next turn of the same chat), then up to 7 more as one line each, so Claude has more to choose from. */
function listing(g: Graph, items: { h: Hit; extra: string }[], limit = 10): string[] {
  const budget = outputChars()
  const full = items.slice(0, budget >= 8000 ? 5 : 3).map((x, i) => result(i + 1, x.h, x.extra + turnAround(g, x.h)))
  // One-liners stop before the tool output cap would cut them mid-list.
  let room = budget - 300 - full.join('\n\n').length
  const more = items.slice(full.length, limit).map((x, i) => brief(i + full.length + 1, x.h)).filter((l) => (room -= l.length + 1) >= 0)

  return [...full, ...(more.length ? [`more matches (get <id> prints one):\n${more.join('\n')}`] : [])]
}
const CUT = 'passages are cut to the words around the match ("..."); get <id>#<passage> prints one in full'
function notRecorded(what: string, s: Search): string {
  const out = [`not recorded: nothing in the memory matches ${what}.`, ...rewording(s)]
  if (s.missing.length) out.push(`These words appear nowhere in it: ${s.missing.join(', ')}.`)
  if (s.hits.length) out.push('WARNING: the items below are only the closest by wording and are probably unrelated. Do not use them as an answer.', ...s.hits.slice(0, 2).map((h, i) => result(i + 1, h)))
  return out.join('\n')
}
/** Says what the search changed: synonyms it also searched, and spellings it corrected. */
const rewording = (s: Search) => [...(s.feedback?.length ? [`also searched (from the first results): ${s.feedback.join(', ')}`] : []), ...(s.expanded.length ? [`also searched: ${s.expanded.map((e) => `${e.to.join(', ')} (for ${e.from})`).join('; ')}`] : []), ...(s.fixed.length ? [`did you mean: ${s.fixed.map((f) => f.to).join(', ')} (for ${s.fixed.map((f) => f.from).join(', ')})`] : [])]
const head = (title: string, s: Search, shown: number, total: number) => {
  const out = [`${title}: ${shown} of ${total} matching passages`, `searched: ${s.terms.join(' ') || '(exact references only)'}`]
  out.push(...rewording(s))
  if (s.missing.length) out.push(`no record of the word(s): ${s.missing.join(', ')}`)
  out.push(CUT)
  return out.join('\n')
}

export type RankCmd = 'search' | 'why' | 'tried' | 'current' | 'asof'
export interface Ranked {
  s: Search
  /** In the order the command shows them; `m` is the why/tried marker count. */
  items: { h: Hit; m?: number }[]
}

/** The ranking behind search, why, tried, current and asof, shared by the text commands and the gold benchmark. */
export function rank(g: Graph, cmd: RankCmd, q: string, opts: { date?: string } = {}): Ranked {
  if (cmd === 'search') {
    const s = g.search(q)

    return { s, items: s.good.map((h) => ({ h })) }
  }
  if (cmd === 'why' || cmd === 'tried') return rankMarked(g, cmd, q, cmd === 'why' ? WHY : TRIED)
  if (cmd === 'current') return rankCurrent(g, q)
  const end = ms(endOf(opts.date ?? ''))
  const s = g.search(q, { filter: (n) => !undated(n) && !isStash(n) && ms(n.at) <= end && !closed(n, end) && !(n.extra?.edited && ms(String(n.extra.edited)) > end), limit: 100 })
  // By relevance inside the date window; commits off main go after the rest of the best 12. Sorting the 12 newest first
  // let a later passage that only mentions the topic win over the one that states the fact.
  const top = s.good.slice(0, 12).sort((a, b) => +offMain(a.node) - +offMain(b.node))

  return { s, items: [...top, ...s.good.slice(12)].map((h) => ({ h })) }
}

export function search(g: Graph, q: string, limit = 10): string {
  const { s } = rank(g, 'search', q)
  if (!s.good.length) return notRecorded(`"${q}"`, s)
  const hs = s.good.slice(0, limit)
  const notes = newerNotes(g, s, hs)
  return [head('search', s, Math.min(limit, s.good.length), s.good.length), '', ...listing(g, hs.map((h, i) => ({ h, extra: notes[i]! })), limit)].join('\n\n')
}

// How final a record is: a merged PR, a commit or a dated log entry is the outcome; chat is often the discussion before it.
// A rule line from a CLAUDE.md is not an outcome (curated rules are); a doc section is guidance.
const FINAL: Record<string, number> = { pr: 1.6, commit: 1.4, section: 1.4, note: 1.2, team: 1.2, memory: 1.1, summary: 1, doc: 0.9, turn: 0.8 }
const final = (n: Node) => (n.kind === 'rule' && n.extra?.curated ? 1.3 : (FINAL[n.kind] ?? 1))
// Dated by a file's mtime (a CLAUDE.md line, a doc without git history): when it was saved, not when it became true.
const mtimeDated = (n: Node) => n.extra?.dateFrom === 'mtime' || (n.kind === 'rule' && !n.extra?.curated)

/** Why a later record is about the same thing as `h`, or '' when it only shares the query words: it supersedes `h`,
 * touches the same file or PR, carries its title (a revised plan, a follow-up), or shares two of its five rarest words. */
function sameTopic(g: Graph, h: Hit, x: Hit): string {
  if ((g.adj.get(x.node.id) ?? []).some((e) => e.kind === 'supersedes' && e.to === h.node.id)) return 'supersedes it'
  const linked = (id: string) => new Set(g.neighbours(id).map((e) => e.to).filter((t) => /^(file|pr):/.test(t)))
  const mine = linked(h.node.id)
  const shared = [...linked(x.node.id)].find((t) => mine.has(t))
  if (shared) return `touches the same ${shared.startsWith('pr:') ? 'PR' : 'file'}, ${label(g, shared)}`
  const [a, b] = [h.node.title, x.node.title].map((t) => flat(t).toLowerCase())
  if (a!.length >= 8 && b!.length >= 8 && (a!.includes(b!) || b!.includes(a!))) return 'carries the same title'
  const rare = [...new Set(words(h.text).filter((w) => w.length >= 4))].sort((a, b) => h.idf(b) - h.idf(a) || (a < b ? -1 : 1)).slice(0, 5)
  const theirs = new Set(words(x.text))
  const both = rare.filter((w) => theirs.has(w))

  return both.length >= 2 ? `shares the words ${both.join(', ')}` : ''
}

/** The most relevant newer record on the same topic, when there is one strong enough to matter, and why it counts. */
function newerOnTopic(g: Graph, s: Search, h: Hit, evidence = true): { hit: Hit; why: string } | undefined {
  const top = Math.max(...s.good.map((x) => x.score))
  const at = ms(h.node.at)
  if (Number.isNaN(at) || undated(h.node)) return undefined
  // Same topic: it covers the query words about as well. The fused score alone would let an exact-title bonus hide it.
  // Rules, docs and memory files carry only a file time, so they never count as a newer record.
  // A sibling in the same session within 30 minutes (a crew brief next to its twin) is not a later record.
  const sibling = (x: Hit) => ['turn', 'summary'].includes(x.node.kind) && ['turn', 'summary'].includes(h.node.kind) && x.node.source === h.node.source && ms(x.node.at) - at < 30 * 60000
  // Sharing the query words is not enough: two unrelated later records both match a short query.
  for (const x of s.good.filter((x) => x.node.id !== h.node.id && !undated(x.node) && ms(x.node.at) > at && !sibling(x) && x.cov >= 0.75 * h.cov && x.score >= top / 3).sort((a, b) => b.score - a.score || (a.pid < b.pid ? -1 : 1))) {
    const why = evidence ? sameTopic(g, h, x) : 'matches as well'
    if (why) return { hit: x, why }
  }

  return undefined
}
const newerNote = (g: Graph, s: Search, h: Hit) => {
  const n = newerOnTopic(g, s, h)
  return n ? `\n   NEWER on this topic (${n.why}): ${n.hit.node.kind} ${n.hit.node.id} (${local(n.hit.node.at)}); this one may be outdated: read the newer one (or run current) before saying what holds now\n   newer says: ${flat(excerpt(n.hit.shown, 160, [], n.hit.idf)).replace(/\*\*/g, "")}` : ''
}
/** NEWER notes for the top 3, kept on the first result that has one only: one warning per answer. */
const newerNotes = (g: Graph, s: Search, hs: Hit[]): string[] => {
  let done = false

  return hs.map((h, i) => {
    if (i >= 3 || done) return ''
    const n = newerNote(g, s, h)
    done = n !== ''

    return n
  })
}

/** current: what holds now on a topic. Relevance, times how final the record is (PRs, commits and dated log entries
 * over chat), times how recent it is among the topic's matches. Each top result says when a newer record exists. */
function rankCurrent(g: Graph, topic: string): Ranked {
  const s = g.search(topic, { limit: 400, filter: (n) => !closed(n, Date.now(), true) })
  if (!s.good.length) return { s, items: [] }
  const top = Math.max(...s.good.map((h) => h.score))
  const times = s.good.map((h) => ms(h.node.at)).filter((t) => !Number.isNaN(t))
  const t0 = Math.min(...times)
  const span = Math.max(...times) - t0 || 1
  const scored = s.good
    .map((h) => {
      const t = ms(h.node.at)
      const recent = Number.isNaN(t) ? 0.5 : mtimeDated(h.node) ? 0 : (t - t0) / span
      // A record with a strong newer one on the same topic, at least as final, has probably been overtaken.
      // Ranking keeps the looser test: on the benchmark it orders current better; only the warning text needs evidence.
      const later = newerOnTopic(g, s, h, false)?.hit
      const overtaken = later && final(later.node) >= final(h.node) ? 0.6 : 1
      return { h, v: (h.score / top) * (0.5 + h.cov) * final(h.node) * (0.7 + 0.6 * recent) * overtaken }
    })
    .sort((a, b) => b.v - a.v || (a.h.pid < b.h.pid ? -1 : 1))

  return { s, items: scored.map((x) => ({ h: x.h })) }
}

export function current(g: Graph, topic: string, limit = 5): string {
  const { s, items: scored } = rank(g, 'current', topic)
  if (!s.good.length) return notRecorded(`"${topic}"`, s)
  const out = [
    head('current', s, Math.min(limit, scored.length), scored.length),
    'ranked for what holds now: final records (PRs, commits, dated log entries) and newer ones first; earlier chat may describe a plan that changed',
  ]
  const hs = scored.slice(0, limit).map((x) => x.h)
  const notes = newerNotes(g, s, hs)
  return [out.join('\n'), '', ...hs.map((h, i) => result(i + 1, h, notes[i]!))].join('\n\n')
}

/** why and tried: the topic's best passages, boosted when they state a reason or an attempt. Relevance leads; markers only
 * reorder close calls, so a plain commit message that holds the answer is not thrown away. */
function rankMarked(g: Graph, name: string, topic: string, markers: RegExp[]): Ranked {
  const s = g.search(topic, { limit: 400 })
  if (!s.good.length) return { s, items: [] }
  const top = Math.max(...s.good.map((h) => h.score))
  const scored = s.good
    .map((h) => {
      const m = markers.filter((r) => r.test(h.text)).length + (STRONG.test(h.text) ? 1 : 0) + (name === 'tried' ? deadWeight(h.node) : 0)
      return { h, m, v: (h.score / top) * (0.5 + h.cov) * (1 + 0.4 * Math.min(m, 3)) }
    })
    .sort((a, b) => b.v - a.v || (a.h.pid < b.h.pid ? -1 : 1))

  return { s, items: scored.map((x) => ({ h: x.h, m: x.m })) }
}

function marked(g: Graph, name: 'why' | 'tried', topic: string, limit = 10): string {
  const { s, items: scored } = rank(g, name, topic)
  if (!s.good.length) return notRecorded(`${name} for "${topic}"`, s)
  const top = scored.slice(0, limit)
  const notes = newerNotes(g, s, top.map((x) => x.h))
  return [head(name, s, Math.min(limit, scored.length), scored.length), '', ...listing(g, top.map((x, i) => ({ h: x.h, extra: `   markers: ${x.m}${notes[i]}` })), limit)].join('\n\n')
}
export const why = (g: Graph, topic: string) => marked(g, 'why', topic)
export const tried = (g: Graph, topic: string) => marked(g, 'tried', topic)

/** Earliest later item that replaces `n`: a later PR or commit on the same files, or a later note on the same topic. */
function replacedBy(g: Graph, h: Hit, q: string, s: Search): string | undefined {
  const n = h.node
  let best: { node: Node; via: string } | undefined
  const consider = (c: Node | undefined, via: string) => {
    if (c && c.id !== n.id && ms(c.at) > ms(n.at) && (!best || ms(c.at) < ms(best.node.at))) best = { node: c, via }
  }
  if (n.kind === 'pr' || n.kind === 'commit') {
    for (const e of g.neighbours(n.id)) {
      if (g.nodes.get(e.to)?.kind !== 'file') continue
      for (const f of g.neighbours(e.to)) if (['pr', 'commit'].includes(g.nodes.get(f.to)?.kind ?? '')) consider(g.nodes.get(f.to), `the same file ${label(g, e.to)}`)
    }
  } else if (n.kind === 'note') {
    for (const c of g.search(q, { filter: (x) => x.kind === 'note' }).good) consider(c.node, 'the same topic')
  } else if (n.kind === 'turn') {
    // A commit the turn made, or a later turn of the same chat on the same topic.
    for (const e of g.neighbours(n.id)) if (e.kind === 'made' && g.nodes.get(e.to)?.kind === 'commit') consider(g.nodes.get(e.to), 'a commit made from it')
    for (const c of s.good) if (c.node.kind === 'turn' && c.node.source === n.source) consider(c.node, 'the same chat')
  }
  return best ? `later on ${best.via}: ${label(g, best.node.id)} (${best.node.at})` : undefined
}

export function asof(g: Graph, date: string, q: string, limit = 5): string {
  const end = ms(endOf(date))
  if (Number.isNaN(end)) return `asof needs an ISO date or date and time first, such as 2026-10-19 or 2026-10-19T06:50:00Z; got "${date}".`
  const { s, items } = rank(g, 'asof', q, { date })
  if (!s.good.length) return notRecorded(`"${q}" on or before ${date}`, s)
  const top = items.slice(0, Math.min(limit, 12)).map((x) => x.h)
  const newest = top.reduce((a, b) => (ms(b.node.at) > ms(a.node.at) ? b : a))
  const out = [`asof ${date}: ${top.length} of ${s.good.length} matching passages dated on or before ${date}, best match first`, `searched: ${s.terms.join(' ')}`, 'memory files, and CLAUDE.md sections without git history, are undated and left out', CUT, `best match: ${label(g, top[0]!.node.id)} (${local(top[0]!.node.at)}); newest among the matches: ${label(g, newest.node.id)} (${local(newest.node.at)})`]
  const repos = commitsAt(g, end)
  if (repos.length) out.push(`the code as it was on ${date} (the newest commit on or before it; read a file with git show <sha>:<path>):`, ...repos)
  const blocks = top.map((h, i) => {
    const later = i < 3 ? replacedBy(g, h, q, s) : undefined
    return result(i + 1, h, later ? `\n   ${later}` : '')
  })
  return [out.join('\n'), '', ...blocks].join('\n\n')
}

/** The newest commit on or before `end` in each repository, so a file can be read as it was then. */
function commitsAt(g: Graph, end: number): string[] {
  const best = new Map<string, Node>()
  for (const n of g.ofKind('commit')) {
    if (isStash(n) || !(ms(n.at) <= end) || !g.inScope(n)) continue
    const b = best.get(n.source)
    // On-main commits beat the rest; among equals the newest wins.
    if (!b || +offMain(b) > +offMain(n) || (offMain(b) === offMain(n) && ms(n.at) > ms(b.at))) best.set(n.source, n)
  }
  return [...best.values()].sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4).map((n) => `- ${n.project}: ${label(g, n.id)}, ${local(n.at)}: git -C ${n.source} show ${String(n.extra.sha ?? n.id.split(':').pop()).slice(0, 7)}:<path>`)
}

function pick(g: Graph, id: string, keys: string[]) {
  const ps = g.passages(id)
  return ps.find((p) => keys.some((k) => k && p.text.toLowerCase().includes(k.toLowerCase()))) ?? ps[0]
}

/** `offset` skips that many of the newest items (paging); `budget` is the character budget for the items, 0 for no limit. */
export function trace(g: Graph, target: string, cap = 100, offset = 0, budget = 0): string {
  const ex = g.exact(target)
  if (!ex.length) {
    const s = g.search(target)
    if (!s.good.length) return notRecorded(`"${target}"`, s)
    const hits = s.good.slice(0, 8).sort((a, b) => ms(b.node.at) - ms(a.node.at))
    return [`trace "${target}": no file, PR, commit or note by that name; showing ${hits.length} topic matches, newest first, grouped by date`, `searched: ${s.terms.join(' ')}`, ...grouped(hits.map((h) => ({ date: h.node.at, text: result(0, h).replace(/^0\. /, '- ') })))].join('\n\n')
  }
  const out = [`trace "${target}": ${ex.map((e) => `${e.why} -> ${label(g, e.id)}`).join('; ')}`, CUT]
  const items: { date: string; text: string }[] = []
  for (const { id } of ex.slice(0, 3)) {
    const t = g.nodes.get(id)!
    const keys = [id.split('#').pop()!, id.split(':').pop()!.slice(0, 7), t.title, ...((t.extra.aliases as string[] | undefined) ?? [])].filter((k) => k.length >= 3)
    const seen = new Set<string>([id])
    const nb = (g.adj.get(id) ?? []).filter((e) => e.kind !== 'part_of' && !g.isHub(e.to) && g.inScope(g.nodes.get(e.to)) && !seen.has(e.to) && seen.add(e.to)).sort((a, b) => +offMain(g.nodes.get(a.to)!) - +offMain(g.nodes.get(b.to)!) || ms(g.nodes.get(b.to)!.at) - ms(g.nodes.get(a.to)!.at) || (a.to < b.to ? -1 : 1))
    if (nb.length > cap) out.push(`${label(g, id)} is linked to ${nb.length} items; the newest ${cap} are shown.`)
    const own = pick(g, id, [])
    if (own) items.push({ date: t.at, text: `- [${t.kind}] ${id} (the target itself)\n   date: ${local(t.at)}   project: ${g.projectName(t)}   source: ${sourceOf(t)}\n${quoted(excerpt(own.text, 500))}` })
    for (const e of nb.slice(0, cap)) {
      const n = g.nodes.get(e.to)!
      const p = pick(g, e.to, keys)
      const rel = e.out ? sentence(g, id, e.to, e.kind, e.extra) : sentence(g, e.to, id, e.kind, e.extra)
      items.push({ date: n.at, text: `- [${n.kind}] ${n.id}\n   date: ${local(n.at)}   project: ${g.projectName(n)}   source: ${sourceOf(n)}\n   link: ${rel}${deadNote(n)}${p ? `\n${quoted(excerpt(p.text, 300, keys))}` : ''}` })
    }
  }
  items.sort((a, b) => ms(b.date) - ms(a.date))
  const from = Math.min(Math.max(0, Math.floor(offset) || 0), items.length)
  let shown = items.length
  if (budget > 0) {
    // Newest first, so the budget cuts the oldest items; the first item always stays so a page is never empty.
    let used = out.join('\n\n').length
    shown = from
    while (shown < items.length && (shown === from || used + items[shown]!.text.length + 20 <= budget)) used += items[shown++]!.text.length + 20
  }
  const more = items.length - shown
  const note = from > 0 || more > 0 ? [`items ${from + 1} to ${shown} of ${items.length}, newest first.${more > 0 ? ` ${more} older items not shown: call memory_trace again with offset=${shown}.` : ''}`] : []

  return [...out, ...grouped(items.slice(from, shown)), ...note].join('\n\n')
}
function grouped(items: { date: string; text: string }[]): string[] {
  const out: string[] = []
  let last = ''
  for (const it of [...items].sort((a, b) => ms(b.date) - ms(a.date))) {
    const d = it.date ? localDay(it.date) : 'undated'
    if (d !== last) (out.push(`== ${d} ==`), (last = d))
    out.push(it.text)
  }
  return out
}

export function resume(g: Graph, q = ''): string {
  const terms = queryTerms(q)
  const sessions = g.ofKind('session').filter((n) => g.inScope(n) && !n.extra?.team)
  let ses: Node | undefined
  let how = 'the newest session'
  const key = words(q).join('-')
  if (key) {
    const byProject = sessions.filter((n) => n.project.toLowerCase().includes(key)).sort((a, b) => ms(b.until || b.at) - ms(a.until || a.at))
    if (byProject[0]) (ses = byProject[0], (how = `the newest session of project "${q}"`))
    else {
      const score = new Map<string, number>()
      const s = g.search(q, { filter: (n) => n.kind === 'turn' || n.kind === 'summary' })
      for (const h of s.good) score.set(h.node.source, (score.get(h.node.source) ?? 0) + h.score)
      const best = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
      if (best) (ses = g.nodes.get(best[0]), (how = `the session whose turns match "${q}" best`))
      else return notRecorded(`"${q}" in any session`, s)
    }
  } else ses = sessions.sort((a, b) => ms(b.until || b.at) - ms(a.until || a.at))[0]
  if (!ses) return 'not recorded: the graph holds no sessions.'

  const out = [`resume${q ? ` "${q}"` : ''}: ${how}: ${label(g, ses.id)}, ${ses.at} to ${ses.until}`]
  const kids = g.bySource(ses!.id).sort((a, b) => ms(b.at) - ms(a.at) || (a.id < b.id ? -1 : 1))
  const sum = kids.find((n) => n.kind === 'summary')
  const turns = kids.filter((n) => n.kind === 'turn').slice(0, 3)
  const lastAt = kids[0]?.at ?? ses.until
  if (sum) {
    const ps = g.passages(sum.id)
    out.push(`## Last compaction summary (${sum.at}, ${sum.id}), ${ps.length} passages, the last one shown\n${ps[ps.length - 1]?.text ?? ''}`)
  } else out.push('## Last compaction summary\nnone recorded for this session')
  out.push(`## Last ${turns.length} turns of the session, newest first`, ...turns.map((t) => {
    const ps = g.passages(t.id)
    return `- ${t.at}  ${t.id}\n   prompt: ${cut(flat(g.fullText(t.id).split('\n\n')[0] ?? ''), 300)}\n   last reply passage:\n${(ps[ps.length - 1]?.text ?? '').split('\n').map((l) => `   | ${l}`).join('\n')}`
  }))

  const lower = (n: Node) => `${n.title}\n${g.fullText(n.id)}`.toLowerCase()
  const on = (n: Node) => !terms.length || terms.some((t) => lower(n).includes(t))
  const prs = g.ofKind('pr').filter((n) => g.inScope(n) && n.extra.state === 'OPEN' && on(n)).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 8)
  out.push(`## Open PRs${prs.length ? '' : ': none recorded'}`, ...prs.map((n) => `- ${label(g, n.id)}, opened ${n.at}, ${n.extra.url}\n   ${cut(flat(g.passages(n.id)[0]?.text ?? ''), 400)}`))
  const cwd = String(ses.extra.cwd ?? '')
  const commits = g.ofKind('commit').filter((n) => g.inScope(n) && ms(n.at) > ms(lastAt) && (cwd.includes(n.project) || on(n))).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 10)
  out.push(`## Commits after the last turn (${lastAt})${commits.length ? '' : ': none recorded'}`, ...commits.map((n) => `- ${label(g, n.id)}, ${n.at}`))
  const notes = (terms.length ? g.search(q, { filter: (n) => n.kind === 'note' }).good.map((h) => h.node) : g.ofKind('note').filter((n) => g.inScope(n))).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4)
  out.push(`## Newest matching vault notes${notes.length ? '' : ': none recorded'}`, ...notes.map((n) => `- ${label(g, n.id)}, ${n.at}, ${n.source}\n   ${cut(flat(g.passages(n.id)[0]?.text ?? ''), 500)}`))
  // Where the work stands is often in the release history and the "next to build" line, whatever the query words.
  const releases = g.ofKind('commit', 'pr').filter((n) => g.inScope(n) && ((n.kind === 'commit' && /^(\w[\w-]* )?v?\d+\.\d+\.\d+\b/.test(n.title)) || (n.kind === 'pr' && /^release v?\d+\.\d+/i.test(n.title)))).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 4)
  out.push(`## Latest releases${releases.length ? '' : ': none recorded'}`, ...releases.map((n) => `- ${label(g, n.id)}, ${local(n.at)}`))
  const next = g.ofKind('note', 'section').filter((n) => /pending|home/i.test(n.id)).flatMap((n) => g.fullText(n.id).split('\n').filter((l) => /next to build|\*\*next\b|^\s*[-*]\s+\[ \]\s+\*\*first/i.test(l)).map((l) => `- ${cut(l.trim(), 400)} (${label(g, n.id)})`))
  out.push(`## Next on the build list${next.length ? '' : ': none recorded'}`, ...[...new Set(next)].slice(0, 6))
  for (const n of g.ofKind('note').filter((x) => /pending/i.test(x.id) && on(x)).slice(0, 2)) {
    const open = g.fullText(n.id).split('\n').filter((l) => /^\s*[-*]\s+\[ \]/.test(l))
    out.push(`## Unchecked items in ${label(g, n.id)} (${n.at})`, open.length ? open.join('\n') : 'none unchecked')
  }
  const since = [lastAt, ...notes.map((n) => n.at)].sort().pop()!
  out.push(`## Check against the repo (this output only knows what was recorded up to ${since})`, `- working directory of the session: ${cwd || 'unknown'}`, '- current branch: `git branch --show-current`, and compare with the branch named in the notes or PRs above', '- uncommitted changes: `git status --short`', `- commits after ${since}: \`git log --since=${since.slice(0, 10)} --oneline\``, '- open PRs still open: `gh pr list`; the PRs above may have merged since', '- trust the repo over any note above when they disagree')
  // The hook cuts this brief from the end, so the parts that tell what to do next come first and the oldest material last.
  const groups: string[][] = []
  for (const x of out.slice(1)) x.startsWith('## ') || !groups.length ? groups.push([x]) : groups[groups.length - 1]!.push(x)
  const rank = (g0: string[]) => ORDER.findIndex((o) => g0[0]!.startsWith(`## ${o}`))
  groups.sort((a, b) => rank(a) - rank(b))

  return [out[0]!, ...groups.flat()].join('\n\n')
}
const ORDER = ['Next on', 'Unchecked', 'Open PRs', 'Commits after', 'Latest releases', 'Last compaction', 'Check against', 'Last ', 'Newest']

/** The startup brief: the newest session of the scope when it ended within `days`, its first prompt, what landed since
 * (commits, merged PRs) and the open PRs, at most about 200 tokens. '' when there is no recent session. */
export function resumeShort(g: Graph, days = 7, now = Date.now()): string {
  const ses = g.ofKind('session').filter((n) => g.inScope(n) && !n.extra?.team).sort((a, b) => ms(b.until || b.at) - ms(a.until || a.at))[0]
  const end = ses ? ms(ses.until || ses.at) : NaN
  const recent = !!ses && now - end <= days * 864e5
  // Teammates' chats of this project since the last session here (or this week, with none).
  const mates = new Map<string, number>()
  for (const n of g.ofKind('session')) if (n.extra?.team && g.inScope(n) && ms(n.until || n.at) > (recent ? end : now - days * 864e5)) mates.set(owner(n), (mates.get(owner(n)) ?? 0) + 1)
  const team = mates.size ? `teammates' chats in this project since ${recent ? 'your last session' : 'this week'}: ${[...mates.values()].reduce((a, b) => a + b, 0)} (${[...mates].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([o, k]) => `${o} ${k}`).join(', ')})` : ''
  if (!recent) return team
  const first = g.bySource(ses!.id).filter((n) => n.kind === 'turn').sort((a, b) => ms(a.at) - ms(b.at))[0]
  const out = [`last session here: ${local(ses!.until || ses!.at)} (${ses!.id}), it began with: "${cut(flat(first ? g.fullText(first.id).split('\n\n')[0] ?? '' : ses!.title), 140)}"`]
  const commits = g.ofKind('commit').filter((n) => g.inScope(n) && ms(n.at) > end).sort((a, b) => ms(b.at) - ms(a.at))
  if (commits.length) out.push(`commits since: ${commits.length}, newest ${commits.slice(0, 3).map((n) => label(g, n.id)).join('; ')}`)
  const merged = g.ofKind('pr').filter((n) => g.inScope(n) && n.until && ms(n.until) > end).slice(0, 3)
  if (merged.length) out.push(`merged since: ${merged.map((n) => label(g, n.id)).join('; ')}`)
  const open = g.ofKind('pr').filter((n) => g.inScope(n) && n.extra.state === 'OPEN').sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 3)
  if (open.length) out.push(`open PRs: ${open.map((n) => label(g, n.id)).join('; ')}`)
  if (team) out.push(team)

  return cut(out.join('\n'), 800)
}

/** Up to three one-line pointers for a prompt, or '' when the match is weak: the best match must cover half the query
 * words, and at least two of them must be known to the store. Silence is the common case. */
export function pointers(g: Graph, q: string): string {
  const s = g.search(q.slice(0, 2000))
  if (!s.good.length || s.good[0]!.cov < 0.5 || s.terms.length - s.missing.length < 2) return ''
  const seen = new Set<string>()

  return s.good
    .filter((h) => !seen.has(h.node.id) && !!seen.add(h.node.id))
    .slice(0, 3)
    .map((h) => `[${h.node.kind}] ${h.node.id} (${localDay(h.node.at)}${h.node.extra?.team ? `, ${owner(h.node)}` : ''}): ${cut(flat(excerpt(h.shown, 220, [], h.idf)).replace(/\*\*/g, ''), 110)}`)
    .join('\n')
}

/** Up to three shortest paths of at most four hops, found one at a time with the used middle nodes removed. */
export function path(g: Graph, a: string, b: string, max = 4): string {
  const resolve = (q: string) => g.exact(q)[0]?.id ?? g.nodes.get(q)?.id ?? g.search(q).good[0]?.node.id
  const from = resolve(a)
  const to = resolve(b)
  if (!from || !to) return `not recorded: could not resolve ${!from ? `"${a}"` : `"${b}"`} to anything in the memory.`
  if (from === to) return `both resolve to ${label(g, from)}`
  const banned = new Set<string>()
  const found: { id: string; e: { kind: string; out: boolean; extra: any } | null }[][] = []
  for (let round = 0; round < 3; round++) {
    const prev = new Map<string, { id: string; e: any }>()
    prev.set(from, { id: '', e: null })
    let frontier = [from]
    for (let d = 0; d < max && !prev.has(to) && frontier.length; d++) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const e of g.neighbours(cur)) {
          if (prev.has(e.to) || (banned.has(e.to) && e.to !== to)) continue
          prev.set(e.to, { id: cur, e })
          next.push(e.to)
        }
      }
      frontier = next
    }
    if (!prev.has(to)) break
    const p: typeof found[number] = []
    for (let c: string = to; ; c = prev.get(c)!.id) {
      p.unshift({ id: c, e: prev.get(c)!.e })
      if (c === from) break
    }
    found.push(p)
    for (const s of p.slice(1, -1)) banned.add(s.id)
    if (p.length === 2) break // a direct edge cannot be found twice
  }
  if (!found.length) return `path "${a}" to "${b}": no connection of at most ${max} hops that avoids hub nodes (part_of fan-out, files touched by more than 30 nodes).`
  const out = [`path: ${label(g, from)} to ${label(g, to)}: ${found.length} path${found.length > 1 ? 's' : ''}, hubs avoided`]
  found.forEach((p, i) => {
    out.push(`path ${i + 1} (${p.length - 1} hop${p.length > 2 ? 's' : ''})`)
    for (let k = 1; k < p.length; k++) {
      const e = p[k]!.e!
      const [s, d] = e.out ? [p[k - 1]!.id, p[k]!.id] : [p[k]!.id, p[k - 1]!.id]
      out.push(`  ${k}. ${sentence(g, s, d, e.kind, e.extra)}`)
    }
  })
  return out.join('\n')
}

export function get(g: Graph, id: string): string {
  const p = /^(.*)#p(\d+)$/.exec(id)
  const nid = p && g.nodes.has(p[1]!) ? p[1]! : id
  const n = g.nodes.get(nid)
  if (!n) {
    const near = g.idsContaining(id, 5)
    return `not recorded: no node with id "${id}".${near.length ? `\nIds containing it: ${near.join(', ')}` : ''}`
  }
  const full = g.fullText(nid)
  // A short node prints whole: its reason may sit in the next passage.
  const text = p && nid !== id && full.length >= 3000 ? g.passages(nid).find((x) => x.n === Number(p[2]))?.text : full
  const edges = (g.adj.get(nid) ?? []).filter((e) => e.kind !== 'part_of').slice(0, 15).map((e) => `  ${e.out ? sentence(g, nid, e.to, e.kind, e.extra) : sentence(g, e.to, nid, e.kind, e.extra)}`)
  return [`[${n.kind}] ${id}\ndate: ${local(n.at)}   project: ${g.projectName(n)}   source: ${sourceOf(n)}\ntitle: ${n.title}`, text ?? `not recorded: ${id} has no such passage`, edges.length ? `links (first ${edges.length}):\n${edges.join('\n')}` : ''].filter(Boolean).join('\n\n')
}

const words = (q: string) => q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
export { GOOD }
