// Teams preview client. Only notes the person marks shared are sent, never chats. The server url, the token and the
// queue of unsent changes live in <data folder>/team.json (mode 0600), never in a vault.

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import { parseFrontMatter } from '../core/frontmatter.ts'
import { logger } from '../core/log.ts'
import { takeLock } from '../hooks/hook.ts'
import { maskSecrets } from '../core/secrets.ts'
import { makeId, readNotes } from '../capture/notes.ts'

export const LABEL = 'teams preview'
// A read is small; a share can be 100 KB over a slow link, and a timeout that is too short would retry it forever.
const TIMEOUT_MS = { GET: 5000, PUT: 20000, DELETE: 20000 } as Record<string, number>

interface Op {
  op: 'put' | 'del'
  id: string
  /** The local order of the queue (a later change to one note replaces the earlier one). */
  rev: number
  /** When the change was made here, to tell whose copy is newer when the team's has moved on. */
  at?: number
  note?: Payload
}
export interface Payload {
  title: string
  text: string
  project: string
}
interface State {
  url: string
  token: string
  lastRev: number
  /** The team's revision of each note this machine shared (0 while it was never accepted), and whether a change waits. */
  shared: Record<string, { rev: number; title: string; pending?: boolean }>
  queue: Op[]
  /** Set when the server refused the token: syncs stop until a new join. */
  refused?: string
}

const stateFile = (dir: string) => join(dir, 'team.json')

function load(dir: string): State {
  if (!existsSync(stateFile(dir))) throw new Error('not joined to a team: run `thenwise team join <url> <token>`')

  return JSON.parse(readFileSync(stateFile(dir), 'utf8'))
}

