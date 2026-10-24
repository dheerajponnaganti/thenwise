// The Store interface (spec 07 §3): every backend implements it; retrieval and writing never know which one they use.
// Records are ParsedNote with a guaranteed id. Every method is async so database backends fit the same shape.

import type { EdgeType, NodeType, ParsedNote, Status } from './model.ts'

export type NodeRecord = ParsedNote & { id: string }

export interface Scored {
  id: string
  score: number
  /** "title: sync, budget" and the like: what matched where. */
  why: string[]
  /** Set when a superseded node was replaced by its newest version. */
  replaces?: string
}

export interface SearchQuery {
  text: string
  limit: number
  types?: NodeType[]
  includeInbox: boolean
}

export interface Neighbour {
  id: string
  hop: number
  /** The edge type that reached it. */
  via: EdgeType
  /** The node it was reached from. */
  from: string
}

export interface LinksQuery {
  ids: string[]
  depth: 1 | 2
  types?: EdgeType[]
  limit: number
}

export interface ManifestData {
  rules: NodeRecord[]
  tasks: NodeRecord[]
  /** Entities with the number of live non-entity nodes about them, most first. */
  topics: { node: NodeRecord; count: number }[]
  notes: number
  byType: Record<string, number>
}

export interface StoreStats {
  notes: number
  byType: Record<string, number>
  edges: number
  hubs: number
  unresolved: number
}

/** Fields a writer may set; the store fills id, times, version and file placement. */
export interface NodeInput {
  type: Exclude<NodeType, 'episode'>
  title: string
  summary: string
  body: string
  status: Status
  confidence: ParsedNote['confidence']
  origin: ParsedNote['origin']
  author: string
  aliases?: string[]
  tags?: string[]
  /** Edge targets by title (resolved like body links). */
  edges?: Partial<Record<Exclude<EdgeType, 'mentions'>, string[]>>
  sources?: ParsedNote['sources']
  paths?: string[]
  urls?: string[]
  validFrom?: string
  due?: string
  done?: boolean
}

export class StoreError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid' | 'unavailable'
  constructor(code: StoreError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export interface Store {
  readonly kind: 'files' | 'sqlite' | 'postgres' | 'remote'
  get(id: string): Promise<NodeRecord | null>
  /** Several records without bodies, for ranking and pointers. Missing ids are left out. */
  getMany(ids: string[]): Promise<Map<string, NodeRecord>>
  /** Lexical search with the status rules of spec 05 §3.4 (rejected and archived dropped, superseded redirected, inbox on request). */
  search(q: SearchQuery): Promise<Scored[]>
  /** Node ids whose file source or url equals the key, and ids of entities whose `paths` contain it (longest prefix first). Raw: no status rules. */
  matchExact(key: { path?: string; url?: string }): Promise<{ bySource: string[]; byEntity: string[] }>
  links(q: LinksQuery): Promise<Neighbour[]>
  /** Live edges of the given types touching these nodes, both directions. */
  edgesOf(ids: string[], types: EdgeType[]): Promise<{ type: EdgeType; from: string; to: string }[]>
  /** The newest node replacing `id`, or `id` itself. */
  supersedeHead(id: string): Promise<string>
  isHub(id: string): Promise<boolean>
  manifestData(opts: { maxTopics: number }): Promise<ManifestData>
  stats(): Promise<StoreStats>
  /** Creates a node (or a new version when `expectedVersion` is given for an existing id). */
  put(input: NodeInput, opts: { id?: string; expectedVersion?: number; now: string; newId: (prefix: string) => string }): Promise<NodeRecord>
  /** Changes a node's status (accept, reject, retire). */
  setStatus(id: string, status: Status, opts: { now: string; validTo?: string }): Promise<NodeRecord>
  /** Which of these terms occur anywhere in the store (a confidence signal for the prompt map). Optional. */
  knownTerms?(terms: string[]): Promise<Set<string>>
}
