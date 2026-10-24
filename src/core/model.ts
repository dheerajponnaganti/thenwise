// The data model. Backends implement it; they never extend it silently.

export const SCHEMA_VERSION = 1

export const NODE_TYPES = ['decision', 'finding', 'entity', 'rule', 'task', 'episode', 'note'] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const STATUSES = ['inbox', 'active', 'superseded', 'archived', 'rejected'] as const
export type Status = (typeof STATUSES)[number]

export const CONFIDENCES = ['observed', 'human', 'agent', 'imported'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const ORIGINS = ['local', 'web', 'import'] as const
export type Origin = (typeof ORIGINS)[number]

export const EDGE_TYPES = ['about', 'supersedes', 'depends_on', 'contradicts', 'part_of', 'derived_from', 'mentions'] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

/** Edge types written as front-matter lists; `mentions` come from body links. */
export const FRONT_MATTER_EDGES = EDGE_TYPES.filter((t): t is Exclude<EdgeType, 'mentions'> => t !== 'mentions')

export const SOURCE_KINDS = ['file', 'url', 'commit', 'command', 'node', 'human'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const ID_PREFIX: Record<NodeType, string> = {
  decision: 'dec',
  finding: 'fnd',
  entity: 'ent',
  rule: 'rul',
  task: 'tsk',
  episode: 'epi',
  note: 'not',
}

export interface Source {
  kind: SourceKind
  ref: string
  /** Content hash or commit sha at observation; null when unknown. */
  hash: string | null
  /** Date the source was observed (YYYY-MM-DD or full time); null when unknown. */
  at: string | null
}

/** One note as it exists in a vault: what the parser reads, before links are resolved. */
export interface ParsedNote {
  path: string
  /** null when the file has no id yet (hand notes before import). */
  id: string | null
  type: NodeType
  title: string
  summary: string
  aliases: string[]
  tags: string[]
  status: Status
  confidence: Confidence
  origin: Origin
  validFrom: string | null
  validTo: string | null
  recordedAt: string | null
  updatedAt: string | null
  version: number
  author: string
  sources: Source[]
  paths: string[]
  urls: string[]
  done: boolean | null
  due: string | null
  headings: string[]
  body: string
  bodyLines: number
  /** Raw link targets per edge type, unresolved. */
  links: { type: EdgeType; target: string }[]
  /** Problems found while reading this one file. */
  issues: string[]
  /** True when the file had YAML front matter. */
  hasFrontMatter: boolean
}

export interface Edge {
  type: EdgeType
  from: string
  to: string
}