function save(dir: string, s: State) {
  const tmp = `${stateFile(dir)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, stateFile(dir))
}

/** Plain http is for this machine only: a token over http to another host can be read on the way. */
export function checkUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`not a url: ${url}`)
  }
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  // The path stays: a server behind a proxy at /thenwise answers at /thenwise/v1/...
  if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  throw new Error(u.protocol === 'http:' ? `refused: plain http to ${u.hostname}. Use https, or a server on localhost.` : `refused: ${u.protocol} is not supported`)
}

async function call(s: State, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${checkUrl(s.url)}/v1${path}`, { method, headers: { authorization: `Bearer ${s.token}`, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(TIMEOUT_MS[method] ?? 5000) })

  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const errText = (json: any) => (typeof json?.error === 'string' ? json.error : json?.error?.message ?? '')

/** Joins, or rejoins with a new token: a rejoin to the same server keeps what this machine shared and its queue. */
export async function joinTeam(dir: string, url: string, token: string): Promise<string> {
  const old = existsSync(stateFile(dir)) ? load(dir) : undefined
  const s: State = old && old.url === checkUrl(url) ? { ...old, token, refused: undefined } : { url: checkUrl(url), token, lastRev: 0, shared: {}, queue: [] }
  const r = await call(s, 'GET', '/me')
  if (r.status !== 200) throw new Error(r.status === 401 ? 'the server refused the token' : `the server answered ${r.status}`)
  save(dir, s)

  return r.json.name
}

/** Rebuilds the list of notes this machine has on the team from the server, for a machine that lost it. */
export async function pull(dir: string): Promise<string> {
  const mine: Record<string, { rev: number; title: string }> = {}
  for (let offset = 0; ; offset += 200) {
    const r = await call(load(dir), 'GET', `/notes?owner=me&limit=200&offset=${offset}`)
    if (r.status !== 200) throw new Error(`the server answered ${r.status}${errText(r.json) ? `: ${errText(r.json)}` : ''}`)
    for (const n of r.json.notes) mine[n.id] = { rev: n.rev, title: n.title }
    if (r.json.notes.length < 200) break
  }
  locked(dir, () => {
    const s = load(dir)
    // A change still waiting here wins over the server's list.
    s.shared = { ...mine, ...Object.fromEntries(Object.entries(s.shared).filter(([, v]) => v.pending)) }
    save(dir, s)
  })

  return `${Object.keys(mine).length} shared notes on the team (${LABEL})`
}

/** What a share would send. The send-time mask runs here, on top of any masking the note already had. */
export function payloadOf(n: Payload): { payload: Payload; masked: number } {
  const t = maskSecrets(n.text)
  const h = maskSecrets(n.title)
  const p = maskSecrets(n.project)

  return { payload: { title: h.text, text: t.text, project: p.text }, masked: t.count + h.count + p.count }
}

/** A curated note id, or a Markdown file. Chats and anything under the Claude folder are refused. */
export function resolveNote(memDir: string, claudeDir: string, arg: string): Payload & { id: string } {
  const path = resolve(arg)
  if (existsSync(path)) {
    if (!path.endsWith('.md')) throw new Error('only Markdown notes can be shared')
    if (path.startsWith(resolve(claudeDir) + sep)) throw new Error('chat files are never shared')
    const fm = parseFrontMatter(readFileSync(path, 'utf8'))
    const d = (k: string) => (typeof fm.data[k] === 'string' ? (fm.data[k] as string) : '')

    return { id: d('id') || makeId('f', path), title: d('title') || /^#\s+(.+)$/m.exec(fm.body)?.[1] || basename(path, '.md'), text: fm.body.trim(), project: d('project') }
  }
  const c = readNotes(memDir).find((n) => n.id === arg && n.status === 'active')
  if (!c) throw new Error(`${arg}: no such file, and no active note with that id`)

  return { id: c.id, title: c.title, text: parseFrontMatter(readFileSync(c.path, 'utf8')).body.trim() || c.summary, project: c.project }
}

/** Serializes load-modify-save across processes. Never wrap a network call in it. */
export function locked<T>(dir: string, fn: () => T): T {
  const lock = join(dir, 'team.lock')
  const end = Date.now() + 2000
  while (!takeLock(lock)) {
    if (Date.now() > end) throw new Error('the team queue is busy; try again')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

// A note counts as shared once the team accepted it; until then it is pending.
function enqueue(s: State, o: Op) {
  s.lastRev = Math.max(Date.now(), s.lastRev + 1)
  s.queue = [...s.queue.filter((q) => q.id !== o.id), { ...o, rev: s.lastRev, at: Date.now() }]
  const was = s.shared[o.id]
  if (o.op === 'put' || was) s.shared[o.id] = { rev: was?.rev ?? 0, title: o.note?.title ?? was!.title, pending: true }
}

export async function share(dir: string, id: string, payload: Payload): Promise<string> {
  locked(dir, () => {
    const s = load(dir)
    enqueue(s, { op: 'put', id, rev: 0, note: payload })
    save(dir, s)
  })
  logger('teams', dir).info('queued', { id, op: 'put' })

  return flush(dir)
}

export async function unshare(dir: string, id: string): Promise<string> {
  locked(dir, () => {
    const s = load(dir)
    enqueue(s, { op: 'del', id, rev: 0 })
    save(dir, s)
  })
  logger('teams', dir).info('queued', { id, op: 'del' })

  const msg = await flush(dir)

  return `${load(dir).queue.some((q) => q.id === id) ? 'unshare queued, not done yet' : 'unshared'}: ${msg}`
}

/**
 * Sends the queue in order, each change with the team revision it was made on (If-Match). Only 2xx is sent. A 409
 * means the team's copy moved on (another machine of the same person): a share is sent again over it once when this
 * copy is newer, else the team's copy is kept and reported; an unshare is sent again. Other 4xx is refused and dropped.
 * 5xx and network errors stay queued. A refused token stops every later sync until a new join.
 */
export async function flush(dir: string): Promise<string> {
  let sent = 0
  const refused: string[] = []
  const newer: string[] = []
  const tail = () => `${refused.length ? `; refused: ${refused.join('; ')}` : ''}${newer.length ? `; the team has a newer copy of ${newer.join(', ')}: \`team pull\`, or share again` : ''} (${LABEL})`
  if (load(dir).refused) return `the server refused your token; ask for a new invite (${LABEL})`
  for (const o of load(dir).queue) {
    const s = load(dir)
    const send = (rev: number) => {
      const match = { 'if-match': rev > 0 ? String(rev) : '*' }

      // The mask runs again at send time, so a queue written before a pattern change is still clean.
      return o.op === 'put' ? call(s, 'PUT', `/notes/${encodeURIComponent(o.id)}`, { ...payloadOf(o.note!).payload, seq: o.rev }, match) : call(s, 'DELETE', `/notes/${encodeURIComponent(o.id)}?seq=${o.rev}`, undefined, match)
    }
    let r: { status: number; json: any }
    try {
      r = await send(s.shared[o.id]?.rev ?? 0)
      if (r.status === 409 && r.json?.error?.code === 'stale') {
        const theirs = Number(r.json.rev ?? 0)
        if (o.op === 'del' || (o.at ?? 0) > Number(r.json.updated_at ?? 0)) r = await send(theirs)
        else {
          newer.push(o.id)
          r = { status: 200, json: { rev: theirs, kept: true } }
        }
      }
    } catch {
      const left = load(dir).queue.length
      logger('teams', dir).warn('unreachable', { sent, waiting: left })

      return `${sent} sent; server not reachable, ${left} change${left === 1 ? '' : 's'} waiting${tail()}`
    }
    const { status, json } = r
    if (status === 401) {
      locked(dir, () => save(dir, { ...load(dir), refused: new Date().toISOString() }))
      logger('teams', dir).error('token_refused', { sent })

      return `${sent} sent; the server refused your token; ask for a new invite${tail()}`
    }
    if (status >= 500 || status === 429) {
      logger('teams', dir).warn('server_error', { status, sent })

      return `${sent} sent; the server answered ${status}, ${load(dir).queue.length} waiting${tail()}`
    }
    // An unshare made later already reached the team: the share is done, as unshared.
    const unsharedLater = status === 409 && json?.error?.code === 'unshared'
    const ok = (status >= 200 && status < 300) || unsharedLater
    // A refused share must not stay marked as shared.
    if (!ok) logger('teams', dir).warn('refused', { id: o.id, op: o.op, status })
    if (!ok) refused.push(`${o.id} (${status}${errText(json) ? ` ${errText(json)}` : ''})`)
    locked(dir, () => {
      const after = load(dir)
      const later = after.queue.some((q) => q.id === o.id && q.rev !== o.rev)
      after.queue = after.queue.filter((q) => !(q.id === o.id && q.rev === o.rev))
      if (ok && o.op === 'put' && !unsharedLater) after.shared[o.id] = { rev: json.rev, title: o.note!.title, ...(later ? { pending: true } : {}) }
      else if (ok || !after.shared[o.id]?.rev) delete after.shared[o.id]
      else if (!later) after.shared[o.id] = { ...after.shared[o.id]!, pending: false }
      save(dir, after)
    })
    if (ok && !json.kept && !unsharedLater) sent++
  }

  if (sent || refused.length) logger('teams', dir).info('sent', { sent, refused: refused.length })

  return `${sent} sent; nothing waiting${tail()}`
}

export async function search(dir: string, q: string): Promise<string[]> {
  const r = await call(load(dir), 'GET', `/search?q=${encodeURIComponent(q)}`)
  if (r.status !== 200) throw new Error(`the server answered ${r.status}${errText(r.json) ? `: ${errText(r.json)}` : ''}`)

  return r.json.notes.map((n: any) => `${n.owner}/${n.id}  ${n.title}${n.project ? `  [${n.project}]` : ''}\n   ${n.snippet.replace(/\s+/g, ' ')}`)
}

/** Notes the team has accepted from this machine. */
export const sharedIds = (dir: string) => Object.entries(load(dir).shared).filter(([, v]) => v.rev > 0).map(([id]) => id)

/** For `thenwise status`: a refused token, and the changes still waiting. Empty when not joined. */
export function teamStatus(dir: string): string[] {
  if (!existsSync(stateFile(dir))) return []
  const s = load(dir)
  if (s.refused) return ['team: the server refused your token; ask for a new invite, then `thenwise team join`']
  const shared = Object.values(s.shared).filter((v) => v.rev > 0).length

  return [`team: ${shared} note${shared === 1 ? '' : 's'} shared${s.queue.length ? `, ${s.queue.length} change${s.queue.length === 1 ? '' : 's'} waiting to send` : ''} (${LABEL})`]
}
