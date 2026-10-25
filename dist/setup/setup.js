// `thenwise setup` (alias `init`): lists the projects found in Claude Code's history, asks where the vault lives and
// what else to read, writes config.json in one atomic step, then runs the first sync.
// Every question has a flag; --yes takes the current answers (or the defaults on a first run) with no prompts.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { cloudWarning, expandHome, resolveDataDir } from "../core/home.js";
import { globMatch, loadConfigSafe, readConfigFile, saveConfig } from "../ingest/config.js";
import { OURS } from "../vault/user.js";
import { ghSignedIn } from "./doctor.js";
import { discoverProjects } from "./projects.js";
const DEFAULT_EXCLUDE = ['-private-tmp*', '*-claude-mem-observer-sessions'];
// "project" is not offered: the writer needs a vault path, so a per-project vault would never be written.
const PLACES = ['central', 'obsidian'];
const gitRoot = (dir) => {
    for (let d = resolve(dir);; d = dirname(d)) {
        if (existsSync(join(d, '.git')))
            return d;
        if (dirname(d) === d)
            return null;
    }
};
/** Adds one line to <repo>/.gitignore and keeps the rest of the file. */
export function ignoreFolder(repo, dir) {
    const line = `${relative(repo, dir).split(sep).join('/')}/`;
    const file = join(repo, '.gitignore');
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === `/${line}`))
        return;
    writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}
