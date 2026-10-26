// The Thenwise log: one JSON event per line in <data folder>/logs/thenwise.log, rotated at 1 MB with 3 old files kept.
// The level comes from THENWISE_LOG, else `log.level` in config.json, else info.
// Callers pass event names, counts, ids and errors, never chat text, note text or queries. Writing never throws.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from "./home.js";
import { maskSecrets } from "./secrets.js";
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export const MAX_BYTES = 1_000_000;
export const KEEP = 3;
export const logFile = (dir = resolveDataDir()) => join(dir, 'logs', 'thenwise.log');
const old = (file, i) => file.replace(/\.log$/, `.${i}.log`);
/** Masks secrets and shows the home folder as `~`. */
export const clean = (s) => maskSecrets(s).text.split(homedir()).join('~');
/** Cuts `values` (a query, a file name the user typed) and their longer words out of `text`, so an error that echoes them keeps none of it. */
export function redact(text, values) {
    const cuts = values.flatMap((v) => [v, ...v.split(/\W+/).filter((w) => w.length >= 4)]).filter(Boolean).sort((a, b) => b.length - a.length);
    return cuts.reduce((s, c) => s.split(c).join('…'), text);
}
/** A query as its word count and a short hash: two reports of the same failing query match without anyone reading it. */
export const queryFields = (q) => ({ qwords: q.split(/\s+/).filter(Boolean).length, qhash: createHash('sha1').update(q).digest('hex').slice(0, 8) });
/** A short, stable code for one kind of failure (`E4F2`), shown to the user and kept in the log line. */
export const errorCode = (where, message) => `E${createHash('sha1').update(`${where}:${message}`).digest('hex').slice(0, 3).toUpperCase()}`;
const configured = new Map();
/** `log.level` from the folder's config.json, read once per process. */
function configLevel(dir) {
    if (!configured.has(dir)) {
        let v = '';
        try {
            v = String(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).log?.level ?? '');
        }
        catch { } // no config or no log section: the default level
        configured.set(dir, v);
    }
    return configured.get(dir);
}
const threshold = (dir) => {
    const v = (process.env.THENWISE_LOG || configLevel(dir)).toLowerCase();
    return v === 'off' ? -1 : (LEVELS[v] ?? LEVELS.info);
};
function write(file, e) {
    try {
        if (!existsSync(file))
            mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
        else if (statSync(file).size >= MAX_BYTES) {
            for (let i = KEEP - 1; i >= 1; i--)
                if (existsSync(old(file, i)))
                    renameSync(old(file, i), old(file, i + 1));
            renameSync(file, old(file, 1));
        }
        // One write per line: O_APPEND keeps lines from two processes whole.
        appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    }
    catch { } // a log that cannot be written goes quiet; the command carries on
}
export function logger(component, dir) {
    const emit = (lvl) => (ev, fields = {}) => {
        const home = dir ?? resolveDataDir();
        if (LEVELS[lvl] > threshold(home))
            return;
        const f = {};
        for (const [k, v] of Object.entries(fields))
            if (v !== undefined)
                f[k] = typeof v === 'string' ? clean(v) : v;
        write(logFile(home), { t: new Date().toISOString(), lvl, c: component, ev, ...f, pid: process.pid });
    };
    const info = emit('info');
    return {
        error: emit('error'),
        warn: emit('warn'),
        info,
        debug: emit('debug'),
        /** Starts a clock; the returned function logs the event with its duration in `ms`. */
        time: (ev, fields = {}) => {
            const t = Date.now();
            return (more = {}) => info(ev, { ...fields, ...more, ms: Date.now() - t });
        },
    };
}
/** An error's message and the top of its stack, for a log line. */
export function errFields(e) {
    if (!(e instanceof Error))
        return { err: String(e) };
    return { err: e.message.split('\n')[0], stack: e.stack?.split('\n').slice(1, 4).map((l) => l.trim()).join(' | ') };
}
/** Every event still on disk, oldest first. Lines that do not parse are skipped. */
export function readLog(dir) {
    const file = logFile(dir);
    const out = [];
    for (const f of [...Array.from({ length: KEEP }, (_, i) => old(file, KEEP - i)), file]) {
        if (!existsSync(f))
            continue;
        for (const l of readFileSync(f, 'utf8').split('\n')) {
            try {
                if (l)
                    out.push(JSON.parse(l));
            }
            catch { }
        }
    }
    return out;
}
/** `1h`, `30m`, `2d` or an ISO date, as a cutoff time in ms. */
export function since(s, now = Date.now()) {
    const m = /^(\d+)\s*([mhd])$/.exec(s.trim());
    if (m)
        return now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    const t = Date.parse(s);
    if (Number.isNaN(t))
        throw new Error(`--since takes 30m, 1h, 2d or a date, not ${s}`);
    return t;
}
/** One readable line: time, level, component, event, then the fields. */
export function formatEvent(e) {
    const { t, lvl, c, ev, pid: _, ...rest } = e;
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ');
    return `${t.slice(0, 19).replace('T', ' ')} ${lvl === 'info' ? '' : `${lvl.toUpperCase()} `}${c} ${ev}${extra ? ` ${extra}` : ''}`;
}
/** Errors in the last 24 hours and the newest one, for doctor and status. */
export function recentErrors(dir, now = Date.now()) {
    const errs = readLog(dir).filter((e) => e.lvl === 'error' && Date.parse(e.t) >= now - 86_400_000);
    if (!errs.length)
        return 'no errors in the last 24 hours';
    return `${errs.length} error${errs.length === 1 ? '' : 's'} in the last 24 hours, newest: ${formatEvent(errs.at(-1))}. Run \`thenwise logs --errors\` for all of them.`;
}
/** `thenwise logs [--errors] [--since 1h] [--component mcp] [--json] [--lines N]`. */
export function logsCommand(argv, dir) {
    const flag = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
    let cut;
    try {
        cut = flag('since') ? since(flag('since')) : undefined;
    }
    catch (e) {
        console.error(e.message);
        return 1;
    }
    const comp = flag('component');
    const evs = readLog(dir)
        .filter((e) => !argv.includes('--errors') || e.lvl === 'error' || e.lvl === 'warn')
        .filter((e) => !comp || e.c === comp)
        .filter((e) => cut === undefined || Date.parse(e.t) >= cut)
        .slice(-Number(flag('lines') ?? 50));
    if (!evs.length)
        console.log(`no log lines${existsSync(logFile(dir)) ? ' match' : ` yet in ${clean(logFile(dir))}`}`);
    for (const e of evs)
        console.log(argv.includes('--json') ? JSON.stringify(e) : formatEvent(e));
    return 0;
}
