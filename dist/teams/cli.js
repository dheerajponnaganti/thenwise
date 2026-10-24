// `thenwise team ...`, `share` and `unshare` (teams preview). Called from main.ts; returns the exit code.
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from "../ingest/config.js";
import { flush, joinTeam, LABEL, payloadOf, resolveNote, search, sharedIds, share, unshare } from "./client.js";
import { createTeamServer, invite, openTeamDb, removeMember } from "./server.js";
export const TEAM_USAGE = `thenwise team serve [--port N] [--host H] [--dir <server folder>]   (${LABEL})
thenwise team invite <name> [--days N] | remove <name>   (run where the server runs)
thenwise team join <url> <token> | search <words> | sync
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
    const words = rest.filter((w, i) => !w.startsWith('--') && !rest[i - 1]?.startsWith('--'));
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
            const app = createTeamServer({ dir: serverDir, ...(flag('host') ? { host: flag('host') } : {}), port: Number(flag('port') ?? 8788) });
            const { host, port } = await app.listen();
            console.log(`thenwise team server (${LABEL}) listening on http://${host}:${port}, data in ${serverDir}\nThere is no TLS here. For other hosts, put an https proxy in front.`);
            const stop = () => void app.close().then(() => process.exit(0));
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            await new Promise(() => undefined);
        }
        else if (sub === 'invite' || sub === 'remove') {
            if (!words[0])
                return (console.error(TEAM_USAGE), 2);
            const db = openTeamDb(serverDir);
            if (sub === 'invite') {
                const token = invite(db, words[0], flag('days') ? Date.now() + Number(flag('days')) * 864e5 : undefined);
                console.log(`token for ${words[0]} (shown once, ${LABEL}):\n${token}\nThey join with: thenwise team join <server url> ${token}`);
            }
            else
                console.log(removeMember(db, words[0]) ? `removed ${words[0]}; their token and shared notes are gone` : `${words[0]} is not a member`);
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
        else if (sub === 'sync')
            console.log(await flush(dir));
        else
            return (console.error(TEAM_USAGE), 2);
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : e);
        return 1;
    }
    return 0;
}
