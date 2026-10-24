// Reads one Markdown file into a ParsedNote (spec 03 §2). Pure: no IO.

import { parseFrontMatter } from './frontmatter.ts'
import type { Scalar, Value } from './frontmatter.ts'
import { CONFIDENCES, FRONT_MATTER_EDGES, NODE_TYPES, ORIGINS, SOURCE_KINDS, STATUSES } from './model.ts'
import type { Confidence, NodeType, Origin, ParsedNote, Source, SourceKind, Status } from './model.ts'

const WIKILINK = /!?\[\[([^\]\n]+?)\]\]/g
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/

/** The link target inside `[[target|label]]` or `[[target#heading]]`. */
export function linkTarget(inner: string): string {
  return (inner.split('|')[0] ?? '').split('#')[0]!.trim()
}

/** Every `[[link]]` target in a text, outside fenced code blocks. */
export function wikilinks(text: string): string[] {
  const out: string[] = []
  for (const m of stripCode(text).matchAll(WIKILINK)) {
    const t = linkTarget(m[1] ?? '')
    if (t !== '') out.push(t)
  }

  return out
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

/** `kind:ref[@hash][ YYYY-MM-DD]`. Returns null when the text is not a source. */
export function parseSource(raw: string): Source | null {
  const s = raw.trim()
  const colon = s.indexOf(':')
  if (colon <= 0) return null
  const kind = s.slice(0, colon) as SourceKind
  if (!SOURCE_KINDS.includes(kind)) return null
  let rest = s.slice(colon + 1).trim()
  let at: string | null = null
  const date = /\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/.exec(rest)
  if (date) {
    at = date[1] ?? null
    rest = rest.slice(0, date.index).trim()
  }
  let hash: string | null = null
  const atSign = rest.lastIndexOf('@')
  // A hash has no slash or colon after the @; this keeps user@host in URLs intact.
  if (atSign > 0 && !/[/:]/.test(rest.slice(atSign + 1))) {
    hash = rest.slice(atSign + 1) || null
    rest = rest.slice(0, atSign)
  }
  if (rest === '') return null

  return { kind, ref: rest, hash, at }
}

const str = (v: Value | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const strOrNull = (v: Value | undefined): string | null => (v === null || v === undefined || Array.isArray(v) ? null : String(v))
const list = (v: Value | undefined): string[] => {
  if (v === null || v === undefined) return []
  const items: Scalar[] = Array.isArray(v) ? v : [v]

  return items.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String).map(s => s.trim()).filter(Boolean)
}
const oneOf = <T extends string>(v: Value | undefined, allowed: readonly T[], fallback: T, field: string, issues: string[]): T => {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  issues.push(`${field}: "${String(v)}" is not one of ${allowed.join(', ')}`)

  return fallback
}

function fileStem(path: string): string {
  const name = path.split('/').pop() ?? path

  return name.replace(/\.md$/i, '')
}

export function parseNote(path: string, text: string): ParsedNote {
  const fm = parseFrontMatter(text)
  const d = fm.data
  const issues = [...fm.issues]
  const hasType = d.type !== undefined && d.type !== null
  const type: NodeType = hasType ? oneOf(d.type, NODE_TYPES, 'note', 'type', issues) : 'note'
  const title = str(d.title).trim() || fileStem(path)
  const sources: Source[] = []
  for (const raw of list(d.sources)) {
    const src = parseSource(raw)
    if (src) sources.push(src)
    else issues.push(`sources: cannot read "${raw}" (expected kind:ref[@hash][ date])`)
  }
  const links: ParsedNote['links'] = []
  for (const type of FRONT_MATTER_EDGES) for (const raw of list(d[type])) links.push({ type, target: wikilinks(raw)[0] ?? raw })
  for (const target of wikilinks(fm.body)) links.push({ type: 'mentions', target })
  const headings: string[] = []
  let inFence = false
  for (const line of fm.body.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence
    const h = inFence ? null : HEADING.exec(line)
    if (h) headings.push(h[1] ?? '')
  }
  const version = typeof d.version === 'number' ? d.version : 1
  const done = typeof d.done === 'boolean' ? d.done : null

  return {
    path,
    id: strOrNull(d.id),
    type,
    title,
    summary: str(d.summary).trim(),
    aliases: list(d.aliases),
    tags: list(d.tags),
    status: oneOf<Status>(d.status, STATUSES, 'active', 'status', issues),
    confidence: oneOf<Confidence>(d.confidence, CONFIDENCES, hasType ? 'human' : 'imported', 'confidence', issues),
    origin: oneOf<Origin>(d.origin, ORIGINS, 'local', 'origin', issues),
    validFrom: strOrNull(d.valid_from),
    validTo: strOrNull(d.valid_to),
    recordedAt: strOrNull(d.recorded_at),
    updatedAt: strOrNull(d.updated_at),
    version,
    author: str(d.author),
    sources,
    paths: list(d.paths),
    urls: list(d.urls),
    done,
    due: strOrNull(d.due),
    headings,
    body: fm.body,
    bodyLines: fm.body.split('\n').length,
    links,
    issues,
    hasFrontMatter: fm.hasFrontMatter,
  }
}
