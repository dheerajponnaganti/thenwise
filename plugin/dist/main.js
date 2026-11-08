// The `thenwise` command (also installed as `memory`). The usage line below lists every command.
import { existsSync, readFileSync } from 'node:fs';
import { flag as argFlag } from "./core/args.js";
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { expandHome } from "./core/home.js";
// Tools whose own chat folders every sync reads, connected or not.
const READS_CHATS = new Set(['antigravity', 'codex']);
const [cmd, vaultArg, dirArg] = process.argv.slice(2);
const xp = (p) => (p === undefined ? undefined : expandHome(p, homedir()));
// `thenwise tests` takes a test command whose own flags (`--project`, `--since`) are not Thenwise's: only the options
// before it (`--here`, `--all`, `--project <folder>`, `--db <file>`) are, so only they are read as Thenwise's flags.
const testsLead = (() => {
    const r = process.argv.slice(3);
    let i = 0;
    while (i < r.length && ['--here', '--all', '--project', '--db'].includes(r[i]))
        i += ['--project', '--db'].includes(r[i]) ? 2 : 1;
    return i;
})();
const own = cmd === 'tests' ? process.argv.slice(0, 3 + testsLead) : process.argv;
/** The value after `--<name>`, or undefined when the flag is not given. A flag given with no value is an input error:
 * running with the default instead would work on data the person did not mean. */
const flag = (name) => {
    if (!own.includes(`--${name}`))
        return undefined;
    const v = argFlag(name, own);
    if (!v || v.startsWith('--'))
        (console.error(`--${name} needs a value`), process.exit(2));
    return v;
};
// Each value flag is read once before any command runs, so a missing value stops the command before it does any work.
for (const f of ['db', 'prs', 'until', 'vault', 'memory-from', 'session', 'last', 'since', 'all-of', 'project', 'mates-since'])
    flag(f);
const USAGE = 'usage: thenwise setup [--yes] | doctor | off|on [--project <path>] | update-check [off|on] | connect antigravity|codex|cursor|gemini|opencode [--dry-run] [--remove]\n       thenwise search|current|why|tried|trace <words> | asof <ISO date or date-time> <words> [--checkout] | asof --clean | resume [words] | digest [--since 24h|7d|<ISO>] | tests <test command or file> | cost [words] [--since 7d|<date>] | path <a> <b> | get <id>  (each with [--db <file>] [--expand] [--project <folder> | --here | --all])\n       thenwise vault write [--db <file>]\n       thenwise archive | ingest [--full] [--report] [--prs <prs.json>] [--db <file>] [--until <ISO>] [--vault <dir>] [--prune-excluded] [--memory-from <projects dir>]\n       thenwise distill [--since <ISO>] [--session <id>] [--last <n>] [--dry-run] | mine [--db <file>] | inbox | accept <id...> | accept --all-of <type> | reject <id...> | edit <id>\n       thenwise team serve|invite|remove|join|search|sync|share-chats|unshare-chats|shares, share <note>, unshare <note>  (teams preview)\n       thenwise mcp [--db <file>]   (stdio MCP server for Claude Code)\n       thenwise status [--db <file>] | shown [--session <id>] | notices all|important|off | logs [--errors] [--since 1h] [--component mcp] [--json] [--lines N]\n       thenwise deadend "<what failed>" [--here] [--file <path>]... | decide "<what was decided>" [--here] [--file <path>]...\n       thenwise report [--what <text>] [--title <text>] [--code E4F2] [--idea] [--send | --open | --copy] [--yes]\n       thenwise export [<repo path>] --out <file> [--since <date>] [--name <name>] [--yes] | import <file> [--yes] | import --remove <name>\n       thenwise forget <session id or project folder> [--yes] | backup | uninstall\n       (the old name `memory` still works)';
if (cmd === '--help' || cmd === '-h' || cmd === 'help')
    (console.log(USAGE), process.exit(0));
if (cmd === '--version' || cmd === '-v')
    (console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version), process.exit(0));
if (cmd === 'setup' || cmd === 'init')
    process.exit(await (await import("./setup/setup.js")).setup(process.argv.slice(3)));
