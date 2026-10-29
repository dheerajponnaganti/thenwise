// The `thenwise` command (also installed as `memory`). The usage line below lists every command.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { expandHome } from './core/home.ts'

const [cmd, vaultArg, dirArg] = process.argv.slice(2)
const xp = (p: string | undefined) => (p === undefined ? undefined : expandHome(p, homedir()))
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? process.argv[i + 1] : undefined
}
const USAGE = 'usage: thenwise setup [--yes] | doctor | off|on [--project <path>]\n       thenwise search|current|why|tried|trace <words> | asof <ISO date or date-time> <words> | resume [words] | path <a> <b> | get <id>  (each with [--db <file>] [--expand] [--project <folder> | --here | --all])\n       thenwise vault write [--db <file>]\n       thenwise archive | ingest [--full] [--report] [--prs <prs.json>] [--db <file>] [--until <ISO>] [--vault <dir>] [--prune-excluded] [--memory-from <projects dir>]\n       thenwise distill [--since <ISO>] [--session <id>] [--last <n>] [--dry-run] | inbox | accept <id...> | accept --all-of <type> | reject <id...> | edit <id>\n       thenwise team serve|invite|remove|join|search|sync|share-chats|unshare-chats|shares, share <note>, unshare <note>  (teams preview)\n       thenwise mcp [--db <file>]   (stdio MCP server for Claude Code)\n       thenwise status [--db <file>] | logs [--errors] [--since 1h] [--component mcp] [--json] [--lines N]\n       thenwise deadend "<what failed>" [--here] | decide "<what was decided>" [--here]\n       thenwise report [--what <text>] [--title <text>] [--code E4F2] [--idea] [--send | --open | --copy] [--yes]\n       thenwise forget <session id or project folder> [--yes] | backup | uninstall\n       (the old name `memory` still works)'

if (cmd === '--help' || cmd === '-h' || cmd === 'help') (console.log(USAGE), process.exit(0))
if (cmd === '--version' || cmd === '-v') (console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version), process.exit(0))
if (cmd === 'setup' || cmd === 'init') process.exit(await (await import('./setup/setup.ts')).setup(process.argv.slice(3)))
if (cmd === 'deadend' || cmd === 'decide') {
  // A note the person writes on purpose: active at once, tied to the newest chat in scope and its project.
  const text = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!text) (console.error(`usage: thenwise ${cmd} "<what>" [--here]`), process.exit(2))
  const { loadConfig } = await import('./ingest/config.ts')
  const { makeId, saveNote } = await import('./capture/notes.ts')
  const { Graph } = await import('./query/engine.ts')
  const cfg = loadConfig()
  const db = join(cfg.memDir, 'graph.db')
  let source = ''
  let project = ''
  if (existsSync(db)) {
    const g = new Graph(db, { lazy: true })
    if (process.argv.includes('--here')) g.scopeTo(process.cwd())
    const ses = g.ofKind('session').filter((n) => g.inScope(n) && !n.extra?.team).sort((a, b) => Date.parse(b.until || b.at) - Date.parse(a.until || a.at))[0]
    if (ses) [source, project] = [ses.id, ses.project]
  }
  const type = cmd === 'deadend' ? 'dead_end' : 'decision'
  const now = new Date().toISOString()
  const n = saveNote(cfg.memDir, { id: makeId('n', `${type}\0${text}\0${now}`), type, title: text.slice(0, 80), summary: text, status: 'active', valid_from: '', valid_to: '', supersedes: '', sources: source ? [source] : [], created: now, project, path: '' })
  console.log(`${type === 'dead_end' ? 'dead end' : 'decision'} saved as ${n.id}: ${n.path}\n${source ? `from ${source}, project ${project}. ` : ''}The next sync adds it to the memory.`)
  process.exit(0)
}
if (cmd === 'report') process.exit(await (await import('./report/report.ts')).reportCommand(process.argv.slice(3)))
if (cmd === 'logs') process.exit((await import('./core/log.ts')).logsCommand(process.argv.slice(3)))
if (cmd === 'off' || cmd === 'on') process.exit((await import('./setup/off.ts')).switchCommand(cmd === 'on', process.argv.slice(3)))
if (cmd === 'doctor' && !vaultArg) process.exit(await (await import('./setup/doctor.ts')).doctorCommand())