export async function setup(argv, home = homedir()) {
    const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
    const has = (n) => argv.includes(`--${n}`);
    const list = (n) => (val(n) === undefined ? undefined : val(n).split(',').map((x) => x.trim()).filter((x) => x && x !== 'none'));
    const yes = has('yes') || has('y');
    const out = (s = '') => console.log(s);
    const lines = [];
    const waiting = [];
    let closed = false;
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
    rl.on('close', () => {
        closed = true;
        for (const w of waiting.splice(0))
            w(null);
    });
    const ask = async (q, dflt = '') => {
        process.stdout.write(`${q}${dflt ? ` [${dflt}]` : ''} `);
        const a = lines.length ? lines.shift() : closed ? null : await new Promise((r) => waiting.push(r));
        if (a === null)
            throw new Error('input closed');
        return a.trim() || dflt;
    };
    const yn = async (q, dflt) => /^y/i.test(await ask(`${q} (y/n)`, dflt ? 'y' : 'n'));
    try {
        return await run();
    }
    catch (e) {
        if (e.message !== 'input closed')
            throw e;
        out('\nSetup cancelled. Nothing was changed.');
        return 1;
    }
    finally {
        rl.close();
    }
    async function run() {
        const claudeDir = join(home, '.claude');
        const found = discoverProjects(claudeDir);
        if (!found.length) {
            out(`Claude Code has no chats yet (nothing under ${join(claudeDir, 'projects')}). Run \`thenwise setup\` again after your first session.`);
            return 0;
        }
        let memDir = resolveDataDir(home);
        const read = readConfigFile(memDir);
        if (!read.raw || read.errors.length) {
            for (const e of read.errors)
                console.error(`error: ${e}`);
            return 2;
        }
        const prev = read.raw;
        const again = existsSync(read.file);
        const ing = prev.ingest ?? {};
        if (basename(memDir) === '.memory' && dirname(memDir) === home && !existsSync(join(home, '.thenwise'))) {
            out(`Your data is in ${memDir} (the older folder). It stays there and keeps working.`);
            if (has('move-data') || (!yes && (await yn(`Move it to ${join(home, '.thenwise')} now?`, false)))) {
                renameSync(memDir, join(home, '.thenwise'));
                memDir = join(home, '.thenwise');
                out(`Moved to ${memDir}.`);
            }
        }
        if (again) {
            out(`Current setup (${read.file}):`);
            out(`  projects dropped: ${(prev.exclude_projects ?? DEFAULT_EXCLUDE).join(', ') || 'none'}`);
            out(`  vault: ${prev.vault ? `${prev.vault.place}${prev.vault.path ? ` at ${prev.vault.path}` : ''}, ${prev.vault.layout ?? 'shared'}` : 'not set'}`);
            out(`  notes folders: ${(ing.vaults ?? []).join(', ') || 'none'}`);
            out(`  PRs through gh: ${ing.prs ? 'yes' : 'no'}; backup: ${prev.backup?.kind ?? 'none'}`);
            out();
        }
        // 1. Projects
        const excl = prev.exclude_projects ?? DEFAULT_EXCLUDE;
        const dropped = new Set(found.filter((p) => excl.some((g) => globMatch(g, p.key))).map((p) => p.key));
        const named = (names) => found.filter((p) => names.some((n) => n === p.key || n === p.folder || n === (p.folder && basename(p.folder))));
        if (val('projects') !== undefined) {
            const keep = new Set(named(list('projects')).map((p) => p.key));
            for (const p of found)
                keep.has(p.key) ? dropped.delete(p.key) : dropped.add(p.key);
        }
        for (const p of named(list('drop') ?? []))
            dropped.add(p.key);
        const show = () => {
            out('Projects found in your Claude Code history:');
            found.forEach((p, i) => out(`  ${String(i + 1).padStart(2)}. [${dropped.has(p.key) ? ' ' : 'x'}] ${p.folder ? basename(p.folder) : p.key}  ${p.chats} chat${p.chats === 1 ? '' : 's'}  ${p.folder ?? '(folder unknown)'}${p.clash.length ? `  (the same key also holds: ${p.clash.join(', ')})` : ''}`));
        };
        show();
        if (!yes && val('projects') === undefined && val('drop') === undefined) {
            for (;;) {
                const a = await ask('Numbers to drop or bring back (comma separated), Enter to continue:');
                if (!a)
                    break;
                for (const n of a.split(/[,\s]+/).map(Number)) {
                    const p = found[n - 1];
                    if (p)
                        dropped.has(p.key) ? dropped.delete(p.key) : dropped.add(p.key);
                }
                show();
            }
        }
        const chosen = found.filter((p) => !dropped.has(p.key));
        const folders = chosen.flatMap((p) => (p.folder ? [p.folder] : []));
        const exclude = excl.filter((g) => !chosen.some((p) => globMatch(g, p.key)));
        for (const k of dropped)
            if (!exclude.some((g) => globMatch(g, k)))
                exclude.push(k);
        // 2. Vault
        const pv = prev.vault ?? {};
        let place = val('place') ?? pv.place ?? 'central';
        if (!PLACES.includes(place) && place !== pv.place)
            return fail(`--place must be one of ${PLACES.join(', ')}`);
        if (!yes && val('place') === undefined) {
            out('\nWhere should the vault (the curated notes) live?\n  1. a central folder, outside your repos and cloud folders (default)\n  2. inside an existing Obsidian vault');
            place = PLACES[Number(await ask('Choice:', String(PLACES.indexOf(place) + 1))) - 1] ?? place;
        }
        let layout = val('layout') ?? pv.layout ?? 'shared';
        if (!['shared', 'per-project'].includes(layout))
            return fail('--layout must be shared or per-project');
        if (place !== 'project' && !yes && val('layout') === undefined)
            layout = /^p/i.test(await ask('One shared vault with a folder per project, or one vault per project? (shared/per-project)', layout)) ? 'per-project' : 'shared';
        let vpath = val('vault-path') ?? pv.path ?? (place === 'central' ? '~/Thenwise' : '');
        if (place !== 'project' && !yes && val('vault-path') === undefined)
            vpath = await ask(place === 'obsidian' ? 'Path of your Obsidian vault:' : 'Folder for the vault:', vpath);
        if (place === 'obsidian' && !vpath)
            return fail('an Obsidian vault needs --vault-path');
        if (place === 'project')
            vpath = '';
        const dirs = place === 'project' ? folders.map((f) => join(f, 'Thenwise')) : [place === 'obsidian' ? join(expandHome(vpath, home), OURS) : resolve(expandHome(vpath, home))];
        const cloud = dirs.map(cloudWarning).find(Boolean);
        if (cloud) {
            out(cloud);
            if (!has('allow-cloud') && (yes || !(await yn('Use it anyway?', false))))
                return fail('choose another folder, or pass --allow-cloud to accept the risk');
        }
        const repos = [...new Set(dirs.flatMap((d) => gitRoot(d) ?? []))];
        let commit = has('commit-vault') ? true : has('no-commit-vault') ? false : pv.commit ?? false;
        if (repos.length && !yes && !has('commit-vault') && !has('no-commit-vault'))
            commit = await yn(`The vault sits inside a git repo (${repos.join(', ')}). Commit it to that repo?`, commit);
        // 3. Notes, PRs, backup
        let notes = list('notes') ?? ing.vaults ?? [];
        if (!yes && val('notes') === undefined)
            notes = (await ask('Folders of notes to read (comma separated, Enter for none):', notes.join(', '))).split(',').map((x) => x.trim()).filter(Boolean);
        const signedIn = ghSignedIn();
        let prs = has('prs') ? true : has('no-prs') ? false : ing.prs ?? false;
        if (prs && !signedIn)
            (out('gh is not signed in, so PRs are skipped. Run `gh auth login`, then `thenwise setup --prs`.'), (prs = false));
        else if (signedIn && !yes && !has('prs') && !has('no-prs'))
            prs = await yn('Read pull requests through gh (read only, cached)?', prs);
        let kind = val('backup') ?? prev.backup?.kind ?? 'none';
        if (!['none', 'git', 'folders'].includes(kind))
            return fail('--backup must be none, git or folders');
        let bfolders = list('backup-folders') ?? prev.backup?.folders ?? [];
        if (!yes && val('backup') === undefined)
            kind = (await ask('Back up the vault to: none, git or folders?', kind)).toLowerCase();
        if (kind === 'folders' && !yes && val('backup-folders') === undefined)
            bfolders = (await ask('Folders to copy it to (comma separated):', bfolders.join(', '))).split(',').map((x) => x.trim()).filter(Boolean);
        if (!['none', 'git', 'folders'].includes(kind))
            return fail('backup must be none, git or folders');
        // 4. Save, all at once
        const keepOwn = (old) => old.filter((p) => !found.some((f) => f.folder === expandHome(p, home)));
        const next = {
            ...prev,
            exclude_projects: exclude,
            ingest: {
                ...ing,
                roots: [...keepOwn(ing.roots ?? []), ...folders],
                repos: [...keepOwn(ing.repos ?? []), ...folders.filter((f) => existsSync(join(f, '.git')))],
                github_repos: ing.github_repos ?? [],
                vaults: notes,
                prs,
            },
            vault: { place, layout, ...(vpath ? { path: vpath } : {}), commit },
            backup: { kind, ...(kind === 'folders' ? { folders: bfolders } : {}) },
        };
        saveConfig(memDir, next);
        if (!commit)
            for (const d of dirs)
                gitRoot(d) && ignoreFolder(gitRoot(d), d);
        out(`\nSaved ${join(memDir, 'config.json')}.`);
        // 5. First sync
        if (has('no-sync'))
            return 0;
        const { config: cfg } = loadConfigSafe(home);
        const { archive } = await import("../ingest/archive.js");
        const { ingest } = await import("../ingest/ingest.js");
        const r = archive(cfg, { onProgress: (done, total) => (done === total || done % 25 === 0) && console.error(`archiving chats: ${done} of ${total}`) });
        console.error('building the memory...');
        const g = ingest(cfg);
        for (const w of g.warnings)
            console.error(`warning: ${w}`);
        out(`Found ${found.length} project${found.length === 1 ? '' : 's'}: ${chosen.length} kept, ${dropped.size} dropped.`);
        out(`Archived ${r.archived + r.skipped} chats (${r.excludedChats} test chats and ${r.excluded} chats of dropped projects left out). ${g.sessionsIn} chats are in the memory.`);
        out('Try: thenwise search <words>');
        return 0;
    }
    function fail(msg) {
        console.error(`error: ${msg}`);
        return 2;
    }
}