if (cmd === 'deadend' || cmd === 'decide') {
    // A note the person writes on purpose: active at once, tied to the newest chat in scope and its project.
    const { normPath } = await import("./core/vault-index.js"); // stored paths use forward slashes on every system
    const words = [];
    const given = [];
    const rest = process.argv.slice(3);
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== '--file')
            rest[i].startsWith('--') || words.push(rest[i]);
        // A --file with no path after it is an input error: the person meant to name a file, so nothing is saved without it.
        else if (!rest[i + 1] || rest[i + 1].startsWith('--'))
            (console.error('--file needs a path, such as --file src/cache.ts'), process.exit(2));
        else
            given.push(normPath(resolve(rest[++i])));
    }
    const text = words.join(' ').trim();
    if (!text)
        (console.error(`usage: thenwise ${cmd} "<what>" [--here] [--file <path>]...`), process.exit(2));
    const { loadConfig } = await import("./ingest/config.js");
    const { makeId, readNotes, saveNote } = await import("./capture/notes.js");
    const { related } = await import("./capture/similar.js");
    const { Graph } = await import("./query/engine.js");
    const cfg = loadConfig();
    const db = join(cfg.memDir, 'graph.db');
    let source = '';
    let project = '';
    if (existsSync(db)) {
        const g = new Graph(db, { lazy: true });
        if (process.argv.includes('--here'))
            g.scopeTo(process.cwd());
        const ses = g.ofKind('session').filter((n) => g.inScope(n) && !n.extra?.team).sort((a, b) => Date.parse(b.until || b.at) - Date.parse(a.until || a.at))[0];
        if (ses)
            [source, project] = [ses.id, ses.project];
    }
    const type = cmd === 'deadend' ? 'dead_end' : 'decision';
    const now = new Date().toISOString();
    // The note is about the files named with --file and the files this agent's own chat edited lately (the work the note
    // is about, not all a long chat touched), so it reaches whoever opens them next, and a later commit to them asks
    // whether a decision still holds. Never a reason to fail.
    const files = new Set(given);
    try {
        const { insideAgent, liveChats, ownChat, readLive } = await import("./hooks/handoff.js");
        const mine = ownChat(cfg, process.cwd(), insideAgent())[0];
        const chat = mine ? liveChats(cfg, process.cwd()).find((c) => c.id === mine) : undefined;
        const s = chat ? readLive(cfg, chat) : null;
        const since = Date.now() - 30 * 60e3;
        const recent = new Set();
        for (const t of [...(s?.turns ?? [])].reverse())
            if (Date.parse(t.at) >= since)
                for (const f of t.edits)
                    if (recent.size < 10)
                        recent.add(f);
        for (const f of recent)
            files.add(normPath(f));
    }
    catch { /* no chat to read: the --file paths stand alone */ }
    // A file that does not exist is kept (a decision may be about a file still to come), and said, so a typo shows.
    const missing = given.filter((f) => !existsSync(f));
    const active = readNotes(cfg.memDir).filter((x) => x.status === 'active');
    const near = related({ type, title: text.slice(0, 80), summary: text }, active, active);
    const like = near.dup ?? near.candidate;
    const n = saveNote(cfg.memDir, { id: makeId('n', `${type}\0${text}\0${now}`), type, title: text.slice(0, 80), summary: text, status: 'active', valid_from: '', valid_to: '', supersedes: '', sources: source ? [source] : [], created: now, project, path: '', files: [...files].sort() });
    console.log(`${type === 'dead_end' ? 'dead end' : 'decision'} saved as ${n.id}: ${n.path}\n${source ? `from ${source}, project ${project}. ` : ''}${files.size ? `About ${files.size} file${files.size === 1 ? '' : 's'}: ${[...files].slice(0, 5).map((f) => basename(f)).join(', ')}${files.size > 5 ? ', ...' : ''}. ` : ''}The next sync adds it to the memory.`);
    if (missing.length)
        console.log(`Not found on disk, kept as given: ${missing.map((f) => normPath(relative(process.cwd(), f)) || f).join(', ')}. Check the path if that is a typo.`);
    if (like)
        console.log(`Similar note: ${like.id}: ${like.title}. Check that the two agree.`);
    process.exit(0);
}
if (cmd === 'report')
    process.exit(await (await import("./report/report.js")).reportCommand(process.argv.slice(3)));