if (cmd === 'uninstall') process.exit((await import('./privacy/uninstall.ts')).uninstall())
if (cmd === 'backup') {
  const { loadConfig } = await import('./ingest/config.ts')
  const r = (await import('./backup/backup.ts')).backup(loadConfig(), { daily: process.argv.includes('--daily') })
  for (const l of r.lines) console.log(l)
  process.exit(r.ok ? 0 : 1)
}
if (cmd === 'forget') {
  const { loadConfig } = await import('./ingest/config.ts')
  if (!vaultArg || vaultArg.startsWith('--')) (console.error('usage: thenwise forget <session id or project folder> [--yes]'), process.exit(2))
  try {
    process.exit(await (await import('./privacy/forget.ts')).forget(loadConfig(), vaultArg, { yes: process.argv.includes('--yes') }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}

if (cmd === 'archive' || cmd === 'ingest') {
  const { loadConfig } = await import('./ingest/config.ts')
  const cfg = loadConfig()
  if (cmd === 'archive') {
    const { archive } = await import('./ingest/archive.ts')
    const done = (await import('./core/log.ts')).logger('sync', cfg.memDir).time('archive')
    let r
    try {
      r = archive(cfg, { prune: process.argv.includes('--prune-excluded') })
    } catch (e) {
      if ((e as Error).message !== 'archive already running') throw e
      console.log('archive already running; this run did nothing') // exit 0: a sync and a manual run meeting is not an error
      process.exit(0)
    }
    done({ seen: r.seen, archived: r.archived, excluded: r.excluded, unparsed: r.unparsed.length, failed: r.failed.length })
    console.log(`${r.seen} sessions seen: ${r.archived} archived, ${r.skipped} unchanged (${r.remasked} masked again), ${r.excluded} excluded; ${(r.bytes / 1e6).toFixed(1)} MB of archive; ${r.unparsed.length} lines did not parse`)
    const bad = new Map<string, number[]>()
    for (const u of r.unparsed) bad.set(u.rel, [...(bad.get(u.rel) ?? []), u.line])
    for (const [rel, ls] of bad) console.log(`  ${rel}: ${ls.length} lines did not parse (first: line ${Math.min(...ls)})`)
    if (r.excludedChats || r.off) console.log(`${r.excludedChats} chat${r.excludedChats === 1 ? '' : 's'} marked [no-memory] and ${r.off} chat${r.off === 1 ? '' : 's'} of paused projects were not archived`)
    for (const p of r.pruned) console.log(`  removed: ${p}`)
    for (const f of r.failures) console.log(`  failed: ${f.rel} (${f.reason}, ${f.size} bytes)`)
    if (r.leftover.length) console.log(`${r.leftover.length} archived chats belong to excluded chats or projects; remove them with: thenwise archive --prune-excluded`)
  } else {
    const { ingest, report } = await import('./ingest/ingest.ts')
    if (flag('vault')) cfg.vaults = [resolve(xp(flag('vault'))!)]
    const r = ingest(cfg, { prs: xp(flag('prs')), db: xp(flag('db')), until: flag('until'), memoryFrom: xp(flag('memory-from')), full: process.argv.includes('--full') })
    const log = (await import('./core/log.ts')).logger('ingest', cfg.memDir)
    log.info(r.mode, { ms: r.ms, files: r.filesRead, sessions: r.sessionsIn, out: r.sessionsOut, excluded: r.excludedEval, warnings: r.warnings.length })
    for (const w of r.warnings) log.warn('warning', { msg: w })
    for (const w of r.warnings) console.error(`warning: ${w}`)
    console.log(`${r.sessionsIn} sessions in scope, ${r.sessionsOut} out of scope, ${r.excludedEval} excluded as test chats, ${r.excludedEntrypoint} excluded by entrypoint, ${r.afterCutoff} after cutoff; graph at ${r.db}`)
    console.log(`${r.mode === 'full' ? 'rebuilt everything' : r.mode === 'update' ? 'updated' : 'nothing new'}: ${r.filesRead} chat files read in ${(r.ms / 1000).toFixed(1)} s`)
    if (process.argv.includes('--report')) console.log(report(r.db))
  }
  ;(await import('./privacy/perms.ts')).tighten(cfg.memDir) // same promise as a sync: readable by you only
  process.exit(0)
}

if (cmd === 'mcp') {
  const { resolveDataDir } = await import('./core/home.ts')
  const { serveStdio } = await import('./server/stdio.ts')
  const dbPath = xp(flag('db')) ?? join(resolveDataDir(), 'graph.db')
  await serveStdio(process.stdin, process.stdout, () => dbPath)
  process.exit(0)
}

if (cmd === 'hook') {
  const { resolveDataDir } = await import('./core/home.ts')
  const { runHook } = await import('./hooks/hook.ts')
  const { hookInput } = await import('./hooks/entry.ts')
  const out = runHook(vaultArg ?? '', vaultArg === 'sync-run' || vaultArg === 'status' ? {} : await hookInput(), { dir: resolveDataDir(), cli: process.argv[1]! })
  if (out) process.stdout.write(`${out}\n`)
  process.exit(0)
}

if (cmd === 'status') {
  const { loadConfig } = await import('./ingest/config.ts')
  const { statusLines } = await import('./ingest/status.ts')
  const { newProjectLines } = await import('./setup/projects.ts')
  const { globMatch } = await import('./ingest/config.ts')
  const cfg = loadConfig()
  for (const l of statusLines(cfg, xp(flag('db')) ?? join(cfg.memDir, 'graph.db'))) console.log(l)
  for (const l of newProjectLines(cfg.claudeDir, cfg.roots, (k) => cfg.excludeProjects.some((g) => globMatch(g, k)))) console.log(l)
  process.exit(0)
}

if (cmd === 'distill' || cmd === 'inbox' || cmd === 'accept' || cmd === 'reject' || cmd === 'edit') {
  const { loadConfig } = await import('./ingest/config.ts')
  const notes = await import('./capture/notes.ts')
  const cfg = loadConfig()
  const args: string[] = []
  const rest = process.argv.slice(3)
  for (let i = 0; i < rest.length; i++) rest[i]!.startsWith('--') ? (rest[i] === '--dry-run' || i++) : args.push(rest[i]!)
  if (cmd === 'distill') {
    const { distill } = await import('./capture/distill.ts')
    const r = distill(cfg, { since: flag('since'), session: flag('session'), dryRun: process.argv.includes('--dry-run'), last: flag('last') ? Number(flag('last')) : undefined })
    for (const l of r.lines) console.log(l)
    console.log(`${r.proposals} proposal(s) in the inbox, ${r.dropped} dropped, ${r.calls} model call(s)`)
  } else if (cmd === 'inbox') {
    const inbox = notes.readNotes(cfg.memDir).filter((n) => n.status === 'inbox')
    for (const n of inbox) console.log(`${n.id}  ${n.type}  ${n.title}\n   ${n.summary}\n   source: ${n.sources.join(' ')}${n.supersedes ? `\n   would supersede: ${n.supersedes}` : ''}`)
    console.log(`${inbox.length} note(s) in the inbox`)
  } else if (cmd === 'accept') {
    const active = new Set(notes.readNotes(cfg.memDir).filter((n) => n.status === 'active').map((n) => n.id))
    for (const m of notes.accept(cfg.memDir, flag('all-of') ? { type: flag('all-of') } : { ids: args }, new Date().toISOString())) console.log(m)
    const { autoShare } = await import('./teams/client.ts')
    for (const m of await autoShare(cfg, notes.readNotes(cfg.memDir).filter((n) => n.status === 'active' && !active.has(n.id)))) console.log(m)
  }
  else if (cmd === 'reject') for (const m of notes.reject(cfg.memDir, args)) console.log(m)
  else console.log(notes.readNotes(cfg.memDir).find((n) => n.id === args[0])?.path ?? `${args[0]}: no such note`)
  process.exit(0)
}

if (cmd === 'vault') {
  if (vaultArg !== 'write') (console.error('usage: thenwise vault write [--db <file>]'), process.exit(2))
  const { loadConfig } = await import('./ingest/config.ts')
  const { writeVault, NOTE_CAP } = await import('./vault/vault.ts')
  const r = writeVault(loadConfig(), { db: xp(flag('db')) })
  for (const l of [...r.saved, ...r.reported]) console.error(`warning: ${l}`)
  if (r.capped) console.error(`warning: ${r.capped} file history notes left out (cap ${NOTE_CAP} notes)`)
  console.log(r.stopped ?? `${r.notes} notes in ${r.dir}: ${r.written} written, ${r.unchanged} unchanged, ${r.removed} removed`)
  process.exit(r.stopped && !r.stopped.startsWith('no vault') ? 1 : 0)
}

if (cmd === 'team' || cmd === 'share' || cmd === 'unshare') {
  const { teamMain } = await import('./teams/cli.ts')
  process.exit(await teamMain(process.argv.slice(2), flag))
}

const QUERY = ['search', 'current', 'why', 'tried', 'asof', 'trace', 'resume', 'path', 'get']
if (cmd && QUERY.includes(cmd)) {
  const { loadConfig } = await import('./ingest/config.ts')
  const { Graph } = await import('./query/engine.ts')
  const c = await import('./query/commands.ts')
  // Positional words are everything after the command that is not a flag or a flag value.
  const args: string[] = []
  const rest = process.argv.slice(3)
  for (let i = 0; i < rest.length; i++) rest[i]!.startsWith('--') ? (['--expand', '--no-expand', '--all', '--here', '--fast', '--full', '--pointers', '--short'].includes(rest[i]!) ? 0 : i++) : args.push(rest[i]!)
  const cfg = loadConfig()
  const dbPath = xp(flag('db')) ?? join(cfg.memDir, 'graph.db')
  if (!existsSync(dbPath)) (console.error(`no graph at ${dbPath}: run \`thenwise ingest\``), process.exit(2))
  const g = new Graph(dbPath, { lazy: !process.argv.includes('--full') }) // lazy reads only what the command touches; --full loads the whole graph
  g.expand = process.argv.includes('--expand')
  // Without --project or --here every project is searched (the older behaviour); --all says so out loud.
  if (!process.argv.includes('--all') && (flag('project') || process.argv.includes('--here'))) g.scopeTo(xp(flag('project')) ?? process.cwd())
  const q = args.join(' ')
  const need = (ok: boolean) => ok || (console.error(USAGE), process.exit(2))
  need(cmd === 'resume' || args.length > 0)
  if (cmd === 'search') console.log(process.argv.includes('--pointers') ? c.pointers(g, q) : c.search(g, q))
  else if (cmd === 'current') console.log(c.current(g, q))
  else if (cmd === 'why') console.log(c.why(g, q))
  else if (cmd === 'tried') console.log(c.tried(g, q))
  else if (cmd === 'trace') console.log(c.trace(g, q))
  else if (cmd === 'resume') console.log(process.argv.includes('--short') ? c.resumeShort(g) : c.resume(g, q))
  else if (cmd === 'get') console.log(c.get(g, q))
  else if (cmd === 'asof') (need(args.length > 1), console.log(c.asof(g, args[0]!, args.slice(1).join(' '))))
  else if (cmd === 'path') (need(args.length > 1), console.log(c.path(g, args[0]!, args.slice(1).join(' '))))
  process.exit(0)
}

console.error(USAGE)
process.exit(2)
