// The `thenwise` command (also installed as `memory`) (spec 07 §7): doctor, ids, stats on a vault, and the SQLite and Postgres commands.
// Usage: thenwise setup [--yes ...] | doctor | off|on [--project <path>] | doctor <vault> | ids <vault> [--seed <text>] | stats <vault>
//        thenwise archive | ingest [--full] [--report] [--prs <prs.json>] [--db <file>] [--until <ISO>] [--vault <dir>] [--memory-from <projects dir>]
//        thenwise views --vault <dir> [--db <file>]
//        thenwise import <vault> --sqlite <file.db> | export <file.db> <dir>
//        thenwise import <vault> --postgres <url> --scope <kind:key>
//        thenwise serve --postgres <url> --scope <kind:key> [--port N] [--host H] [--mcp]
//        thenwise token create <principal> | token revoke <token>   (both with --postgres and --scope)
// The database url may also come from MEMORY_POSTGRES_URL, which keeps a password out of the process list.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome } from "./core/home.js";
import { cryptoRandom, seededRandom } from "./core/ids.js";
import { nodeIO } from "./host/node-io.js";
import { FilesStore } from "./store-files/files-store.js";
import { exportVault } from "./store-sqlite/export.js";
import { importVault, readVaultFiles } from "./store-sqlite/import.js";
import { SqliteStore } from "./store-sqlite/sqlite-store.js";
const [cmd, vaultArg, dirArg] = process.argv.slice(2);
const xp = (p) => (p === undefined ? undefined : expandHome(p, homedir()));
const flag = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const USAGE = 'usage: thenwise setup [--yes] | doctor | off|on [--project <path>]\n       thenwise search|current|why|tried|trace <words> | asof <ISO date or date-time> <words> | resume [words] | path <a> <b> | get <id>  (each with [--db <file>] [--expand] [--project <folder> | --here | --all])\n       thenwise views --vault <dir> [--db <file>]\n       thenwise vault write [--db <file>]\n       thenwise archive | ingest [--full] [--report] [--prs <prs.json>] [--db <file>] [--until <ISO>] [--vault <dir>] [--prune-excluded] [--memory-from <projects dir>]\n       thenwise doctor <vault> | ids <vault> [--seed <text>] | stats <vault>\n       thenwise import <vault> --sqlite <file.db> | export <file.db> <dir>\n       thenwise import <vault> --postgres <url> --scope <kind:key>\n       thenwise serve --postgres <url> --scope <kind:key> [--port N] [--host H] [--mcp]\n       thenwise token create <principal> | token revoke <token>  (with --postgres and --scope)\n       thenwise distill [--since <ISO>] [--session <id>] [--last <n>] [--dry-run] | inbox | accept <id...> | accept --all-of <type> | reject <id...> | edit <id>\n       thenwise team serve|invite|remove|join|search|sync, share <note>, unshare <note>  (teams preview)\n       thenwise mcp [--db <file>]   (stdio MCP server for Claude Code)\n       thenwise status [--db <file>]\n       thenwise forget <session id or project folder> [--yes] | backup | uninstall\n       (the old name `memory` still works)';
function parseScope(text) {
    const m = /^(personal|project|team):(.+)$/.exec(text ?? '');
    if (!m) {
        console.error('--scope must look like project:<key>, personal:<key> or team:<key>');
        process.exit(2);
    }
    return { kind: m[1], key: m[2] };
}
if (cmd === 'setup' || cmd === 'init')
    process.exit(await (await import("./setup/setup.js")).setup(process.argv.slice(3)));
if (cmd === 'off' || cmd === 'on')
    process.exit((await import("./setup/off.js")).switchCommand(cmd === 'on', process.argv.slice(3)));
if (cmd === 'doctor' && !vaultArg)
    process.exit(await (await import("./setup/doctor.js")).doctorCommand());
if (cmd === 'uninstall')
    process.exit((await import("./privacy/uninstall.js")).uninstall());
