// Teams preview client. Only notes the person marks shared are sent, never chats. The server url, the token and the
// queue of unsent changes live in <data folder>/team.json (mode 0600), never in a vault.

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import { parseFrontMatter } from '../core/frontmatter.ts'
import { takeLock } from '../hooks/hook.ts'
import { maskSecrets } from '../core/secrets.ts'
import { makeId, readNotes } from '../capture/notes.ts'

export const LABEL = 'teams preview'
const TIMEOUT_MS = 3000

interface Op {
  op: 'put' | 'del'
  id: string
  rev: number
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
  shared: Record<string, { rev: number; title: string }>
  queue: Op[]
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
  if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin
  throw new Error(u.protocol === 'http:' ? `refused: plain http to ${u.hostname}. Use https, or a server on localhost.` : `refused: ${u.protocol} is not supported`)
}

async function call(s: State, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${checkUrl(s.url)}${path}`, { method, headers: { authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(TIMEOUT_MS) })

  return { status: res.status, json: await res.json().catch(() => ({})) }
}

export async function joinTeam(dir: string, url: string, token: string): Promise<string> {
  const s: State = { url: checkUrl(url), token, lastRev: 0, shared: {}, queue: [] }
  const r = await call(s, 'GET', '/me')
  if (r.status !== 200) throw new Error(r.status === 401 ? 'the server refused the token' : `the server answered ${r.status}`)
  save(dir, s)

  return r.json.name
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

function enqueue(s: State, o: Op) {
  s.lastRev = Math.max(Date.now(), s.lastRev + 1)
  s.queue = [...s.queue.filter((q) => q.id !== o.id), { ...o, rev: s.lastRev }]
  if (o.op === 'put') s.shared[o.id] = { rev: s.lastRev, title: o.note!.title }
  else delete s.shared[o.id]
}

export async function share(dir: string, id: string, payload: Payload): Promise<string> {
  locked(dir, () => {
    const s = load(dir)
    enqueue(s, { op: 'put', id, rev: 0, note: payload })
    save(dir, s)
  })

  return flush(dir)
}

export async function unshare(dir: string, id: string): Promise<string> {
  locked(dir, () => {
    const s = load(dir)
    enqueue(s, { op: 'del', id, rev: 0 })
    save(dir, s)
  })

  return flush(dir)
}

/** Sends the queue in order. A network failure leaves the rest waiting; nothing here throws into a chat. */
export async function flush(dir: string): Promise<string> {
  let sent = 0
  for (const o of load(dir).queue) {
    const s = load(dir)
    try {
      // The mask runs again at send time, so a queue written before a pattern change is still clean.
      const r = o.op === 'put' ? await call(s, 'PUT', `/notes/${encodeURIComponent(o.id)}`, { ...payloadOf(o.note!).payload, rev: o.rev }) : await call(s, 'DELETE', `/notes/${encodeURIComponent(o.id)}?rev=${o.rev}`)
      if (r.status === 401) return `${sent} sent; the server refused the token (${LABEL})`
    } catch {
      const left = load(dir).queue.length

      return `${sent} sent; server not reachable, ${left} change${left === 1 ? '' : 's'} waiting (${LABEL})`
    }
    locked(dir, () => {
      const after = load(dir)
      after.queue = after.queue.filter((q) => !(q.id === o.id && q.rev === o.rev))
      save(dir, after)
    })
    sent++
  }

  return `${sent} sent; nothing waiting (${LABEL})`
}

export async function search(dir: string, q: string): Promise<string[]> {
  const r = await call(load(dir), 'GET', `/search?q=${encodeURIComponent(q)}`)
  if (r.status !== 200) throw new Error(`the server answered ${r.status}`)

  return r.json.notes.map((n: any) => `${n.owner}/${n.id}  ${n.title}${n.project ? `  [${n.project}]` : ''}\n   ${n.snippet.replace(/\s+/g, ' ')}`)
}

export const sharedIds = (dir: string) => Object.keys(load(dir).shared)
