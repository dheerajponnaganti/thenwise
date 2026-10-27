// `thenwise team ...`, `share` and `unshare` (teams preview). Called from main.ts; returns the exit code.
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from "../ingest/config.js";
import { formatPreview, previewShare, pushShared, setServerStatus, sharesStatus, unshareChats, updateShares, PUSH_PER_SYNC } from "./chats.js";
import { fetchShared, flush, joinTeam, LABEL, load as loadTeam, payloadOf, pull, resolveNote, search, sharedIds, share, unshare } from "./client.js";
import { backupTeam, createTeamServer, invite, listMembers, openTeamDb, removeMember, restoreTeam, rotate } from "./server.js";
export const TEAM_USAGE = `thenwise team serve [--port N] [--host H] [--dir <server folder>] [--console <hub folder>] [--allow-origin <origin>] [--tls-behind-proxy | --allow-plain-http]   (${LABEL})
thenwise team invite <name> [--days N] [--again] | remove <name> [--keep-notes | --delete-notes] | members | rotate <name> | backup <file> | restore <file>   (run where the server runs)
thenwise team join <url> <token> | search <words> | sync | pull
thenwise team share-chats <repo path> [--since <date>] [--yes] | unshare-chats <project or session id> [--pause] | shares
thenwise share <note id or file.md> [--yes] | unshare <note id or file.md>`;
async function confirm(q) {
    if (!process.stdin.isTTY)
        return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(q);
    rl.close();
    return /^y(es)?$/i.test(a.trim());
}
export async function teamMain(argv, flag) {
    const [cmd, sub, ...rest] = argv;
    const cfg = loadConfig(homedir());
    const dir = cfg.memDir;
    const serverDir = flag('dir') ?? join(dir, 'team-server');
    const BOOL = ['--keep-notes', '--delete-notes', '--yes', '--again', '--pause', '--tls-behind-proxy', '--allow-plain-http'];
    const words = rest.filter((w, i) => !w.startsWith('--') && (!rest[i - 1]?.startsWith('--') || BOOL.includes(rest[i - 1])));
    try {
        if (cmd === 'share' || cmd === 'unshare') {
            const arg = sub;
            if (!arg)
                return (console.error(TEAM_USAGE), 2);
            if (cmd === 'unshare')
                return (console.log(await unshare(dir, sharedIds(dir).includes(arg) ? arg : resolveNote(cfg.memDir, cfg.claudeDir, arg).id)), 0);
            const n = resolveNote(cfg.memDir, cfg.claudeDir, arg);
            const { payload, masked } = payloadOf(n);
            console.log(`${LABEL}: this note will be sent to the team server\n  id: ${n.id}\n  title: ${payload.title}\n  project: ${payload.project || '(none)'}\n  secrets masked: ${masked}\n---\n${payload.text.slice(0, 1500)}${payload.text.length > 1500 ? '\n[cut for the preview, the whole note is sent]' : ''}\n---`);
            if (!process.argv.includes('--yes') && !(await confirm('Share it? [y/N] ')))
                return (console.log('not shared'), 1);
            console.log(await share(dir, n.id, payload));
            return 0;
        }
        if (cmd !== 'team')
            return 2;
        if (sub === 'serve') {
            const app = createTeamServer({
                dir: serverDir,
                ...(flag('host') ? { host: flag('host') } : {}),
                port: Number(flag('port') ?? 8788),
                ...(flag('console') ? { console: resolve(flag('console')) } : {}),
                allowOrigins: (flag('allow-origin') ?? '').split(',').filter(Boolean),
                tlsBehindProxy: process.argv.includes('--tls-behind-proxy'),
                allowPlainHttp: process.argv.includes('--allow-plain-http'),
            });
            const { host, port } = await app.listen();
            console.log(`thenwise team server (${LABEL}) listening on http://${host}:${port}, data in ${serverDir}\nThere is no TLS here. For other hosts, put an https proxy in front.`);
            const stop = () => void app.close().then(() => process.exit(0));
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            await new Promise(() => undefined);
        }
        else if (sub === 'backup' || sub === 'restore') {
            if (!words[0])
                return (console.error(TEAM_USAGE), 2);
            if (sub === 'backup')
                (backupTeam(serverDir, words[0]), console.log(`team backed up to ${words[0]} (notes, members and audit; mode 0600)`));
            else
                console.log(`team restored from ${words[0]} (schema ${restoreTeam(serverDir, words[0])}) into ${serverDir}`);
        }
        else if (sub === 'members') {
            const db = openTeamDb(serverDir);
            const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');
            for (const m of listMembers(db))
                console.log(`${m.name.padEnd(20)} ${m.role.padEnd(8)} expires ${day(m.expires_at)}  last seen ${day(m.last_seen)}${m.disabled ? '  removed, notes kept' : ''}`);
            db.close();
        }
        else if (sub === 'invite' || sub === 'remove' || sub === 'rotate') {
            if (!words[0])
                return (console.error(TEAM_USAGE), 2);
            const db = openTeamDb(serverDir);
            if (sub === 'invite' || sub === 'rotate') {
                const token = sub === 'rotate' ? rotate(db, words[0]) : invite(db, words[0], flag('days') ? Date.now() + Number(flag('days')) * 864e5 : undefined, { again: rest.includes('--again') });
                console.log(`${sub === 'rotate' ? 'new ' : ''}token for ${words[0]} (shown once, ${LABEL})${sub === 'rotate' ? '; the old one no longer works' : ''}:\n${token}\nThey join with: thenwise team join <server url> ${token}`);
            }
            else {
                const keep = rest.includes('--keep-notes');
                if (keep && rest.includes('--delete-notes'))
                    return (db.close(), console.error(TEAM_USAGE), 2);
                let doKeep = keep;
                if (!keep && !rest.includes('--delete-notes')) {
                    if (!process.stdin.isTTY)
                        return (db.close(), console.error(TEAM_USAGE), 2);
                    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM notes n JOIN members m ON m.id = n.owner_id WHERE m.name = ?').get(words[0]).n);
                    console.log(`${words[0]} shared ${n} note${n === 1 ? '' : 's'}`);
                    doKeep = await confirm('Keep them for the team? [y/N] ');
                }
                const r = removeMember(db, words[0], doKeep);
                console.log(r.removed ? `removed ${words[0]}; token revoked; ${r.notes} shared note${r.notes === 1 ? '' : 's'} ${doKeep ? 'kept' : 'deleted'}` : `${words[0]} is not a member`);
            }
            db.close();
        }
        else if (sub === 'join') {
            if (words.length < 2)
                return (console.error(TEAM_USAGE), 2);
            console.log(`joined as ${await joinTeam(dir, words[0], words[1])} (${LABEL}); nothing is shared until you run \`thenwise share\``);
        }
        else if (sub === 'search') {
            if (!words.length)
                return (console.error(TEAM_USAGE), 2);
            const r = await search(dir, words.join(' '));
            console.log(r.length ? `${r.join('\n')}\n(${LABEL})` : `no shared notes match (${LABEL})`);
        }
        else if (sub === 'share-chats') {
            if (!words[0])
                return (console.error(TEAM_USAGE), 2);
            loadTeam(dir);
            const since = flag('since');
            if (since && Number.isNaN(Date.parse(since)))
                return (console.error(`--since needs a date such as 2026-01-31, found ${since}`), 2);
            const pv = previewShare(cfg, words[0], since ? { since } : {});
            console.log(formatPreview(pv, cfg.redact));
            if (!pv.chats)
                return (console.log('no chats to share'), 1);
            if (!process.argv.includes('--yes') && !(await confirm('Share these chats with the team? Type yes: ')))
                return (console.log('not shared'), 1);
            updateShares(dir, (s) => {
                for (const [id, p] of Object.entries(s.removed))
                    if (p === pv.project)
                        (delete s.removed[id], delete s.serverGone?.[id]);
                s.projects[pv.project] = { repo: pv.repo, status: 'active', reshare: true, ...(since ? { since } : {}) };
            });
            await setServerStatus(dir, pv.project, 'active');
            console.log(await pushShared(cfg));
            console.log(`The rest goes ${PUSH_PER_SYNC} chats at a time at each sync. \`thenwise team unshare-chats ${pv.project}\` takes them back.`);
        }
        else if (sub === 'unshare-chats') {
            if (!words[0])
                return (console.error(TEAM_USAGE), 2);
            console.log(await unshareChats(cfg, words[0], { pause: process.argv.includes('--pause') }));
        }
        else if (sub === 'shares') {
            const { lines } = sharesStatus(cfg);
            console.log(lines.length ? lines.join('\n') : `no chats are shared (${LABEL})`);
        }
        else if (sub === 'sync') {
            console.log(await flush(dir));
            const pushed = await pushShared(cfg);
            if (pushed)
                console.log(pushed);
            try {
                console.log(await fetchShared(dir));
            }
            catch (e) {
                console.log(`team notes not fetched: ${e instanceof Error ? e.message : e} (${LABEL})`);
            }
        }
        else if (sub === 'pull')
            console.log(await pull(dir));
        else
            return (console.error(TEAM_USAGE), 2);
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : e);
        return 1;
    }
    return 0;
}
