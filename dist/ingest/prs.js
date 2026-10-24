// Pull requests through the GitHub CLI, read only. `gh pr list` is the one call. The answer is cached in the data
// folder and fetched at most once a day per repo. Any failure keeps the cache; a hung call is killed after 20 s.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubSlug } from "./repos.js";
const DAY = 86400000;
const RETRY = 3600000; // after a failure, ask again no sooner than this
export const FIELDS = 'number,title,body,state,createdAt,mergedAt,mergeCommit,url,files,comments,headRefName,baseRefName';
const cacheFile = (cfg) => join(cfg.memDir, 'prs-cache.json');
function readCache(cfg) {
    try {
        return existsSync(cacheFile(cfg)) ? JSON.parse(readFileSync(cacheFile(cfg), 'utf8')) : {};
    }
    catch {
        return {};
    }
}
const slugsOf = (cfg, repos) => {
    const out = repos.flatMap((repo) => {
        const slug = githubSlug(repo);
        return slug ? [{ slug, repo }] : [];
    });
    for (const slug of cfg.githubRepos)
        if (!out.some((t) => t.slug === slug))
            out.push({ slug, repo: '' });
    return out;
};
export function fetchPrs(cfg, repos, opts = {}) {
    const now = opts.now ?? Date.now();
    const cache = readCache(cfg);
    const out = { inputs: [], lines: [] };
    if (!cfg.prs)
        return (out.lines.push('PRs: off in the config'), out);
    let dirty = false;
    let noGh = false;
    for (const { slug, repo } of slugsOf(cfg, repos)) {
        const e = cache[slug];
        const fresh = !!e && !!e.fetchedAt && !e.error && now - e.fetchedAt < DAY;
        const backoff = !!e && !!e.error && now - e.tried < RETRY;
        if (!fresh && !backoff && !noGh) {
            try {
                const raw = execFileSync('gh', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '2000', '--json', FIELDS], { encoding: 'utf8', maxBuffer: 1 << 29, timeout: opts.timeoutMs ?? 20000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
                const prs = JSON.parse(raw);
                if (!Array.isArray(prs))
                    throw new Error('gh did not return a list');
                cache[slug] = { fetchedAt: now, tried: now, error: '', prs };
                dirty = true;
            }
            catch (err) {
                if (err?.code === 'ENOENT')
                    noGh = true;
                else {
                    const why = err?.signal === 'SIGKILL' ? 'gh took longer than 20 s' : String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 200);
                    cache[slug] = { fetchedAt: e?.fetchedAt ?? 0, tried: now, error: why, prs: e?.prs ?? [] };
                    dirty = true;
                }
            }
        }
        const c = cache[slug];
        out.lines.push(!c ? `PRs ${slug}: skipped, gh is not installed` : c.error ? `PRs ${slug}: ${c.prs.length} from the cache, stale (${c.error})` : `PRs ${slug}: ${c.prs.length}, fetched ${new Date(c.fetchedAt).toISOString()}`);
        if (c?.prs.length)
            out.inputs.push({ full: slug, list: c.prs, ...(repo ? { repo } : {}) });
    }
    if (dirty) {
        writeFileSync(`${cacheFile(cfg)}.tmp`, JSON.stringify(cache), { mode: 0o600 });
        renameSync(`${cacheFile(cfg)}.tmp`, cacheFile(cfg));
        chmodSync(cacheFile(cfg), 0o600);
    }
    return out;
}
/** The cached state. The only call is `gh --version`, to say whether gh can be used. */
export function prStatus(cfg, repos) {
    const cache = readCache(cfg);
    const slugs = slugsOf(cfg, repos);
    if (!slugs.length)
        return ['PRs: no repo with a GitHub remote'];
    const lines = spawnSync('gh', ['--version'], { stdio: 'ignore' }).error ? ['PRs skipped: gh is not installed (install it and sign in to read pull requests)'] : [];
    return lines.concat(slugs.map(({ slug }) => {
        const c = cache[slug];
        return !c ? `PRs ${slug}: not fetched (gh missing or not tried yet)` : c.error ? `PRs ${slug}: ${c.prs.length} cached, stale (${c.error})` : `PRs ${slug}: ${c.prs.length}, last fetch ${new Date(c.fetchedAt).toISOString()}`;
    }));
}
