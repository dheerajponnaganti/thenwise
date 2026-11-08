// `thenwise export` and `thenwise import`: one project's chats as a single file to hand to someone, and the way in on
// the other side. The file holds exactly what team sharing would send (masked, scrubbed, repo-relative paths, no tool
// output, nothing from [no-memory], paused or forgotten chats), in the chat cache's schema. An import is a teammate's
// chats with no server: they join the memory at the next ingest as "chat of <name> (imported)".

import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { maskSecrets } from '../core/secrets.ts'
import type { Config } from '../ingest/config.ts'
import { chatsIn, dropChat, importsFile, loadImports, openChatCache, openChatFile, putChat } from './chatcache.ts'
import type { WireChat } from './chatcache.ts'
import { formatPreview, previewShare } from './chats.ts'
import type { Built } from './chats.ts'
import { confirm } from './cli.ts'
import { load } from './client.ts'
import { chatUnit } from './http.ts'
import { ID_RE, NAME_RE } from './server.ts'

/** Writes built chats into a new file under `name`. */
export function writeExport(file: string, name: string, built: Built[]): void {
  const db = openChatFile(file)
  try {
    db.exec('BEGIN')
    for (const b of built) putChat(db, { owner: name, session: b.session, rev: 1, bytes: b.bytes, ...b.unit, tool: b.unit.tool ?? '' })
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  chmodSync(file, 0o600)
}

/** The chats in an export file, each checked as the team server checks a shared chat. Throws on anything else. */
export function readExport(file: string): WireChat[] {
  if (!existsSync(file)) throw new Error(`${file} does not exist`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
    db.prepare('SELECT owner FROM chats LIMIT 1').all()
    db.prepare('SELECT text FROM passages LIMIT 1').all()
  } catch {
    throw new Error(`${file} is not a Thenwise export`)
  }
  try {
    return chatsIn(db).map((c) => {
      if (!NAME_RE.test(String(c.owner)) || !ID_RE.test(String(c.session))) throw new Error(`${file} has a chat with a bad name or id`)
      const { owner, session, rev: _rev, ...unit } = c
      let u
      try {
        u = chatUnit(unit as unknown as Record<string, unknown>)
      } catch (e) {
        throw new Error(`${file}: chat ${c.session}: ${(e as Error).message}`)
      }
      // Masked again here: the file may come from an older Thenwise or be made by hand, and nothing is stored unmasked.
      const m = (t: string) => maskSecrets(t).text
      const turns = u.turns.map((t) => ({ ...t, line: m(t.line), passages: t.passages.map(m), paths: t.paths.map(m), dead_text: m(t.dead_text) }))
      return { ...u, head: m(u.head), turns, owner, session, rev: 1 }
    })
  } finally {
    db.close()
  }
}

/** Adds chats to this machine's chat cache and remembers which ones came from an import. A chat the team sync already
 * brought is left as it is, so an import never replaces it and `--remove` never takes it. Returns how many were added. */
export function importChats(dir: string, chats: WireChat[]): { added: number; synced: number } {
  const db = openChatCache(dir)
  const seen = loadImports(dir)
  let added = 0
  try {
    db.exec('BEGIN')
    for (const c of chats) {
      const had = db.prepare('SELECT 1 FROM chats WHERE owner = ? AND session = ?').get(c.owner, c.session)
      if (had && !(seen[c.owner] ?? []).includes(c.session)) continue
      putChat(db, c)
      seen[c.owner] = [...new Set([...(seen[c.owner] ?? []), c.session])]
      added++
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  writeFileSync(importsFile(dir), JSON.stringify(seen, null, 2), { mode: 0o600 })
  return { added, synced: chats.length - added }
}

/** Removes the chats imported under `name`, and only those: a teammate's synced chats stay. */
export function removeImported(dir: string, name: string): number {
  const seen = loadImports(dir)
  const ids = seen[name] ?? []
  if (!ids.length) return 0
  const db = openChatCache(dir)
  try {
    for (const s of ids) dropChat(db, name, s)
  } finally {
    db.close()
  }
  delete seen[name]
  writeFileSync(importsFile(dir), JSON.stringify(seen, null, 2), { mode: 0o600 })
  return ids.length
}

/** The name the reader sees: this member's team name when joined, so a teammate never sees one person twice; else the login. */
function defaultName(dir: string): string {
  try {
    const me = load(dir).me
    if (me) return me
  } catch { /* not joined to a team */ }
  try {
    return userInfo().username.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32) || 'me'
  } catch {
    return 'me' // no account entry for this user, as in some containers
  }
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** `thenwise export [<repo>] --out <file> [--since <date>] [--name <name>] [--yes]` and `thenwise import <file> [--yes] | --remove <name>`. */
export async function exportMain(cmd: 'export' | 'import', cfg: Config, args: string[], flag: (n: string) => string | undefined): Promise<number> {
  const yes = process.argv.includes('--yes')
  if (cmd === 'import') {
    const gone = flag('remove')
    if (gone) {
      const n = removeImported(cfg.memDir, gone)
      console.log(n ? `removed ${n} imported chat${n === 1 ? '' : 's'} of ${gone}; they leave the memory at the next sync` : `no imported chats of ${gone}`)
      return 0
    }
    if (!args[0]) return (console.error('usage: thenwise import <file> [--yes] | thenwise import --remove <name>'), 2)
    let chats: WireChat[]
    try {
      chats = readExport(args[0])
    } catch (e) {
      return (console.error((e as Error).message), 1)
    }
    if (!chats.length) return (console.log('the file holds no chats'), 1)
    const owners = [...new Set(chats.map((c) => c.owner))]
    const projects = [...new Set(chats.map((c) => c.project))]
    console.log(`import: ${chats.length} chat${chats.length === 1 ? '' : 's'} of ${owners.join(', ')} in ${projects.join(', ')}, from ${day(Math.min(...chats.map((c) => c.started_at)))} to ${day(Math.max(...chats.map((c) => c.ended_at)))}\n  they stay on this machine and show in answers as "chat of ${owners[0]} (imported)"\n  \`thenwise import --remove ${owners[0]}\` takes them out again`)
    if (!yes && !(await confirm('Add these chats to your memory? Type yes: '))) return (console.log('not imported'), 1)
    const r = importChats(cfg.memDir, chats)
    console.log(`imported ${r.added} chat${r.added === 1 ? '' : 's'}${r.synced ? `; ${r.synced} your team sync already brought stay as they are` : ''}; they join the memory at the next sync, or now with \`thenwise ingest\``)
    return 0
  }

  const out = flag('out')
  const since = flag('since')
  const name = flag('name') ?? defaultName(cfg.memDir)
  if (!out) return (console.error('usage: thenwise export [<repo path>] --out <file> [--since <date>] [--name <name>] [--yes]'), 2)
  if (existsSync(out)) return (console.error(`${out} already exists; pick another --out`), 2)
  if (since && Number.isNaN(Date.parse(since))) return (console.error(`--since needs a date such as 2026-01-31, found ${since}`), 2)
  if (!NAME_RE.test(name)) return (console.error('--name is lower-case letters, digits, - and _, up to 32 characters'), 2)
  const built: Built[] = []
  let pv
  try {
    pv = previewShare(cfg, args[0] ?? process.cwd(), { ...(since ? { since } : {}), each: (b) => built.push(b) })
  } catch (e) {
    return (console.error((e as Error).message), 1)
  }
  console.log(formatPreview(pv, cfg.redact, `export: this writes the prompts and replies of your chats in ${pv.project} to ${out}, for anyone you give it to`))
  console.log(`  the reader sees them as chats of ${name} (change with --name)`)
  if (!pv.chats) return (console.log('no chats to export'), 1)
  if (!yes && !(await confirm(`Write these chats to ${out}? Type yes: `))) return (console.log('not exported'), 1)
  writeExport(out, name, built)
  console.log(`wrote ${built.length} chat${built.length === 1 ? '' : 's'} to ${out}. Anyone with the file can read them. The reader runs \`thenwise import ${out}\`.`)
  return 0
}
