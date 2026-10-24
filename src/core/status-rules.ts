// The status rules of spec 05 §3.4, shared by database backends (the Files index applies the same rules inline).
// Rejected and archived nodes are dropped; superseded ones are replaced by their newest live version;
// inbox nodes stay only when asked for. A node reached twice keeps its best score.

import type { Status } from './model.ts'
import type { Scored } from './store.ts'

export interface RawHit {
  id: string
  score: number
  why: string[]
}

export async function applyStatusRules(
  hits: RawHit[],
  opts: {
    includeInbox: boolean
    limit: number
    /** Status and title of each id (missing ids are dropped). */
    lookup: (ids: string[]) => Promise<Map<string, { status: Status; title: string }>>
    head: (id: string) => Promise<string>
  },
): Promise<Scored[]> {
  const info = await opts.lookup(hits.map(h => h.id))
  const best = new Map<string, Scored>()
  for (const h of hits) {
    const n = info.get(h.id)
    if (!n || n.status === 'rejected' || n.status === 'archived' || (n.status === 'inbox' && !opts.includeInbox)) continue
    let id = h.id
    let replaces: string | undefined
    if (n.status === 'superseded') {
      const head = await opts.head(h.id)
      const hn = head === h.id ? undefined : (info.get(head) ?? (await opts.lookup([head])).get(head))
      // A superseded node with no live replacement is withheld: it is no longer true.
      if (!hn || hn.status === 'rejected' || hn.status === 'archived' || hn.status === 'superseded') continue
      id = head
      replaces = n.title
    }
    const prev = best.get(id)
    if (!prev || prev.score < h.score) best.set(id, { id, score: h.score, why: h.why, ...(replaces ? { replaces } : {}) })
  }

  return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit)
}
