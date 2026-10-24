// The write path (spec 06): the agent's one write tool, acceptance and rejection.
// Every agent write lands in the inbox; nothing it writes reaches the manifest until a person accepts it.

import { similarity } from './doctor.ts'
import type { EdgeType, NodeType, Source } from './model.ts'
import { maskSecrets } from './secrets.ts'
import { StoreError } from './store.ts'
import type { NodeInput, NodeRecord, Store } from './store.ts'

export const AGENT_TYPES = ['decision', 'finding', 'entity', 'rule', 'task'] as const
export type AgentType = (typeof AGENT_TYPES)[number]
const LINK_FIELDS = ['about', 'supersedes', 'depends_on', 'contradicts', 'part_of', 'derived_from'] as const
type LinkField = (typeof LINK_FIELDS)[number]

export interface WriteRequest {
  type: AgentType
  title: string
  summary: string
  body?: string
  about?: string[]
  supersedes?: string[]
  depends_on?: string[]
  contradicts?: string[]
  part_of?: string[]
  derived_from?: string[]
  sources?: { kind: 'file' | 'url' | 'commit' | 'human'; ref: string; at?: string }[]
  aliases?: string[]
  /** Update this agent-written node (same id, next version). */
  update_of?: string | null
  /** Write even though a similar note exists. */
  force_new?: boolean
}

export interface WriteContext {
  store: Store
  now: string
  author: string
  newId: (prefix: string) => string
  /** How many writes this job already made (the rate limit counts them). */
  jobWrites: number
  /** 'web' when the job fetched pages; set by the host from what it observed. */
  origin: 'local' | 'web'
  /** The current hash of a cited file (commit sha or fnv1a content hash), filled by the host, never by the agent. */
  fileHash?: (ref: string) => Promise<string | null>
}

export type WriteResult = { ok: true; node: NodeRecord; message: string; created: NodeRecord[] } | { ok: false; message: string }

export const LIMITS = { title: 120, summary: 200, body: 20_000, perJob: 3, newEntitiesPerCall: 2, duplicate: 0.6 }

const fail = (message: string): WriteResult => ({ ok: false, message })

/** A title or alias that names exactly one live note. */
async function resolveTitle(store: Store, name: string): Promise<NodeRecord | null> {
  const hits = await store.search({ text: name, limit: 10, includeInbox: true })
  const meta = await store.getMany(hits.map(h => h.id))
  const k = name.trim().toLowerCase()
  const exact = [...meta.values()].filter(n => n.status !== 'rejected' && (n.title.toLowerCase() === k || n.aliases.some(a => a.toLowerCase() === k)))

  return exact.length === 1 ? exact[0]! : null
}

