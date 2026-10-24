// `memory archive`: copy Claude Code transcripts to ~/.memory/archive/sessions as gzip, every string masked.
// Sources are only ever read. Incremental by a manifest of source size, mtime and the sha256 of the masked output.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MASK_VERSION, maskSecrets } from "../core/secrets.js";
import { isForgotten, loadTombs } from "../privacy/tombstones.js";
import { globMatch, isOff } from "./config.js";
import { parseSession } from "./transcript.js";
const maskDeep = (v) => {
    if (typeof v === 'string')
        return maskSecrets(v).text;
    if (Array.isArray(v))
        return v.map(maskDeep);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
    return v;
};
export function maskTranscript(text) {
    const unparsed = [];
    const lines = text.split('\n');
    // A last line with no newline that does not parse is still being written: leave it for the next run.
    let pending = false;
    if (lines.at(-1) !== '') {
        try {
            JSON.parse(lines.at(-1));
        }
        catch {
            pending = true;
            lines.pop();
        }
    }
    else
        lines.pop();
    const out = lines.map((line, i) => {
        try {
            return JSON.stringify(maskDeep(JSON.parse(line)));
        }
        catch {
            unparsed.push(i + 1);
            return maskSecrets(line).text;
        }
    });
    return { text: out.length ? `${out.join('\n')}\n` : '', unparsed, pending };
}
const isSessionPath = (p) => p.length === 2 || (p.length === 4 && p[2] === 'subagents');
function collect(dir, into, prefer) {
    if (!existsSync(dir))
        return;
    const walk = (abs, rel) => {
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            const p = join(abs, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(p, r);
            else if (e.isFile() && e.name.endsWith('.jsonl') && isSessionPath(r.split('/'))) {
                const st = statSync(p);
                const old = into.get(r);
                // Same session in both places: keep the longer one; on a tie keep the live copy.
                if (!old || st.size > old.size || (st.size === old.size && prefer))
                    into.set(r, { rel: r, path: p, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
            }
        }
    };
    walk(dir, '');
}
export function archive(cfg, opts = {}) {
    const base = join(cfg.memDir, 'archive');
    const out = join(base, 'sessions');
    const manifestFile = join(base, 'manifest.json');
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
    const sources = new Map();
    collect(join(base, 'claude-projects'), sources, false);
    collect(join(cfg.claudeDir, 'projects'), sources, true);
    const res = { seen: 0, archived: 0, remasked: 0, skipped: 0, excluded: 0, excludedChats: 0, off: 0, leftover: [], pruned: [], unparsed: [], bytes: 0 };
    if (cfg.off)
        return { ...res, off: sources.size };
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const d of [cfg.memDir, base, out])
        chmodSync(d, 0o700);
    const check = `${cfg.ingestExcludeMarkers.join('\n')}|1`;
    const parents = new Map(); // a chat's own facts, inherited by its subagent files
    const leftover = (rel) => existsSync(join(out, `${rel}.gz`)) && res.leftover.push(rel);
    const tombs = loadTombs(cfg.memDir);
    const keys = [...sources.keys()].sort();
    let done = 0;
    for (const rel of keys) {
        opts.onProgress?.(++done, keys.length);
        const src = sources.get(rel);
        const parts = rel.split('/');
        if (cfg.excludeProjects.some((g) => globMatch(g, parts[0])) || isForgotten(tombs, rel)) {
            res.excluded++;
            leftover(rel);
            continue;
        }
        const old = manifest[rel];
        const dest = join(out, `${rel}.gz`);
        const unchanged = old && old.size === src.size && old.mtimeMs === src.mtimeMs && (old.ctimeMs === undefined || old.ctimeMs === src.ctimeMs) && old.source === src.path && existsSync(dest);
        // Facts about the chat come from the source, or from the archived copy when the entry predates them.
        const raw = unchanged ? (old.checked === check ? null : gunzipSync(readFileSync(dest)).toString('utf8')) : readFileSync(src.path, 'utf8');
        let info = parents.get(parts.length === 4 ? `${parts[0]}/${parts[1]}.jsonl` : '') ?? { cwd: old?.cwd ?? '', marked: false };
        if (parts.length === 2 && raw !== null) {
            const s = parseSession(raw, parts[1], cfg.home);
            info = { cwd: s.cwd, marked: s.turns.some((t) => cfg.ingestExcludeMarkers.some((m) => t.prompt.includes(m))) };
        }
        if (parts.length === 2)
            parents.set(rel, info);
        if (info.marked) {
            res.excludedChats++;
            leftover(rel);
            continue;
        }
        if (isForgotten(tombs, rel, info.cwd)) {
            res.excluded++;
            continue;
        }
        if (isOff(cfg, info.cwd)) {
            res.off++;
            continue;
        }
        res.seen++;
        if (unchanged) {
            const cur = (manifest[rel] = { ...old, cwd: info.cwd, checked: check });
            if (old.mask !== MASK_VERSION) {
                // Newer patterns reach old files: masking is idempotent, so re-mask the archived copy (the source may be gone).
                const text = maskTranscript(gunzipSync(readFileSync(dest)).toString('utf8')).text;
                writeFileSync(`${dest}.tmp`, gzipSync(text), { mode: 0o600 });
                renameSync(`${dest}.tmp`, dest);
                manifest[rel] = { ...cur, ctimeMs: src.ctimeMs, sha256: createHash('sha256').update(text).digest('hex'), mask: MASK_VERSION };
                res.remasked++;
            }
            manifest[rel] = { ...manifest[rel], ctimeMs: src.ctimeMs };
            res.skipped++;
            res.bytes += statSync(dest).size;
            for (const line of old.unparsed)
                res.unparsed.push({ rel, line });
            continue;
        }
        const masked = maskTranscript(raw);
        const sha = createHash('sha256').update(masked.text).digest('hex');
        // Touched or restored with the same bytes: note the new times, keep the archived copy as it is.
        if (old && old.sha256 === sha && old.mask === MASK_VERSION && existsSync(dest)) {
            manifest[rel] = { ...old, source: src.path, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs, cwd: info.cwd, checked: check, pending: masked.pending };
            for (const line of old.unparsed)
                res.unparsed.push({ rel, line });
            res.skipped++;
            res.bytes += statSync(dest).size;
            continue;
        }
        const gz = gzipSync(masked.text);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        for (let d = dirname(dest); d !== out; d = dirname(d))
            chmodSync(d, 0o700);
        writeFileSync(`${dest}.tmp`, gz, { mode: 0o600 });
        renameSync(`${dest}.tmp`, dest);
        chmodSync(dest, 0o600);
        manifest[rel] = { source: src.path, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs, sha256: sha, mask: MASK_VERSION, cwd: info.cwd, checked: check, lines: masked.text.split('\n').length - 1, unparsed: masked.unparsed, pending: masked.pending };
        for (const line of masked.unparsed)
            res.unparsed.push({ rel, line });
        res.archived++;
        res.bytes += gz.length;
    }
    // Archived chats whose source is gone but whose project is now excluded.
    for (const rel of Object.keys(manifest))
        if (!sources.has(rel) && cfg.excludeProjects.some((g) => globMatch(g, rel.split('/')[0])))
            leftover(rel);
    if (opts.prune) {
        for (const rel of res.leftover.splice(0)) {
            unlinkSync(join(out, `${rel}.gz`));
            delete manifest[rel];
            res.pruned.push(rel);
        }
    }
    const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(`${manifestFile}.tmp`, JSON.stringify(sorted, null, 1), { mode: 0o600 });
    renameSync(`${manifestFile}.tmp`, manifestFile);
    chmodSync(manifestFile, 0o600);
    return res;
}