if (cmd === 'backup') {
    const { loadConfig } = await import("./ingest/config.js");
    const r = (await import("./backup/backup.js")).backup(loadConfig(), { daily: process.argv.includes('--daily') });
    for (const l of r.lines)
        console.log(l);
    process.exit(r.ok ? 0 : 1);
}
if (cmd === 'forget') {
    const { loadConfig } = await import("./ingest/config.js");
    if (!vaultArg || vaultArg.startsWith('--'))
        (console.error('usage: thenwise forget <session id or project folder> [--yes]'), process.exit(2));
    try {
        process.exit(await (await import("./privacy/forget.js")).forget(loadConfig(), vaultArg, { yes: process.argv.includes('--yes') }));
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
if (cmd === 'archive' || cmd === 'ingest') {
    const { loadConfig } = await import("./ingest/config.js");
    const cfg = loadConfig();
    if (cmd === 'archive') {
        const { archive } = await import("./ingest/archive.js");
        const r = archive(cfg, { prune: process.argv.includes('--prune-excluded') });
        console.log(`${r.seen} sessions seen: ${r.archived} archived, ${r.skipped} unchanged (${r.remasked} masked again), ${r.excluded} excluded; ${(r.bytes / 1e6).toFixed(1)} MB of archive; ${r.unparsed.length} lines did not parse`);
        for (const u of r.unparsed)
            console.log(`  unparsed: ${u.rel} line ${u.line}`);
        if (r.excludedChats || r.off)
            console.log(`${r.excludedChats} test chats and ${r.off} chats of paused projects were not archived`);
        for (const p of r.pruned)
            console.log(`  removed: ${p}`);
        for (const f of r.failed)
            console.log(`  failed: ${f}`);
        if (r.leftover.length)
            console.log(`${r.leftover.length} archived chats belong to excluded chats or projects; remove them with: thenwise archive --prune-excluded`);
    }
    else {
        const { ingest, report } = await import("./ingest/ingest.js");
        if (flag('vault'))
            cfg.vaults = [resolve(xp(flag('vault')))];
        const r = ingest(cfg, { prs: xp(flag('prs')), db: xp(flag('db')), until: flag('until'), memoryFrom: xp(flag('memory-from')), full: process.argv.includes('--full') });
        for (const w of r.warnings)
            console.error(`warning: ${w}`);
        console.log(`${r.sessionsIn} sessions in scope, ${r.sessionsOut} out of scope, ${r.excludedEval} excluded as test chats, ${r.excludedEntrypoint} excluded by entrypoint, ${r.afterCutoff} after cutoff; graph at ${r.db}`);
        console.log(`${r.mode === 'full' ? 'rebuilt everything' : r.mode === 'update' ? 'updated' : 'nothing new'}: ${r.filesRead} chat files read in ${(r.ms / 1000).toFixed(1)} s`);
        if (process.argv.includes('--report'))
            console.log(report(r.db));
    }
    ;
    (await import("./privacy/perms.js")).tighten(cfg.memDir); // same promise as a sync: readable by you only
    process.exit(0);
}
if (cmd === 'mcp') {
    const { resolveDataDir } = await import("./core/home.js");
    const { serveStdio } = await import("./server/stdio.js");
    const dbPath = xp(flag('db')) ?? join(resolveDataDir(), 'graph.db');
    await serveStdio(process.stdin, process.stdout, () => dbPath);
    process.exit(0);
}
if (cmd === 'hook') {
    const { resolveDataDir } = await import("./core/home.js");
    const { readStdin, runHook } = await import("./hooks/hook.js");
    const out = runHook(vaultArg ?? '', vaultArg === 'sync-run' || vaultArg === 'status' ? {} : await readStdin(), { dir: resolveDataDir(), cli: process.argv[1] });
    if (out)
        process.stdout.write(`${out}\n`);
    process.exit(0);
}
if (cmd === 'status') {
    const { loadConfig } = await import("./ingest/config.js");
    const { statusLines } = await import("./ingest/status.js");
    const { newProjectLines } = await import("./setup/projects.js");
    const { globMatch } = await import("./ingest/config.js");
    const cfg = loadConfig();
    for (const l of statusLines(cfg, xp(flag('db')) ?? join(cfg.memDir, 'graph.db')))
        console.log(l);
    for (const l of newProjectLines(cfg.claudeDir, cfg.roots, (k) => cfg.excludeProjects.some((g) => globMatch(g, k))))
        console.log(l);
    process.exit(0);
}
if (cmd === 'distill' || cmd === 'inbox' || cmd === 'accept' || cmd === 'reject' || cmd === 'edit') {
    const { loadConfig } = await import("./ingest/config.js");
    const notes = await import("./capture/notes.js");
    const cfg = loadConfig();
    const args = [];
    const rest = process.argv.slice(3);
    for (let i = 0; i < rest.length; i++)
        rest[i].startsWith('--') ? (rest[i] === '--dry-run' || i++) : args.push(rest[i]);
    if (cmd === 'distill') {
        const { distill } = await import("./capture/distill.js");
        const r = distill(cfg, { since: flag('since'), session: flag('session'), dryRun: process.argv.includes('--dry-run'), last: flag('last') ? Number(flag('last')) : undefined });
        for (const l of r.lines)
            console.log(l);
        console.log(`${r.proposals} proposal(s) in the inbox, ${r.dropped} dropped, ${r.calls} model call(s)`);
    }
    else if (cmd === 'inbox') {
        const inbox = notes.readNotes(cfg.memDir).filter((n) => n.status === 'inbox');
        for (const n of inbox)
            console.log(`${n.id}  ${n.type}  ${n.title}\n   ${n.summary}\n   source: ${n.sources.join(' ')}${n.supersedes ? `\n   would supersede: ${n.supersedes}` : ''}`);
        console.log(`${inbox.length} note(s) in the inbox`);
    }
    else if (cmd === 'accept' && flag('all-of')) {
        for (const m of notes.accept(cfg.memDir, { type: flag('all-of') }, new Date().toISOString()))
            console.log(m);
    }
    else if (cmd === 'accept')
        for (const m of notes.accept(cfg.memDir, { ids: args }, new Date().toISOString()))
            console.log(m);
    else if (cmd === 'reject')
        for (const m of notes.reject(cfg.memDir, args))
            console.log(m);
    else
        console.log(notes.readNotes(cfg.memDir).find((n) => n.id === args[0])?.path ?? `${args[0]}: no such note`);
    process.exit(0);
}
if (cmd === 'views') {
    const { loadConfig } = await import("./ingest/config.js");
    const { writeViews } = await import("./views/views.js");
    const cfg = loadConfig();
    const vault = xp(flag('vault'));
    const dbPath = xp(flag('db')) ?? join(cfg.memDir, 'graph.db');
    if (!vault || !existsSync(dbPath))
        (console.error(!vault ? 'usage: thenwise views --vault <dir> [--db <file>]' : `no graph at ${dbPath}: run \`thenwise ingest\``), process.exit(2));
    const r = writeViews(dbPath, resolve(vault), { projects: cfg.viewProjects });
    console.log(`${r.files.length} view notes in ${r.dir}: ${r.written} written, ${r.removed} removed`);
    process.exit(0);
}
if (cmd === 'vault') {
    if (vaultArg !== 'write')
        (console.error('usage: thenwise vault write [--db <file>]'), process.exit(2));
    const { loadConfig } = await import("./ingest/config.js");
    const { writeVault, NOTE_CAP } = await import("./vault/vault.js");
    const r = writeVault(loadConfig(), { db: xp(flag('db')) });
    for (const l of [...r.saved, ...r.reported])
        console.error(`warning: ${l}`);
    if (r.capped)
        console.error(`warning: ${r.capped} file history notes left out (cap ${NOTE_CAP} notes)`);
    console.log(r.stopped ?? `${r.notes} notes in ${r.dir}: ${r.written} written, ${r.unchanged} unchanged, ${r.removed} removed`);
    process.exit(r.stopped && !r.stopped.startsWith('no vault') ? 1 : 0);
}
if (cmd === 'team' || cmd === 'share' || cmd === 'unshare') {
    const { teamMain } = await import("./teams/cli.js");
    process.exit(await teamMain(process.argv.slice(2), flag));
}
const QUERY = ['search', 'current', 'why', 'tried', 'asof', 'trace', 'resume', 'path', 'get'];
if (cmd && QUERY.includes(cmd)) {
    const { loadConfig } = await import("./ingest/config.js");
    const { Graph } = await import("./query/engine.js");
    const c = await import("./query/commands.js");
    // Positional words are everything after the command that is not a flag or a flag value.
    const args = [];
    const rest = process.argv.slice(3);
    for (let i = 0; i < rest.length; i++)
        rest[i].startsWith('--') ? (['--expand', '--no-expand', '--all', '--here', '--fast', '--full'].includes(rest[i]) ? 0 : i++) : args.push(rest[i]);
    const cfg = loadConfig();
    const dbPath = xp(flag('db')) ?? join(cfg.memDir, 'graph.db');
    if (!existsSync(dbPath))
        (console.error(`no graph at ${dbPath}: run \`thenwise ingest\``), process.exit(2));
    const g = new Graph(dbPath, { lazy: !process.argv.includes('--full') }); // lazy reads only what the command touches; --full loads the whole graph
    g.expand = process.argv.includes('--expand');
    // Without --project or --here every project is searched (the older behaviour); --all says so out loud.
    if (!process.argv.includes('--all') && (flag('project') || process.argv.includes('--here')))
        g.scopeTo(xp(flag('project')) ?? process.cwd());
    const q = args.join(' ');
    const need = (ok) => ok || (console.error(USAGE), process.exit(2));
    need(cmd === 'resume' || args.length > 0);
    if (cmd === 'search')
        console.log(c.search(g, q));
    else if (cmd === 'current')
        console.log(c.current(g, q));
    else if (cmd === 'why')
        console.log(c.why(g, q));
    else if (cmd === 'tried')
        console.log(c.tried(g, q));
    else if (cmd === 'trace')
        console.log(c.trace(g, q));
    else if (cmd === 'resume')
        console.log(c.resume(g, q));
    else if (cmd === 'get')
        console.log(c.get(g, q));
    else if (cmd === 'asof')
        (need(args.length > 1), console.log(c.asof(g, args[0], args.slice(1).join(' '))));
    else if (cmd === 'path')
        (need(args.length > 1), console.log(c.path(g, args[0], args.slice(1).join(' '))));
    process.exit(0);
}
if ((cmd === 'import' && !flag('sqlite')) || cmd === 'serve' || cmd === 'token') {
    const url = flag('postgres') ?? process.env.MEMORY_POSTGRES_URL;
    if (!url || (cmd === 'import' && !vaultArg)) {
        console.error(USAGE);
        process.exit(2);
    }
    const scope = parseScope(flag('scope'));
    // pg is an optional dependency: only these commands need it.
    let pg;
    try {
        pg = (await import('pg')).default;
    }
    catch {
        console.error('This command needs the "pg" package, which is not installed. Run: npm install pg');
        process.exit(1);
    }
    const { createApp } = await import("./server/server.js");
    const { importVault: importToPostgres } = await import("./store-postgres/import.js");
    const { migrate } = await import("./store-postgres/migrate.js");
    const { addMembership, createToken, pgVerifier, revokeToken } = await import("./store-postgres/pg-auth.js");
    const { PgStore } = await import("./store-postgres/pg-store.js");
    const pool = new pg.Pool({ connectionString: url });
    try {
        const applied = await migrate(pool);
        if (applied.length > 0)
            console.error(`migrations applied: ${applied.join(', ')}`);
        if (cmd === 'import') {
            const r = await importToPostgres(pool, scope, vaultArg);
            console.log(`${r.files} files read, ${r.notes} notes and ${r.edges} edges loaded into ${scope.kind}:${scope.key} (${r.unresolved} links unresolved)`);
        }
        else if (cmd === 'token') {
            const [, sub, who] = process.argv.slice(2);
            if (sub === 'create' && who) {
                await addMembership(pool, who, scope);
                // Shown once: only its hash is stored.
                console.log(await createToken(pool, who));
            }
            else if (sub === 'revoke' && who) {
                console.log((await revokeToken(pool, who)) ? 'revoked' : 'no live token matched');
            }
            else {
                console.error(USAGE);
                process.exit(2);
            }
        }
        else {
            // The server's connections set the caller as app.principal on each transaction, so row-level security
            // applies whenever the url names a role that is not a superuser.
            const app = createApp({ store: p => new PgStore(pool, scope, { principal: p.id }), verify: pgVerifier(pool, scope), mcp: process.argv.includes('--mcp'), label: `postgres:${scope.kind}:${scope.key}`, ...(flag('host') ? { host: flag('host') } : {}), port: Number(flag('port') ?? 8787) });
            const { host, port } = await app.listen();
            console.log(`thenwise server for ${scope.kind}:${scope.key} listening on http://${host}:${port}`);
            const stop = () => void app.close().then(() => pool.end()).then(() => process.exit(0));
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            await new Promise(() => undefined);
        }
    }
    finally {
        if (cmd !== 'serve')
            await pool.end();
    }
    process.exit(0);
}
if (cmd === 'import' && vaultArg && flag('sqlite')) {
    const db = new SqliteStore(resolve(flag('sqlite')));
    let r;
    try {
        r = importVault(db, readVaultFiles(resolve(vaultArg)));
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
    db.close();
    console.log(`${r.nodes} notes, ${r.edges} edges, ${r.unresolved} unresolved links imported${r.duplicates.length ? `; ${r.duplicates.length} duplicate ids skipped: ${r.duplicates.join(', ')}` : ''}`);
    process.exit(0);
}
if (cmd === 'export' && vaultArg && dirArg) {
    if (!existsSync(vaultArg)) {
        console.error(`no database at ${vaultArg}`);
        process.exit(2);
    }
    const db = new SqliteStore(resolve(vaultArg));
    console.log(`${await exportVault(db, resolve(dirArg), nodeIO, new Date().toISOString())} notes written to ${resolve(dirArg)}`);
    db.close();
    process.exit(0);
}
if (!cmd || !vaultArg || !['doctor', 'ids', 'stats'].includes(cmd)) {
    console.error(USAGE);
    process.exit(2);
}
const store = new FilesStore(nodeIO, resolve(vaultArg), null);
const opened = await store.open();
if (cmd === 'stats')
    console.log(JSON.stringify({ ...opened, ...store.index.stats() }, null, 2));
if (cmd === 'ids') {
    // A seed makes ids repeatable (fixtures only). Real vaults use the platform's crypto source.
    const seed = flag('seed');
    const added = await store.ensureIds(seed ? seededRandom(seed) : cryptoRandom);
    for (const a of added)
        console.log(`${a.id}  ${a.path}`);
    console.log(`${added.length} ids added`);
}
if (cmd === 'doctor') {
    const findings = store.doctor();
    for (const f of findings)
        console.log(`${f.severity.padEnd(7)} ${f.rule.padEnd(18)} ${f.path}  ${f.message}`);
    const count = (s) => findings.filter(f => f.severity === s).length;
    console.log(`\n${count('error')} errors, ${count('warning')} warnings, ${count('info')} info`);
    process.exit(count('error') > 0 ? 1 : 0);
}
