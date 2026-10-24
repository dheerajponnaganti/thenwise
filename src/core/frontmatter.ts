// A strict subset of YAML front matter: flat `key: value` pairs, flow lists `[a, b]` and block lists `- a`.
// Nested maps are not supported by design (spec 03 §2: flat lists render as links in Obsidian).
// Unsupported lines are reported, never guessed at.

export type Scalar = string | number | boolean | null
export type Value = Scalar | Scalar[]

export interface FrontMatter {
  data: Record<string, Value>
  body: string
  /** Line number in the file where the body starts (1-based). */
  bodyStart: number
  hasFrontMatter: boolean
  issues: string[]
}

const OPEN = /^---[ \t]*\r?\n/
const KEY_LINE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/
const LIST_ITEM = /^[ \t]*-[ \t]+(.*?)[ \t]*$/

export function parseFrontMatter(text: string): FrontMatter {
  const issues: string[] = []
  if (!OPEN.test(text)) return { data: {}, body: text, bodyStart: 1, hasFrontMatter: false, issues }
  const lines = text.split(/\r?\n/)
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l))
  if (end === -1) return { data: {}, body: text, bodyStart: 1, hasFrontMatter: false, issues: ['front matter has no closing ---'] }
  const data: Record<string, Value> = {}
  // Keys written as `key:` with nothing after them: a block list if items follow, else an empty value.
  const blockKeys = new Set<string>()
  let listKey: string | null = null
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = LIST_ITEM.exec(line)
    if (item && listKey !== null) {
      const list = data[listKey]
      if (Array.isArray(list)) list.push(parseScalar(item[1] ?? ''))
      continue
    }
    const kv = KEY_LINE.exec(line)
    if (!kv || /^[ \t]/.test(line)) {
      issues.push(`line ${i + 1}: not a flat key or list item (nested values are not supported)`)
      listKey = null
      continue
    }
    const key = kv[1] ?? ''
    const raw = kv[2] ?? ''
    if (key in data) issues.push(`line ${i + 1}: duplicate key "${key}"`)
    if (raw === '') {
      // `key:` then block list items, or an empty value.
      data[key] = []
      blockKeys.add(key)
      listKey = key
    } else {
      data[key] = raw.startsWith('[') ? parseFlowList(raw, i + 1, issues) : parseScalar(raw)
      listKey = null
    }
  }
  for (const k of blockKeys) if (Array.isArray(data[k]) && (data[k] as Scalar[]).length === 0) data[k] = null

  return { data, body: lines.slice(end + 1).join('\n'), bodyStart: end + 2, hasFrontMatter: true, issues }
}

function parseFlowList(raw: string, lineNo: number, issues: string[]): Scalar[] {
  if (!raw.endsWith(']')) {
    issues.push(`line ${lineNo}: list is not closed with ]`)

    return []
  }
  const inner = raw.slice(1, -1)
  const items: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? ''
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += inner[++i] ?? ''
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '[') {
      depth++
      cur += c
    } else if (c === ']') {
      depth--
      cur += c
    } else if (c === ',' && depth === 0) {
      items.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '' || items.length > 0) items.push(cur)

  return items.map(s => s.trim()).filter(s => s !== '').map(parseScalar)
}

export function parseScalar(raw: string): Scalar {
  const s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  // A ` #` starts a comment; a # inside a URL (no space before it) does not.
  const plain = s.replace(/\s+#.*$/, '')
  if (plain === '' || plain === '~' || plain === 'null') return null
  if (plain === 'true') return true
  if (plain === 'false') return false
  if (/^-?\d+$/.test(plain)) return Number(plain)

  return plain
}

/** Adds `key: value` as the first front-matter line, creating front matter if the file has none. Every other byte is kept. */
export function insertField(text: string, key: string, value: string): string {
  const m = OPEN.exec(text)
  if (m) return `${m[0]}${key}: ${value}\n${text.slice(m[0].length)}`

  return `---\n${key}: ${value}\n---\n${text}`
}

/** A YAML double-quoted string that this parser reads back exactly (newlines collapse to spaces). */
export function quote(s: string): string {
  return `"${s.replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** One front-matter value as a line's right-hand side: scalars quoted when needed, lists in flow style. */
export function yamlValue(v: Scalar | Scalar[]): string {
  if (Array.isArray(v)) return `[${v.map(x => (typeof x === 'string' ? quote(x) : String(x))).join(', ')}]`
  if (v === null) return 'null'
  if (typeof v !== 'string') return String(v)

  return /^[\w./@+-][\w ./@+:-]*$/.test(v) && !/^(true|false|null|~|-?\d+)$/.test(v) && !/: /.test(v) ? v : quote(v)
}

/**
 * Sets top-level keys in existing front matter. A key that exists is replaced in place (its block-list items
 * removed with it); a new key goes last. Every other line is kept byte for byte. A file with no front matter gets one.
 */
export function setFields(text: string, fields: Record<string, Scalar | Scalar[]>): string {
  if (!OPEN.test(text)) return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${yamlValue(v)}`).join('\n')}\n---\n${text}`
  const lines = text.split('\n')
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*\r?$/.test(l))
  if (end === -1) throw new Error('front matter has no closing ---')
  const todo = new Map(Object.entries(fields))
  const out: string[] = [lines[0]!]
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:/.exec(line)
    const key = m?.[1]
    if (key !== undefined && todo.has(key)) {
      out.push(`${key}: ${yamlValue(todo.get(key)!)}`)
      todo.delete(key)
      // Drop the old value's block-list items.
      while (i + 1 < end && /^[ \t]*-[ \t]+/.test(lines[i + 1]!)) i++
      continue
    }
    out.push(line)
  }
  for (const [k, v] of todo) out.push(`${k}: ${yamlValue(v)}`)

  return [...out, ...lines.slice(end)].join('\n')
}
