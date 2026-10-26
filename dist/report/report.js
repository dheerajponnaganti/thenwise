// `thenwise report`: an issue report built from versions, doctor, store counts, settings and recent log errors.
// Never chat text, note text, queries, tokens or file contents. Shown in full before anything leaves; sent only on an explicit yes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, release } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
import { resolveDataDir } from "../core/home.js";
import { clean, formatEvent, logger, readLog } from "../core/log.js";
import { maskSecrets } from "../core/secrets.js";
import { loadConfigSafe } from "../ingest/config.js";
import { runDoctor } from "../setup/doctor.js";
export const URL_MAX = 7500;
const LOG_LINES = 20;
const manifest = () => {
    try {
        return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    }
    catch {
        return {};
    }
};
const thenwiseVersion = () => manifest().version ?? 'unknown';
/** `owner/name` of the GitHub repo issues go to, from package.json, so it lives in one place. */
export const issueRepo = () => /github\.com[/:]([^/]+\/[^/.]+)/.exec(manifest().repository?.url ?? '')?.[1] ?? '';
function claudeVersion() {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] : 'not found';
}
/**
 * Hides what a log line may say about the user's machine: project names become `project-N`,
 * and every path becomes `<path>` except Thenwise's own source files, which a stack trace needs.
 */
export function anonymize(text, names) {
    let out = text.replace(/file:\/\//g, '').replace(/(?:~|\b[A-Za-z]:)?[\\/][^\s"'|()]+/g, (p) => /(?:^|[\\/])(?:src|dist)[\\/][\w./\\-]+\.(?:ts|js)(?::\d+)*/.exec(p)?.[0].replace(/^[\\/]/, '') ?? '<path>');
    [...new Set(names)].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length).forEach((n, i) => (out = out.split(n).join(`project-${i + 1}`)));
    return out;
}
/** Builds the report. Every section is masked and anonymized here; `toMarkdown` masks the whole text once more. */
export async function buildReport(opts = {}) {
    const dir = opts.dir ?? resolveDataDir();
    const cfg = loadConfigSafe(opts.home).config;
    const names = cfg ? [...cfg.roots, ...cfg.githubRepos, ...cfg.vaults].flatMap((p) => p.split(/[\\/]/).filter(Boolean).slice(-2)).filter((n) => n !== basename(homedir()) && !/^(Users|home|Documents|\.claude|projects)$/.test(n)) : [];
    const tidy = (s) => anonymize(clean(s), names);
    const checks = await runDoctor(opts.home);
    const db = join(dir, 'graph.db');
    let store = 'no store yet';
    if (existsSync(db)) {
        try {
            const d = new DatabaseSync(db, { readOnly: true });
            const kinds = d.prepare('SELECT kind, count(*) n FROM nodes GROUP BY kind ORDER BY kind').all().map((r) => `${r.kind} ${r.n}`).join(', ');
            d.close();
            store = `${kinds}; ${(statSync(db).size / 1e6).toFixed(1)} MB; last sync ${statSync(db).mtime.toISOString()}`;
        }
        catch (e) {
            store = `the store could not be read: ${e.message}`;
        }
    }
    const settings = cfg
        ? [`scope ${cfg.scope}`, `prs ${cfg.prs ? 'on' : 'off'}`, `vault ${cfg.vault ? cfg.vault.place : 'none'}`, `backup ${cfg.backup?.kind ?? 'none'}`, `teams ${existsSync(join(dir, 'team.json')) ? 'joined' : 'no'}`, `projects ${cfg.roots.length}`, `memory ${cfg.off ? 'off' : 'on'}`].join(', ')
        : 'no config.json, or it has errors';
    const logs = readLog(dir).filter((e) => e.lvl === 'error' || e.lvl === 'warn').slice(-LOG_LINES).map((e) => tidy(formatEvent(e)));
    const code = opts.code ?? '';
    return {
        title: tidy(opts.title || (code ? `Error ${code}` : 'Issue report')),
        kind: opts.kind ?? 'bug',
        what: tidy(opts.what ?? ''),
        code,
        versions: `Thenwise ${thenwiseVersion()}, Claude Code ${claudeVersion()}, Node ${process.version}, ${platform()} ${release()} ${arch()}`,
        doctor: checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`).join('\n'),
        store: tidy(store),
        settings,
        logs,
    };
}
const block = (s) => `\`\`\`\n${s}\n\`\`\``;
/** The issue body, with a second masking pass over all of it. */
export function toMarkdown(r) {
    const md = [
        `### What happened\n\n${r.what || '_(not filled in)_'}`,
        ...(r.code ? [`### Error code\n\n${r.code}`] : []),
        `### Versions\n\n${r.versions}`,
        `### Doctor\n\n${block(r.doctor)}`,
        `### Store\n\n${r.store}`,
        `### Settings\n\n${r.settings}`,
        `### Recent errors and warnings\n\n${r.logs.length ? block(r.logs.join('\n')) : 'none'}`,
        '_Sent with `thenwise report`. It holds no chat text, notes, queries or file contents._',
    ].join('\n\n');
    return maskSecrets(md).text;
}
/** The pre-filled GitHub issue form. Oldest log lines go first when the link would be too long. */
export function formUrl(r) {
    const make = (logs) => {
        const q = new URLSearchParams({ template: r.kind === 'idea' ? 'idea.yml' : 'bug.yml', title: r.title, labels: r.kind === 'idea' ? 'idea,from-report' : 'bug,from-report', what: r.what, code: r.code, versions: r.versions, doctor: r.doctor, store: `${r.store}\n${r.settings}`, logs: logs.join('\n') });
        return `https://github.com/${issueRepo()}/issues/new?${q.toString().replace(/\+/g, '%20')}`;
    };
    let logs = r.logs;
    while (logs.length && make(logs).length > URL_MAX)
        logs = logs.slice(1);
    return { url: make(logs), trimmed: r.logs.length - logs.length };
}
/** Saves the report as Markdown in <data folder>/reports and returns the path. */
export function saveReport(md, dir = resolveDataDir(), now = new Date()) {
    const folder = join(dir, 'reports');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `report-${now.toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(file, md, { mode: 0o600 });
    return file;
}
const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
/** Puts the text on the clipboard with the platform's own tool. */
export function copy(text) {
    const tools = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    return tools.some(([c, a]) => run(c, a, text).status === 0);
}
function openBrowser(url) {
    // rundll32 takes the link as it is; `start` through cmd would split it at every &.
    const [c, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    return run(c, a).status === 0;
}
/** Creates the issue with `gh`; labels that do not exist on the repo are dropped and it tries again. */
function ghCreate(r, bodyFile) {
    if (run('gh', ['auth', 'status']).status !== 0)
        return { ok: false, out: 'gh is not installed or not signed in' };
    const base = ['issue', 'create', '--repo', issueRepo(), '--title', r.title, '--body-file', bodyFile];
    let res = run('gh', [...base, '--label', r.kind, '--label', 'from-report']);
    if (res.status !== 0 && /label/i.test(res.stderr))
        res = run('gh', base);
    return { ok: res.status === 0, out: (res.status === 0 ? res.stdout : res.stderr).trim() };
}
const flagOf = (argv, n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
/**
 * `thenwise report [--what <text>] [--title <text>] [--code E4F2] [--idea] [--send | --open | --copy] [--yes]`.
 * With no action it shows the report and saves it. --send uses gh, else the browser form; --open is the form; --copy the clipboard.
 */
export async function reportCommand(argv, dir = resolveDataDir()) {
    const r = await buildReport({ what: flagOf(argv, 'what'), title: flagOf(argv, 'title'), code: flagOf(argv, 'code'), kind: argv.includes('--idea') ? 'idea' : 'bug', dir });
    const md = toMarkdown(r);
    const file = saveReport(md, dir);
    const action = ['send', 'open', 'copy'].find((a) => argv.includes(`--${a}`));
    console.log(`${r.title}\n\n${md}\n\nSaved to ${file}`);
    if (!action) {
        console.log('Nothing was sent. Run again with --send (gh, or the browser form), --open (the browser form) or --copy (the clipboard).');
        return 0;
    }
    if (!argv.includes('--yes')) {
        if (!process.stdin.isTTY) {
            console.log('Not sent: add --yes once the report above has been read and approved.');
            return 1;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const yes = /^y(es)?$/i.test((await rl.question(`Send this report (${action})? [y/N] `)).trim());
        rl.close();
        if (!yes)
            return (console.log(`Not sent. The report stays in ${file}.`), 0);
    }
    const log = logger('report', dir);
    if (action === 'copy') {
        const ok = copy(md);
        log.info('copied', { ok });
        console.log(ok ? `Copied. Paste it into a new issue at https://github.com/${issueRepo()}/issues/new` : `No clipboard tool found. The report is in ${file}.`);
        return ok ? 0 : 1;
    }
    if (action === 'send') {
        const gh = ghCreate(r, file);
        log.info('gh', { ok: gh.ok });
        if (gh.ok)
            return (console.log(`Issue created: ${gh.out}`), 0);
        console.log(`gh could not create the issue (${clean(gh.out.split('\n')[0] ?? '')}); opening the form instead.`);
    }
    const { url, trimmed } = formUrl(r);
    const opened = openBrowser(url);
    log.info('form', { ok: opened, trimmed });
    if (trimmed)
        console.log(`The form link holds ${r.logs.length - trimmed} of ${r.logs.length} log lines; attach ${file} for the rest.`);
    console.log(opened ? 'The issue form is open in your browser. Check it and press Submit.' : `Could not open a browser. Open this link, or attach ${file} to a new issue:\n${url}`);
    return 0;
}