/** The agent's write tool, checked in the order of spec 06 §3. Nothing is written unless every check passes. */
export async function memoryWrite(req: WriteRequest, ctx: WriteContext): Promise<WriteResult> {
  // 1. Schema.
  if (!AGENT_TYPES.includes(req.type)) return fail(`type must be one of ${AGENT_TYPES.join(', ')}`)
  const title = (req.title ?? '').replace(/\s+/g, ' ').trim()
  const summary = (req.summary ?? '').replace(/\s+/g, ' ').trim()
  if (!title || title.length > LIMITS.title) return fail(`title is required, at most ${LIMITS.title} characters`)
  if (!summary || summary.length > LIMITS.summary) return fail(`summary is required, one sentence, at most ${LIMITS.summary} characters`)
  if ((req.body ?? '').length > LIMITS.body) return fail(`body is over ${LIMITS.body} characters; keep the note short and link to the source instead`)
  // 2. A finding needs a dated source.
  if (req.type === 'finding' && !(req.sources ?? []).some(s => s.at)) return fail('a finding needs at least one source with a date (sources: [{kind, ref, at}])')
  // Rules shape every later session; one from web content could be an injection.
  if (req.type === 'rule' && ctx.origin === 'web') return fail('a rule cannot be written in a job that fetched web pages; ask the user to write it')
  // 6. Rate limit (checked early: nothing else matters once it is reached).
  if (ctx.jobWrites >= LIMITS.perJob) return fail(`limit reached (${LIMITS.perJob} notes per job); put the rest in one note`)
  // 3. Secrets, before anything else touches the text.
  const mask = (s: string) => maskSecrets(s).text
  const body = mask(req.body ?? '')
  const safeTitle = mask(title)
  const safeSummary = mask(summary)
  // 4. Links resolve; at most two missing `about` targets become inbox entities.
  const edges: Partial<Record<LinkField, string[]>> = {}
  const missingAbout: string[] = []
  for (const field of LINK_FIELDS) {
    for (const name of req[field] ?? []) {
      const hit = await resolveTitle(ctx.store, name)
      if (hit) (edges[field] ??= []).push(hit.title)
      else if (field === 'about') missingAbout.push(name.trim())
      else return fail(`${field}: no single note is called "${name}"`)
    }
  }
  if (missingAbout.length > LIMITS.newEntitiesPerCall) return fail(`about: ${missingAbout.length} unknown topics (${missingAbout.join(', ')}); at most ${LIMITS.newEntitiesPerCall} new ones per call`)
  // 5. Duplicates (and proposals already rejected).
  const existing = req.update_of ? await ctx.store.get(req.update_of) : null
  if (req.update_of && !existing) return fail(`update_of: no note ${req.update_of}`)
  if (!req.update_of && !req.force_new) {
    const hits = await ctx.store.search({ text: `${title} ${summary}`, limit: 5, includeInbox: true, types: [req.type as NodeType] })
    // Rejected notes are invisible to search, so check them by title too.
    const meta = await ctx.store.getMany(hits.map(h => h.id))
    for (const n of meta.values()) {
      if (similarity(n.title, title) >= LIMITS.duplicate || n.summary.toLowerCase() === summary.toLowerCase()) return fail(`possible duplicate: "${n.title}" (${n.id}). Call again with update_of: ${n.id} to update it, or force_new: true.`)
    }
  }
  // 7. File sources get the current hash from the host.
  const sources: Source[] = []
  for (const s of req.sources ?? []) {
    const hash = s.kind === 'file' && ctx.fileHash ? await ctx.fileHash(s.ref) : null
    sources.push({ kind: s.kind, ref: mask(s.ref), hash, at: s.at ?? null })
  }

  const created: NodeRecord[] = []
  for (const name of missingAbout) {
    created.push(await ctx.store.put({ type: 'entity', title: name, summary: `Proposed topic: ${name}.`, body: '', status: 'inbox', confidence: 'agent', origin: ctx.origin, author: ctx.author }, { now: ctx.now, newId: ctx.newId }))
    ;(edges.about ??= []).push(name)
  }
  const input: NodeInput = {
    type: req.type,
    title: safeTitle,
    summary: safeSummary,
    body,
    status: 'inbox',
    confidence: 'agent',
    origin: ctx.origin,
    author: ctx.author,
    edges: edges as NodeInput['edges'],
    sources,
    ...(req.aliases?.length ? { aliases: req.aliases.map(mask) } : {}),
  }
  try {
    if (existing && existing.confidence === 'agent') {
      const node = await ctx.store.put({ ...input, status: existing.status === 'active' ? 'active' : 'inbox' }, { id: existing.id, expectedVersion: existing.version, now: ctx.now, newId: ctx.newId })

      return { ok: true, node, created, message: `updated "${node.title}" to version ${node.version}` }
    }
    if (existing) {
      // A person's note is never rewritten: propose a replacement that supersedes it, pending acceptance.
      const node = await ctx.store.put({ ...input, edges: { ...input.edges, supersedes: [...(input.edges?.supersedes ?? []), existing.title] } }, { now: ctx.now, newId: ctx.newId })

      return { ok: true, node, created, message: `"${existing.title}" was written by a person, so a replacement was proposed in the inbox: "${node.title}"` }
    }
    const node = await ctx.store.put(input, { now: ctx.now, newId: ctx.newId })

    return { ok: true, node, created, message: `saved to the inbox: "${node.title}" (${node.id}); it is used once accepted` }
  } catch (e) {
    if (e instanceof StoreError) return fail(e.message)
    throw e
  }
}

/** Accepting a note makes it active; the notes it supersedes become superseded from its valid date. */
export async function acceptNode(store: Store, id: string, now: string): Promise<NodeRecord> {
  const node = await store.setStatus(id, 'active', { now })
  for (const e of await store.edgesOf([id], ['supersedes' as EdgeType])) {
    if (e.from !== id) continue
    await store.setStatus(e.to, 'superseded', { now, validTo: node.validFrom ?? now.slice(0, 10) })
  }

  return node
}

export const rejectNode = (store: Store, id: string, now: string) => store.setStatus(id, 'rejected', { now })
