// Builds the gold set for the retrieval benchmark from the evaluation question sets: for each question, the ids of the
// records in a frozen store that hold its required facts. Gold holds ids only, never answer text.
// Usage: node bench/gold/build.ts [--out ~/.memory/eval/gold/gold.jsonl.gz]
// Each set names its store; a question's gold is chosen among the records of its sources (chats, PRs, commits, notes).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

const EVAL = join(homedir(), '.memory', 'eval')
const GOLD = join(EVAL, 'gold')
// gate-2026-10-24 predates the gate store by a day, so its "current" answers may have changed since: those are left out.
const SETS = [
  { set: 'e2-2026-10-25', store: 'gate', skip: [] as string[] },
  { set: 'gate-2026-10-24', store: 'gate', skip: ['current'] },
  { set: 'state_at', store: 'gate', skip: [] },
  { set: 'e3-2026-10-24', store: 'e3', skip: [] },
]
const CMD: Record<string, string> = { why: 'why', tried: 'tried', current: 'current', state_at: 'asof', when: 'search', connect: 'search' }

interface Q { id: string; kind: string; question: string; as_of: string | null; must: string[][]; must_not?: string[]; sources?: { type: string; ref: string }[] }

const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined)
const out = arg('out') ?? join(GOLD, 'gold.jsonl.gz')
const read = (f: string): Q[] => gunzipSync(readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** Node ids a source points at: every record of a chat, a PR by number, a commit by sha, a note by name. */
function scope(db: DatabaseSync, sources: Q['sources'] = []): Set<string> {
  const ids = new Set<string>()
  const all = (sql: string, ...p: string[]) => (db.prepare(sql).all(...p) as { id: string }[]).forEach((r) => ids.add(r.id))
  for (const s of sources) {
    for (const u of s.ref.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g) ?? []) all("SELECT id FROM nodes WHERE id LIKE ? OR source LIKE ?", `ses:${u}%`, `ses:${u}%`)
    if (s.type === 'pr') for (const n of s.ref.match(/#?(\d+)/g) ?? []) all("SELECT id FROM nodes WHERE kind = 'pr' AND id LIKE ?", `pr:%#${n.replace('#', '')}`)
    if (s.type === 'commit' || s.type === 'git') for (const h of s.ref.match(/\b[0-9a-f]{7,40}\b/g) ?? []) all("SELECT id FROM nodes WHERE kind = 'commit' AND id LIKE ?", `commit:%:${h}%`)
    if (s.type === 'vault' || s.type === 'file') {
      const name = s.ref.split(/[\\/]/).pop()!.replace(/\.md$/, '').replace(/[#§].*$/, '').trim()
      if (name.length >= 4) all("SELECT id FROM nodes WHERE kind IN ('note', 'doc', 'memory', 'section') AND (id LIKE ? OR title LIKE ?)", `%${name}%`, `%${name}%`)
    }
  }

  return ids
}

/** How many required facts a record states: a fact counts when any of its spellings appears. */
const facts = (text: string, must: string[][]) => must.filter((alts) => alts.some((a) => text.includes(a.toLowerCase()))).length

const lines: string[] = []
const report: string[] = []
for (const { set, store, skip } of SETS) {
  const f = join(EVAL, `${set}.jsonl.gz`)
  const dbFile = join(GOLD, store, 'graph.db')
  if (!existsSync(f) || !existsSync(dbFile)) throw new Error(`missing ${existsSync(f) ? dbFile : f}`)
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const textOf = db.prepare("SELECT lower(coalesce(n.title, '') || ' ' || coalesce(group_concat(p.text, ' '), n.text, '')) t FROM nodes n LEFT JOIN passages p ON p.node = n.id WHERE n.id = ? GROUP BY n.id")
  const every = (db.prepare("SELECT id FROM nodes WHERE kind NOT IN ('file', 'session')").all() as { id: string }[]).map((r) => r.id)
  for (const q of read(f)) {
    const cmd = CMD[q.kind]
    if (!cmd || skip.includes(q.kind) || !q.must?.length) continue
    const score = (id: string) => facts(String((textOf.get(id) as { t: string } | undefined)?.t ?? ''), q.must)
    const own = [...scope(db, q.sources)].filter((id) => !id.startsWith('ses:') && !id.startsWith('file:'))
    let pool = own.map((id) => ({ id, n: score(id) })).filter((x) => x.n > 0)
    // A source the store does not hold (or names loosely): look everywhere, but ask for at least half the facts.
    if (!pool.length) pool = every.map((id) => ({ id, n: score(id) })).filter((x) => x.n >= Math.ceil(q.must.length / 2))
    const best = Math.max(0, ...pool.map((x) => x.n))
    if (!best) {
      report.push(`${q.id}: no record holds its facts, left out`)
      continue
    }
    const gold = pool.filter((x) => x.n === best).map((x) => x.id).sort().slice(0, 8)
    // Elsewhere, a record with every fact is an acceptable answer too.
    const acceptable = [...pool.filter((x) => x.n < best).map((x) => x.id), ...(best === q.must.length ? every.filter((id) => !gold.includes(id) && !own.includes(id) && score(id) === best) : [])].sort().slice(0, 20)
    lines.push(JSON.stringify({ id: q.id, set, store, kind: q.kind, cmd, query: q.question, ...(q.as_of ? { date: q.as_of } : {}), gold, acceptable }))
    report.push(`${q.id}: ${gold.length} gold (${best} of ${q.must.length} facts${own.length ? '' : ', found outside its sources'}), ${acceptable.length} acceptable`)
  }
  db.close()
}
writeFileSync(out, gzipSync(`${lines.join('\n')}\n`), { mode: 0o600 })
console.log(report.join('\n'))
console.log(`\n${lines.length} gold lines written to ${out}`)
