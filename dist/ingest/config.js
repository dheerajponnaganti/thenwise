// Config for archive and ingest: <data folder>/config.json merged over defaults. All paths derive from `home`
// so tests can run against a temp directory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome, resolveDataDir } from "../core/home.js";
import { normPath } from "../core/vault-index.js";
import { discoverProjects } from "../setup/projects.js";
export const CONFIG_VERSION = 1;
// A string is a leaf type; an object is a nested table. Unknown keys are warned, wrong types are errors.
const SCHEMA = {
    version: 'number',
    exclude_projects: 'string[]',
    off: 'boolean',
    off_projects: 'string[]',
    ingest: { roots: 'string[]', repos: 'string[]', github_repos: 'string[]', vaults: 'string[]', docs: 'string[]', include_entrypoints: 'string[]', exclude_projects: 'string[]', exclude_markers: 'string[]', gh_timeout_s: 'number', prs: 'boolean', plans: 'boolean', git_all: 'boolean' },
    vault: { place: 'string', layout: 'string', path: 'string', commit: 'boolean' },
    backup: { kind: 'string', folders: 'string[]', push: 'boolean' },
    views: { projects: 'object' },
    scope: 'string',
};
const ENUMS = { 'vault.place': ['central', 'project', 'obsidian'], 'vault.layout': ['shared', 'per-project'], 'backup.kind': ['none', 'git', 'folders'], scope: ['project', 'all'] };
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a table' : `${typeof v} ${JSON.stringify(v)}`);
function check(value, schema, at, errors, warnings) {
    for (const [k, v] of Object.entries(value)) {
        const name = at ? `${at}.${k}` : k;
        const want = schema[k];
        if (want === undefined)
            warnings.push(`unknown key "${name}" (ignored)`);
        else if (typeof want === 'object')
            plain(v) ? check(v, want, name, errors, warnings) : errors.push(`"${name}" must be a table, found ${describe(v)}`);
        else if (want === 'string[]' ? !Array.isArray(v) || v.some((x) => typeof x !== 'string') : want === 'object' ? !plain(v) : typeof v !== want)
            errors.push(`"${name}" must be ${want === 'string[]' ? 'a list of text' : want === 'object' ? 'a table' : `a ${want}`}, found ${describe(v)}`);
        else if (ENUMS[name] && !ENUMS[name].includes(v))
            errors.push(`"${name}" must be one of ${ENUMS[name].join(', ')}, found "${String(v)}"`);
    }
}
// Some Node versions give no position: the first line whose prefix fails for a reason other than being unfinished.
function firstBadLine(text) {
    const lines = text.split('\n');
    for (let n = 1; n <= lines.length; n++) {
        try {
            JSON.parse(lines.slice(0, n).join('\n'));
        }
        catch (e) {
            if (!/end of|unterminated|incomplete/i.test(e.message))
                return n;
        }
    }
    return null;
}
/** Reads and validates <data folder>/config.json. Never throws and never writes. */
export function readConfigFile(memDir) {
    const file = join(memDir, 'config.json');
    const res = { raw: {}, errors: [], warnings: [], file };
    if (!existsSync(file))
        return res;
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (e) {
        return { ...res, raw: null, errors: [`${file}: cannot be read (${e.message})`] };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (e) {
        const msg = e.message;
        const pos = /position (\d+)/.exec(msg);
        const line = /line (\d+)/.exec(msg)?.[1] ?? (pos ? text.slice(0, Number(pos[1])).split('\n').length : firstBadLine(text));
        return { ...res, raw: null, errors: [`${file}: broken JSON${line ? ` at line ${line}` : ''} (${msg}). Fix the file by hand; Thenwise will not overwrite it.`] };
    }
    if (!plain(parsed))
        return { ...res, raw: null, errors: [`${file}: the top level must be a table, found ${describe(parsed)}`] };
    check(parsed, SCHEMA, '', res.errors, res.warnings);
    if (typeof parsed.version === 'number' && parsed.version > CONFIG_VERSION)
        res.errors.unshift(`${file}: version ${parsed.version} is newer than this Thenwise understands (${CONFIG_VERSION}). Update Thenwise.`);
    res.raw = parsed;
    return res;
}
/** Writes the whole file through a temp file and a rename, so a crash leaves the old file or none. */
export function saveConfig(memDir, raw) {
    mkdirSync(memDir, { recursive: true, mode: 0o700 });
    const file = join(memDir, 'config.json');
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...raw, version: CONFIG_VERSION }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
}
/** The Config with defaults filled in, or the problems found. Safe for hooks and servers: it never exits. */
export function loadConfigSafe(home = homedir()) {
    const memDir = resolveDataDir(home);
    const read = readConfigFile(memDir);
    if (!read.raw || read.errors.length)
        return { config: null, errors: read.errors, warnings: read.warnings };
    const user = read.raw;
    const ing = user.ingest ?? {};
    const claudeDir = join(home, '.claude');
    const expand = (p) => expandHome(p, home);
    const list = (v, dflt) => (Array.isArray(v) ? v : dflt).map(expand);
    const excludeProjects = user.exclude_projects ?? ['-private-tmp*', '*-claude-mem-observer-sessions'];
    // A fresh install ingests the projects found in its own history.
    const found = ing.roots === undefined || ing.repos === undefined ? discoverProjects(claudeDir).filter((p) => p.folder && !excludeProjects.some((g) => globMatch(g, p.key))).map((p) => p.folder) : [];
    const config = {
        home,
        memDir,
        claudeDir,
        excludeProjects,
        off: user.off ?? false,
        offProjects: list(user.off_projects, []),
        roots: list(ing.roots, found),
        repos: list(ing.repos, found.filter((p) => existsSync(join(p, '.git')))),
        rootsAuto: ing.roots === undefined,
        reposAuto: ing.repos === undefined,
        githubRepos: ing.github_repos ?? [],
        vaults: list(ing.vaults, []),
        docs: list(ing.docs, []),
        prs: ing.prs ?? false,
        gitAll: ing.git_all ?? false,
        plans: ing.plans ?? true,
        vault: user.vault ? { place: 'central', layout: 'shared', commit: false, ...user.vault, path: expand(user.vault.path ?? '') } : null,
        backup: { kind: 'none', push: false, ...user.backup, folders: list(user.backup?.folders, []) },
        scope: user.scope ?? 'project',
        includeEntrypoints: ing.include_entrypoints ?? ['cli', 'claude-vscode', 'claude-desktop', 'sdk-cli', 'sdk-ts', ''],
        ingestExcludeProjects: ing.exclude_projects ?? [],
        ingestExcludeMarkers: ing.exclude_markers ?? ['[no-memory]'],
        ghTimeoutMs: (ing.gh_timeout_s ?? 60) * 1000,
        viewProjects: Object.entries((user.views?.projects ?? {})).map(([name, p]) => ({ name, words: (p.words ?? []).map((w) => w.toLowerCase()), paths: list(p.paths, []) })),
    };
    return { config, errors: [], warnings: read.warnings };
}
/** For commands: prints problems and exits 2 instead of throwing. */
export function loadConfig(home = homedir()) {
    const r = loadConfigSafe(home);
    for (const w of r.warnings)
        console.error(`warning: ${w}`);
    if (!r.config) {
        for (const e of r.errors)
            console.error(`error: ${e}`);
        process.exit(2);
    }
    return r.config;
}
/** True when Thenwise is paused everywhere, or for this folder or a folder inside a paused one. */
export function isOff(cfg, projectPath) {
    if (cfg.off)
        return true;
    if (!projectPath)
        return false;
    const p = normPath(projectPath);
    return cfg.offProjects.some((o) => p === normPath(o) || p.startsWith(`${normPath(o)}/`));
}
/** Glob with `*` only, matched against a whole project key. */
export function globMatch(pattern, text) {
    return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(text);
}