if (cmd === 'logs')
    process.exit((await import("./core/log.js")).logsCommand(process.argv.slice(3)));
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
        const done = (await import("./core/log.js")).logger('sync', cfg.memDir).time('archive');
        let r;
        try {
            const { reporter } = await import("./core/progress.js");
            r = archive(cfg, { prune: process.argv.includes('--prune-excluded'), onProgress: reporter(cfg.memDir, 'copying chats') ?? undefined });
        }
        catch (e) {
            if (e.message !== 'archive already running')
                throw e;
            console.log('archive already running; this run did nothing'); // exit 0: a sync and a manual run meeting is not an error
            process.exit(0);
        }
        done({ seen: r.seen, archived: r.archived, excluded: r.excluded, unparsed: r.unparsed.length, failed: r.failed.length });
        console.log(`${r.seen} sessions seen: ${r.archived} archived, ${r.skipped} unchanged (${r.remasked} masked again), ${r.excluded} excluded; ${(r.bytes / 1e6).toFixed(1)} MB of archive; ${r.unparsed.length} lines did not parse`);
        const bad = new Map();
        for (const u of r.unparsed)
            bad.set(u.rel, [...(bad.get(u.rel) ?? []), u.line]);
        for (const [rel, ls] of bad)
            console.log(`  ${rel}: ${ls.length} lines did not parse (first: line ${Math.min(...ls)})`);
        if (r.excludedChats || r.off)
            console.log(`${r.excludedChats} chat${r.excludedChats === 1 ? '' : 's'} marked [no-memory] and ${r.off} chat${r.off === 1 ? '' : 's'} of paused projects were not archived`);
        for (const p of r.pruned)
            console.log(`  removed: ${p}`);
        for (const f of r.failures)
            console.log(`  failed: ${f.rel} (${f.reason}, ${f.size} bytes)`);
        if (r.leftover.length)
            console.log(`${r.leftover.length} archived chats belong to excluded chats or projects; remove them with: thenwise archive --prune-excluded`);
    }
    else {
        const { ingest, report } = await import("./ingest/ingest.js");
        if (flag('vault'))
            cfg.vaults = [resolve(xp(flag('vault')))];
        const { reporter } = await import("./core/progress.js");
        const r = ingest(cfg, { prs: xp(flag('prs')), db: xp(flag('db')), until: flag('until'), memoryFrom: xp(flag('memory-from')), full: process.argv.includes('--full'), onProgress: reporter(cfg.memDir, 'building the store') ?? undefined });
        const log = (await import("./core/log.js")).logger('ingest', cfg.memDir);
        log.info(r.mode, { ms: r.ms, files: r.filesRead, sessions: r.sessionsIn, out: r.sessionsOut, excluded: r.excludedEval, warnings: r.warnings.length });
        for (const w of r.warnings)
            log.warn('warning', { msg: w });
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
    ;
    (await import("./setup/projects.js")).memoProjects();
    const { resolveDataDir } = await import("./core/home.js");
    const { runHook } = await import("./hooks/hook.js");
    const { hookInput } = await import("./hooks/entry.js");
    const out = runHook(vaultArg ?? '', vaultArg === 'sync-run' || vaultArg === 'status' ? {} : await hookInput(), { dir: resolveDataDir(), cli: process.argv[1] });
    // Antigravity reads a hook's stdout as JSON, so saying nothing is printed as an empty object.
    if (out || process.env.ANTIGRAVITY_CONVERSATION_ID)
        process.stdout.write(`${out || '{}'}\n`);
    process.exit(0);
}
if (cmd === 'connect') {
    const { apply, plan, TOOLS } = await import("./setup/connect.js");
    const tool = process.argv[3];
    if (!TOOLS.includes(tool)) {
        console.error(`usage: thenwise connect ${TOOLS.join('|')} [--dry-run] [--remove]`);
        process.exit(2);
    }
    const p = plan(tool, { remove: process.argv.includes('--remove') });
    if (process.argv.includes('--dry-run')) {
        console.log(`${tool}: would be ${p.note} in ${p.file}\n${p.snippet}`);
        process.exit(0);
    }
    apply(p);
    console.log(`${tool}: ${p.note} in ${p.file}`);
    if (p.next === null && /left alone/.test(p.note))
        console.log(p.snippet);
    else if (p.note === 'connected')
        console.log(`Restart ${tool} to load the memory tools. It can read this memory and what your team shared; ${READS_CHATS.has(tool) ? 'its own chats join this memory at each sync' : 'its own chats are not remembered yet'}.`);
    process.exit(0);
}
if (cmd === 'notices') {
    const { loadConfig, readConfigFile, saveConfig } = await import("./ingest/config.js");
    const cfg = loadConfig();
    const set = process.argv[3];
    if (set !== 'all' && set !== 'important' && set !== 'off')
        (console.error('usage: thenwise notices all|important|off'), process.exit(2));
    saveConfig(cfg.memDir, { ...readConfigFile(cfg.memDir).raw, notices: set });
    console.log({ all: 'Thenwise shows a line when it hands over work, when something fails, when chats leave this machine and when notes wait.', important: 'Thenwise shows a line only on first run, when something fails, and when chats leave this machine.', off: 'Thenwise shows no lines. /thenwise:status still has everything.' }[set]);
    process.exit(0);
}
if (cmd === 'shown') {
    const { resolveDataDir } = await import("./core/home.js");
    const { readSent } = await import("./core/notices.js");
    const r = readSent(resolveDataDir(), flag('session'));
    if (!r || !r.sent.length)
        (console.log('Nothing from Thenwise was added to a session yet.'), process.exit(0));
    const total = r.sent.reduce((n, s) => n + s.tokens, 0);
    console.log(`What Thenwise added to the agent in session ${r.session}: ${r.sent.length} block${r.sent.length === 1 ? '' : 's'}, about ${total} tokens, oldest first.\n`);
    for (const s of r.sent)
        console.log(`== ${s.at.replace('T', ' ').slice(0, 19)} · ${s.event} · ${s.kind} · about ${s.tokens} tokens\n${s.text}\n`);
    process.exit(0);
}
if (cmd === 'update-check') {
    const { loadConfig, readConfigFile, saveConfig } = await import("./ingest/config.js");
    const { checkForUpdate, updateStatus } = await import("./setup/update.js");
    const cfg = loadConfig();
    const set = process.argv[3];
    if (set === 'off' || set === 'on') {
        saveConfig(cfg.memDir, { ...readConfigFile(cfg.memDir).raw, update_check: set === 'on' });
        console.log(set === 'on' ? 'Thenwise checks npm for a new version once a day.' : 'The daily version check is off. Thenwise makes no such request.');
        process.exit(0);
    }
    await checkForUpdate(cfg, { daily: process.argv.includes('--daily') });
    if (!process.argv.includes('--daily'))
        console.log(updateStatus(cfg).line);
    process.exit(0);
}
if (cmd === 'status') {
    const { loadConfig } = await import("./ingest/config.js");
    const { statusLines } = await import("./ingest/status.js");
    const { newProjectLines } = await import("./setup/projects.js");
    const { globMatch } = await import("./ingest/config.js");
    const cfg = loadConfig();
    const { progressLine, readProgress } = await import("./core/progress.js");
    const sync = progressLine(readProgress(cfg.memDir));
    if (sync)
        console.log(`sync: ${sync}`);
    for (const l of statusLines(cfg, xp(flag('db')) ?? join(cfg.memDir, 'graph.db')))
        console.log(l);
    for (const l of newProjectLines(cfg.claudeDir, cfg.roots, (k) => cfg.excludeProjects.some((g) => globMatch(g, k))))
        console.log(l);
    process.exit(0);
}
if (cmd === 'mine') {
    const { loadConfig } = await import("./ingest/config.js");
    const cfg = loadConfig();
    const db = xp(flag('db')) ?? join(cfg.memDir, 'graph.db');
    if (!existsSync(db))
        (console.error(`no graph at ${db}: run \`thenwise ingest\``), process.exit(2));
    const n = (await import("./capture/mine.js")).mineRules(cfg.memDir, db);
    console.log(`${n} rule proposal${n === 1 ? '' : 's'} added to the inbox${n ? '; `thenwise inbox` lists them' : ''}`);
    const e = (await import("./capture/expire.js")).proposeExpiry(cfg.memDir, db);
    console.log(`${e} decision${e === 1 ? '' : 's'} to recheck added to the inbox${e ? '; `thenwise inbox` lists them' : ''}`);
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
            console.log(`${n.id}  ${n.type}  ${n.title}\n   ${n.summary.split('\n').join('\n   ')}\n   source: ${n.sources.join(' ')}${n.supersedes ? `\n   would supersede: ${n.supersedes}` : ''}`);
        console.log(`${inbox.length} note(s) in the inbox`);
    }
    else if (cmd === 'accept') {
        const active = new Set(notes.readNotes(cfg.memDir).filter((n) => n.status === 'active').map((n) => n.id));
        for (const m of notes.accept(cfg.memDir, flag('all-of') ? { type: flag('all-of') } : { ids: args }, new Date().toISOString()))
            console.log(m);
        const { autoShare } = await import("./teams/client.js");
        for (const m of await autoShare(cfg, notes.readNotes(cfg.memDir).filter((n) => n.status === 'active' && !active.has(n.id))))
            console.log(m);
    }
    else if (cmd === 'reject')
        for (const m of notes.reject(cfg.memDir, args))
            console.log(m);
    else
        console.log(notes.readNotes(cfg.memDir).find((n) => n.id === args[0])?.path ?? `${args[0]}: no such note`);
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
if (cmd === 'export' || cmd === 'import') {
    const { loadConfig } = await import("./ingest/config.js");
    const words = [];
    const rest = process.argv.slice(3);
    for (let i = 0; i < rest.length; i++)
        rest[i].startsWith('--') ? (rest[i] === '--yes' ? 0 : i++) : words.push(rest[i]);
    process.exit(await (await import("./teams/export.js")).exportMain(cmd, loadConfig(), words, flag));
}
if (cmd === 'team' || cmd === 'share' || cmd === 'unshare') {
    const { teamMain } = await import("./teams/cli.js");
    process.exit(await teamMain(process.argv.slice(2), flag));
}
const QUERY = ['search', 'current', 'why', 'tried', 'asof', 'trace', 'resume', 'digest', 'path', 'get', 'tests', 'cost'];
if (cmd && QUERY.includes(cmd)) {
    process.env.THENWISE_CLI_VERBS = '1'; // a person reads this: name the CLI commands, not the MCP tools
    const { loadConfig } = await import("./ingest/config.js");
    const { Graph, endOf, sinceOf } = await import("./query/engine.js");
    const c = await import("./query/commands.js");
    // Positional words are everything after the command that is not a flag or a flag value.
    const args = [];
    const rest = process.argv.slice(3);
    // `tests` takes a test command, whose own flags (`--test`, `--project`, `--all`) are part of it: Thenwise's options count
    // only before it, as in `thenwise tests --here vitest --project unit`.
    const lead = [];
    if (cmd === 'tests') {
        let i = 0;
        for (; i < rest.length && ['--here', '--all', '--project', '--db'].includes(rest[i]); i++)
            lead.push(rest[i], ...(['--project', '--db'].includes(rest[i]) ? [rest[++i]] : []));
        args.push(...rest.slice(i));
    }
    else
        for (let i = 0; i < rest.length; i++)
            rest[i].startsWith('--') ? (['--expand', '--no-expand', '--all', '--here', '--fast', '--full', '--pointers', '--short', '--checkout', '--clean'].includes(rest[i]) ? 0 : i++) : args.push(rest[i]);
    const cfg = loadConfig();
    if (cmd === 'asof' && process.argv.includes('--clean'))
        (console.log((await import("./query/checkout.js")).cleanCheckouts(cfg.memDir)), process.exit(0));
    const leadFlag = (n) => (lead.includes(`--${n}`) ? lead[lead.indexOf(`--${n}`) + 1] : undefined);
    const dbPath = xp(cmd === 'tests' ? leadFlag('db') : flag('db')) ?? join(cfg.memDir, 'graph.db');
    // resume starts with where another session of this project stopped, read from its live chat: it needs no store.
    let live = '';
    if (cmd === 'resume' && !process.argv.includes('--short') && !flag('mates-since') && (flag('project') || process.argv.includes('--here'))) {
        const { handoffBlock, insideAgent, ownChat } = await import("./hooks/handoff.js");
        const project = xp(flag('project')) ?? process.cwd();
        const block = handoffBlock(cfg, project, ownChat(cfg, project, insideAgent()));
        if (block)
            live = `## Live handoff (read from the chat file now)\n${block}`;
    }
    if (!existsSync(dbPath))
        (live ? (console.log(live), process.exit(0)) : (console.error(`no graph at ${dbPath}: run \`thenwise ingest\``), process.exit(2)));
    const g = new Graph(dbPath, { lazy: !process.argv.includes('--full') }); // lazy reads only what the command touches; --full loads the whole graph
    g.expand = process.argv.includes('--expand');
    // Without --project or --here every project is searched (the older behaviour); --all says so out loud.
    const opts = cmd === 'tests' ? lead : process.argv;
    const project = cmd === 'tests' ? leadFlag('project') : flag('project');
    if (!opts.includes('--all') && (project || opts.includes('--here') || opts.includes('--checkout')))
        g.scopeTo(xp(project) ?? process.cwd());
    const q = args.join(' ');
    const need = (ok) => ok || (console.error(USAGE), process.exit(2));
    need(cmd === 'resume' || cmd === 'digest' || cmd === 'cost' || args.length > 0);
    // A date that does not parse is an input error: say so on stderr and exit 2, so a script or agent never reads it as an answer.
    if (cmd === 'asof' && Number.isNaN(Date.parse(endOf(args[0]))))
        (console.error(`asof needs an ISO date or date and time first, such as 2026-10-19 or 2026-10-19T06:50:00Z; got "${args[0]}".`), process.exit(2));
    if (cmd === 'search')
        console.log(process.argv.includes('--pointers') ? c.pointers(g, q) : c.search(g, q));
    else if (cmd === 'current')
        console.log(c.current(g, q));
    else if (cmd === 'why')
        console.log(c.why(g, q));
    else if (cmd === 'tried')
        console.log(c.tried(g, q));
    else if (cmd === 'trace')
        console.log(c.trace(g, q));
    else if (cmd === 'resume' && flag('mates-since'))
        console.log(c.mateLatest(g, Date.parse(flag('mates-since')) || 0).join('\n'));
    else if (cmd === 'resume')
        console.log(process.argv.includes('--short') ? c.resumeShort(g) : [live, c.resume(g, q)].filter(Boolean).join('\n\n'));
    else if (cmd === 'digest' || cmd === 'cost') {
        // A bare --since has already stopped at the flag check; a value that is no time is an input error too.
        const raw = flag('since') ?? (cmd === 'digest' ? '24h' : '7d');
        const since = sinceOf(raw);
        if (Number.isNaN(since))
            (console.error(`--since needs 24h, 7d or a date such as 2026-11-01, found ${raw}`), process.exit(2));
        console.log(cmd === 'digest' ? (await import("./query/digest.js")).digest(g, since) : (await import("./query/cost.js")).costReport(g, since, q));
    }
    else if (cmd === 'get')
        console.log(c.get(g, q));
    else if (cmd === 'tests')
        console.log(c.testHistory(g, (await import("./ingest/facts.js")).testKey(q, resolve(xp(leadFlag('project')) ?? process.cwd()))) || `no failed run of "${q}" with an edit before it is recorded`);
    else if (cmd === 'asof' && process.argv.includes('--checkout')) {
        console.log((await import("./query/checkout.js")).checkout(g, args[0], cfg.memDir));
        if (args.length > 1)
            console.log(`\n${c.asof(g, args[0], args.slice(1).join(' '))}`);
    }
    else if (cmd === 'asof')
        (need(args.length > 1), console.log(c.asof(g, args[0], args.slice(1).join(' '))));
    else if (cmd === 'path')
        (need(args.length > 1), console.log(c.path(g, args[0], args.slice(1).join(' '))));
    process.exit(0);
}
console.error(USAGE);
process.exit(2);
