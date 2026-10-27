// Which git repositories a person's chats worked in, found from the chats' working folders. Read only: files are
// looked at and `git config` is read, nothing is written and no network is used.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
/** The main repository folder that holds `dir`. A linked worktree maps to its main repo (what `--git-common-dir` gives). */
export function repoRoot(dir) {
    for (let d = resolve(dir);; d = dirname(d)) {
        const dot = join(d, '.git');
        if (existsSync(dot)) {
            try {
                if (statSync(dot).isDirectory())
                    return d;
                const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]?.trim();
                if (!gitdir)
                    return d;
                const common = join(resolve(d, gitdir), 'commondir');
                if (!existsSync(common))
                    return d; // a submodule: its own repo
                const main = resolve(resolve(d, gitdir), readFileSync(common, 'utf8').trim());
                return basename(main) === '.git' ? dirname(main) : main;
            }
            catch {
                return undefined;
            }
        }
        if (dirname(d) === d)
            return undefined;
    }
}
export const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return p;
    }
};
/** The folder a project is known by: its repository (or the folder itself), as a real path, so two spellings compare equal. */
export const projectRoot = (dir) => real(repoRoot(dir) ?? resolve(dir));
/** The configured repos first, then the repos of the given working folders, each once, in a stable order. */
export function discoverRepos(configured, cwds) {
    const out = [];
    const seen = new Set();
    const add = (r) => seen.has(real(r)) || (seen.add(real(r)), out.push(r));
    for (const r of configured)
        add(r);
    // One lookup per folder (chats repeat the same few), and at most 200 repos found this way.
    const roots = new Map();
    for (const c of new Set([...cwds].filter(Boolean)))
        roots.set(c, repoRoot(c));
    for (const r of [...new Set([...roots.values()].filter((r) => !!r))].sort().slice(0, 200))
        add(r);
    return out;
}
/** `owner/name` of the repo's GitHub remote: origin when it is on GitHub, else the first GitHub remote. None without a remote. */
export function githubSlug(repo) {
    let out = '';
    try {
        out = execFileSync('git', ['-C', repo, 'config', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return undefined;
    }
    const remotes = out.split('\n').filter(Boolean).map((l) => {
        const m = /^remote\.(.+)\.url\s+(.+)$/.exec(l);
        const s = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(m?.[2] ?? '');
        return { name: m?.[1] ?? '', slug: s ? `${s[1]}/${s[2]}` : '' };
    }).filter((r) => r.slug);
    return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.slug;
}
/** The repository a chat belongs to: the one holding its working folder, else the one holding the first folder it edited.
 * A folder that no longer exists maps to no repo. */
export function sessionRepo(cwd, editDirs = []) {
    for (const d of [cwd, ...editDirs]) {
        const r = d ? repoRoot(d) : undefined;
        if (r)
            return real(r);
    }
    return undefined;
}
