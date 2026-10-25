// `thenwise forget <session id or project folder>`: removes a chat or a project from the archive, the store, the hook
// state, the backups and the team server, and leaves a tombstone so the next sync does not bring it back from
// Claude Code's own chat files. Those files are never touched. The whole run holds the sync lock.
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from "../backup/backup.js";
import { readNotes } from "../capture/notes.js";
import { expandHome, legacyDir } from "../core/home.js";
import { normPath } from "../core/vault-index.js";
import { takeLock } from "../hooks/hook.js";
import { tighten } from "./perms.js";
import { dropPrCache, ingest } from "../ingest/ingest.js";
import { githubSlug, repoRoot } from "../ingest/repos.js";
import { sharedIds, unshare } from "../teams/client.js";
import { writeVault } from "../vault/vault.js";
import { loadTombs, saveTombs, sessionOf, underFolder } from "./tombstones.js";
/** The one place the vault writer plugs in: after a forget the vault is rewritten from the store. */
export function rewriteVault(cfg) {
    writeVault(cfg);
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lockSync(file, waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
        try {
            if (takeLock(file))
                return;
        }
        catch { }
        if (Date.now() > until)
            throw new Error(`another sync holds ${file}; try again when it ends`);
        sleep(100);
    }
}
const list = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);
/** Every (project, session) Thenwise knows about: archived, in the manifest, or still in Claude Code's own files. */
function chatsOf(cfg) {
    const base = join(cfg.memDir, 'archive');
    const cwds = new Map();
    const seen = new Map();
    const add = (key, id) => seen.set(`${key}/${id}`, { key, id, cwd: cwds.get(`${key}/${id}`) ?? '' });
    try {
        const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
        for (const [rel, e] of Object.entries(manifest)) {
            if (e.cwd)
                cwds.set(`${rel.split('/')[0]}/${sessionOf(rel)}`, e.cwd);
            add(rel.split('/')[0], sessionOf(rel));
        }
    }
    catch { }
    for (const root of [join(base, 'sessions'), join(base, 'claude-projects'), join(cfg.claudeDir, 'projects')]) {
        for (const p of list(root).filter((e) => e.isDirectory()))
            for (const e of list(join(root, p.name)))
                add(p.name, e.name.replace(/\.jsonl(\.gz)?$/, ''));
    }
    return [...seen.values()];
}
const claudeKey = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-');
/** Project keys with plan snapshots that the target names: by key, or by a recorded folder at or under it. */
function planKeys(cfg, target, folder) {
    const base = join(cfg.memDir, 'archive', 'plans');
    return list(base).filter((e) => e.isDirectory()).map((e) => e.name).filter((k) => {
        try {
            return underFolder(readFileSync(join(base, k, '.folder'), 'utf8'), folder);
        }
        catch {
            return k === target || k === claudeKey(folder);
        }
    });
}
function countSessions(db) {
    if (!existsSync(db))
        return 0;
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return Number(d.prepare("SELECT count(*) AS n FROM nodes WHERE kind = 'session'").get().n);
    }
    finally {
        d.close();
    }
}
async function confirmTty(q) {
    if (!process.stdin.isTTY)
        return false;
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(q);
    rl.close();
    return /^y(es)?$/i.test(a.trim());
}
export async function forget(cfg, target, opts = {}) {
    const out = opts.print ?? ((l) => console.log(l));
    const folder = normPath(resolve(expandHome(target, cfg.home)));
    const all = chatsOf(cfg);
    const byProject = (c) => c.key === target || c.key === claudeKey(folder) || (!!c.cwd && underFolder(c.cwd, folder));
    const hit = (c) => c.id === target || (target.length >= 8 && c.id.startsWith(target)) || byProject(c);
    const chats = all.filter(hit);
    const plans = planKeys(cfg, target, folder);
    if (!chats.length && !plans.length)
        return (out(`Nothing found for "${target}": no chat with that session id and no project with that folder or key.`), 0);
    const projectWide = chats.some(byProject) || plans.length > 0;
    const sessions = [...new Set(chats.map((c) => c.id))];
    const keys = [...new Set([...chats.map((c) => c.key), ...plans])];
    const base = join(cfg.memDir, 'archive');
    const gz = chats.flatMap((c) => [join(base, 'sessions', c.key, `${c.id}.jsonl.gz`), join(base, 'sessions', c.key, c.id), join(base, 'claude-projects', c.key, `${c.id}.jsonl`), join(base, 'claude-projects', c.key, c.id)]).filter(existsSync);
    out(`Will forget ${sessions.length} chat${sessions.length === 1 ? '' : 's'} (${projectWide ? `project ${target}` : `session ${target}`}); ${gz.length} archived item${gz.length === 1 ? '' : 's'} will be removed.`);
    if (!opts.yes && !(await (opts.confirm ?? confirmTty)('Forget them? This cannot be undone. [y/N] ')))
        return (out('Nothing was removed.'), 1);
    lockSync(join(cfg.memDir, 'sync.lock'), opts.waitMs ?? 10 * 60000);
    try {
        const tombs = loadTombs(cfg.memDir);
        if (projectWide) {
            // A mangled key is shared by /x/my.app and /x/my-app: record one only for a key target or a chat with no folder known.
            tombs.projects.push(...chats.filter((c) => byProject(c) && (c.key === target || !c.cwd)).map((c) => c.key));
            tombs.folders.push(folder);
            tombs.sessions.push(...sessions);
        }
        else
            tombs.sessions.push(...sessions);
        saveTombs(cfg.memDir, tombs);
        for (const p of gz)
            rmSync(p, { recursive: true, force: true });
        for (const k of plans)
            rmSync(join(base, 'plans', k), { recursive: true, force: true });
        const mfile = join(base, 'manifest.json');
        let manifestGone = 0;
        if (existsSync(mfile)) {
            const m = JSON.parse(readFileSync(mfile, 'utf8'));
            for (const rel of Object.keys(m))
                if (chats.some((c) => rel.split('/')[0] === c.key && sessionOf(rel) === c.id))
                    (delete m[rel], manifestGone++);
            writeFileSync(`${mfile}.tmp`, JSON.stringify(m, null, 1), { mode: 0o600 });
            renameSync(`${mfile}.tmp`, mfile);
            chmodSync(mfile, 0o600);
        }
        let state = 0;
        for (const id of sessions) {
            const f = join(cfg.memDir, 'hook-state', `${id.replace(/[^\w-]/g, '_')}.json`);
            if (existsSync(f))
                (rmSync(f), state++);
        }
        const db = join(cfg.memDir, 'graph.db');
        const before = countSessions(db);
        if (projectWide) {
            // Its cached PRs go too; ingest keeps the repo out from now on.
            const repo = repoRoot(folder);
            const slug = repo && underFolder(repo, folder) ? githubSlug(repo) : undefined;
            if (slug)
                dropPrCache(cfg.memDir, [slug]);
        }
        if (existsSync(db))
            ingest(cfg);
        const inStore = before - countSessions(db);
        let shared = 0;
        if (existsSync(join(cfg.memDir, 'team.json'))) {
            const mine = new Set(sharedIds(cfg.memDir));
            for (const n of readNotes(cfg.memDir)) {
                if (!mine.has(n.id) || !(n.sources.some((s) => sessions.some((id) => s.includes(id))) || (!!n.project && projectWide && underFolder(n.project, folder))))
                    continue;
                try {
                    await unshare(cfg.memDir, n.id);
                    shared++;
                }
                catch (e) {
                    out(`could not unshare ${n.id}: ${e.message}`);
                }
            }
        }
        const notes = readNotes(cfg.memDir).filter((n) => n.sources.some((s) => sessions.some((id) => s.includes(id)))).length;
        (opts.rewriteVault ?? rewriteVault)(cfg);
        const backups = cfg.backup.kind === 'folders' ? backup(cfg).lines : [];
        out(`Forgot ${sessions.length} chat${sessions.length === 1 ? '' : 's'}.`);
        out(`  archive: ${gz.length} item${gz.length === 1 ? '' : 's'} removed, ${manifestGone} manifest entr${manifestGone === 1 ? 'y' : 'ies'}`);
        out(`  store: ${inStore} session${inStore === 1 ? '' : 's'} removed`);
        out(`  plan snapshots: ${plans.length} project${plans.length === 1 ? '' : 's'}`);
        out(`  hook state: ${state} file${state === 1 ? '' : 's'}`);
        out(`  team: ${shared} shared note${shared === 1 ? '' : 's'} unshared`);
        for (const l of backups)
            out(`  backup folders: ${l}`);
        if (notes)
            out(`  ${notes} saved note${notes === 1 ? '' : 's'} cite${notes === 1 ? 's' : ''} these chats and ${notes === 1 ? 'was' : 'were'} kept; review them with: thenwise inbox`);
        const old = legacyDir(cfg.memDir);
        if (old)
            out(`  ${old} is an older data folder that still holds Thenwise data. Forget does not clean it; delete it or run Thenwise with THENWISE_HOME=${old}.`);
        out('Not reachable from here:');
        out(`  Claude Code's own chat files in ${join(cfg.claudeDir, 'projects')} (never touched; a tombstone keeps them out of Thenwise)`);
        out('  git history of a backed-up vault');
        out('  iCloud or Time Machine versions of any folder above');
        out('  copies teammates already pulled');
    }
    finally {
        tighten(cfg.memDir);
        rmSync(join(cfg.memDir, 'sync.lock'), { force: true });
    }
    return 0;
}
