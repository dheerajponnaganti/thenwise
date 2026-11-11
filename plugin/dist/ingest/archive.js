// `memory archive`: copy Claude Code (and Copilot CLI) transcripts to ~/.memory/archive/sessions as gzip, every string masked.
// Sources are only ever read. Incremental by a manifest of source size, mtime and the sha256 of the masked output.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, unlinkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { listDir } from "../core/home.js";
import { errFields, logger } from "../core/log.js";
import { newerThenwise } from "../core/notices.js";
import { alive } from "../core/progress.js";
import { MASK_VERSION, maskDeep, maskSecrets } from "../core/secrets.js";
import { isForgotten, loadTombs } from "../privacy/tombstones.js";
import { globMatch, isOff } from "./config.js";
import { antigravityConverter, antigravitySources } from "./antigravity.js";
import { codexConverter, codexSources } from "./codex.js";
import { copilotConverter, copilotSources } from "./copilot.js";
import { withLock } from "./lock.js";
import { isMarked } from "./parts.js";
import { chatLines, chatText, lastMemberSize, parseSession } from "./transcript.js";
/** Bumped when a converter for another tool learns to read more of its lines, with the tools whose chats it changes (2:
 * Codex token counts; 3: Copilot and Antigravity shell exit codes, #77). Such a chat archived by an older converter is
 * converted again from its source, while the source is still there; Claude Code's own chats are not touched. */
export const CONVERT_VERSION = 3;
const CONVERTED_AGAIN = new Set(['codex', 'copilot', 'antigravity']);
function maskLine(line) {
    try {
        return { text: JSON.stringify(maskDeep(JSON.parse(line))), bad: false };
    }
    catch {
        return { text: maskSecrets(line).text, bad: true };
    }
}
const CHUNK = 1 << 20;
// A line longer than this is left out (counted as unparsed): one string that size can exhaust memory.
const MAX_LINE = 128 << 20;
const MEMBER = 4 << 20; // masked text per gzip member; members concatenate into one valid .gz that gunzipSync reads whole
/** Rewrites a chat an older version zipped whole as members, once, so reading it later takes little memory. The text stays the same. */
function writeMembers(lines, dest, tmp) {
    writeFileSync(tmp, '', { mode: 0o600 });
    let batch = [];
    let len = 0;
    const flush = () => {
        if (batch.length)
            appendFileSync(tmp, gzipSync(batch.join('')), { mode: 0o600 });
        batch = [];
        len = 0;
    };
    for (const line of lines) {
        batch.push(`${line}\n`);
        len += line.length + 1;
        if (len >= MEMBER)
            flush();
    }
    flush();
    renameSync(tmp, dest);
}
/** Facts parseSession needs (cwd, prompts) from one line, without tool output or assistant text. Null when the line carries none. */
function slim(line) {
    try {
        const d = JSON.parse(line);
        if (!d || typeof d !== 'object' || (d.type !== 'user' && d.type !== 'assistant'))
            return null;
        const { type, isSidechain, isMeta, isCompactSummary, uuid, timestamp, cwd, entrypoint } = d;
        const c = d.message?.content;
        const message = type === 'user' ? { content: Array.isArray(c) ? c.filter((b) => b?.type === 'text') : c } : undefined;
        return JSON.stringify({ type, isSidechain, isMeta, isCompactSummary, uuid, timestamp, cwd, entrypoint, message });
    }
    catch {
        return null;
    }
}
/** Same result as maskTranscript(readFileSync(src)), read in chunks: memory stays near the longest line. Writes the gzip to `tmp` when given. */
function streamMask(src, tmp, facts, convert) {
    const sha = createHash('sha256');
    const unparsed = [];
    const slimmed = [];
    let lines = 0;
    let gzBytes = 0;
    let batch = [];
    let batchLen = 0;
    const flush = () => {
        if (!tmp || !batch.length)
            return;
        const gz = gzipSync(batch.join(''));
        appendFileSync(tmp, gz, { mode: 0o600 });
        gzBytes += gz.length;
        batch = [];
        batchLen = 0;
    };
    const emit = (line, n) => {
        if (convert)
            for (const l of convert(line))
                emitOne(l, n);
        else
            emitOne(line, n);
    };
    const emitOne = (line, n) => {
        const m = maskLine(line);
        if (m.bad)
            unparsed.push(n);
        const t = `${m.text}\n`;
        sha.update(t);
        lines++;
        if (facts) {
            const f = slim(line);
            if (f)
                slimmed.push(f);
        }
        if (tmp) {
            batch.push(t);
            batchLen += t.length;
            if (batchLen >= MEMBER)
                flush();
        }
    };
    if (tmp)
        writeFileSync(tmp, '', { mode: 0o600 });
    const fd = openSync(src, 'r');
    let n = 0;
    let carry = [];
    let carryLen = 0;
    let tooLong = false;
    let pending = false;
    try {
        const buf = Buffer.allocUnsafe(CHUNK);
        for (;;) {
            const got = readSync(fd, buf, 0, CHUNK, null);
            if (!got)
                break;
            let from = 0;
            for (let i = buf.indexOf(10, 0); i !== -1 && i < got; i = buf.indexOf(10, from)) {
                if (tooLong)
                    unparsed.push(++n);
                else {
                    carry.push(Buffer.from(buf.subarray(from, i)));
                    emit(Buffer.concat(carry).toString('utf8'), ++n);
                }
                carry = [];
                carryLen = 0;
                tooLong = false;
                from = i + 1;
            }
            if (from < got && !tooLong) {
                carry.push(Buffer.from(buf.subarray(from, got)));
                carryLen += got - from;
                if (carryLen > MAX_LINE)
                    [carry, carryLen, tooLong] = [[], 0, true];
            }
        }
    }
    finally {
        closeSync(fd);
    }
    // A last line with no newline that does not parse is still being written: leave it for the next run.
    if (tooLong)
        unparsed.push(++n);
    else if (carry.length) {
        const last = Buffer.concat(carry).toString('utf8');
        try {
            JSON.parse(last);
            emit(last, ++n);
        }
        catch {
            pending = true;
        }
    }
    flush();
    return { sha: sha.digest('hex'), lines, unparsed, pending, gzBytes, slim: slimmed.join('\n') };
}
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
        const m = maskLine(line);
        if (m.bad)
            unparsed.push(i + 1);
        return m.text;
    });
    return { text: out.length ? `${out.join('\n')}\n` : '', unparsed, pending };
}
const isSessionPath = (p) => p.length === 2 || (p.length === 4 && p[2] === 'subagents');
function collect(dir, into, prefer) {
    const walk = (abs, rel) => {
        for (const e of listDir(abs)) {
            const p = join(abs, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(p, r);
            else if (e.isFile() && e.name.endsWith('.jsonl') && isSessionPath(r.split('/'))) {
                let st;
                try {
                    st = statSync(p);
                }
                catch {
                    continue; // removed since the listing, or in a folder this user can list but not search
                }
                const old = into.get(r);
                // Same session in both places: keep the longer one; on a tie keep the live copy.
                if (!old || st.size > old.size || (st.size === old.size && prefer))
                    into.set(r, { rel: r, path: p, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
            }
        }
    };
    walk(dir, '');
}
/** Plan snapshots are masked too; a newer mask version rewrites them in place (marker file holds the version). A marker
 * from a newer Thenwise is left as it is; true then. Under its own marker, snapshots written after it (an older Thenwise
 * in another tool wrote them) are masked again. */
function remaskPlans(base) {
    const dir = join(base, 'plans');
    const mark = join(dir, '.mask');
    if (!existsSync(dir))
        return false;
    const at = existsSync(mark) ? Number(readFileSync(mark, 'utf8').trim()) || 0 : 0;
    if (at > MASK_VERSION)
        return true;
    const since = at === MASK_VERSION ? statSync(mark).mtimeMs : -1;
    let seen = since < 0;
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.name.endsWith('.md') && (since < 0 || statSync(p).mtimeMs >= since)) {
                seen = true;
                const t = readFileSync(p, 'utf8');
                const m = maskSecrets(t).text;
                if (m !== t)
                    writeFileSync(p, m, { mode: 0o600 });
            }
        }
    };
    walk(dir);
    if (seen)
        writeFileSync(mark, String(MASK_VERSION), { mode: 0o600 });
    return false;
}
/** Masks the archived copy again, for a source that is gone or holds fewer turns than the copy. Read and written a member at a
 * time, so a long chat never becomes one string. An archived copy ends each line, so nothing is pending. */
function remaskKept(dest, tmp) {
    const sha = createHash('sha256');
    const unparsed = [];
    let lines = 0;
    function* masked() {
        for (const line of chatLines(dest)) {
            const m = maskLine(line);
            if (m.bad)
                unparsed.push(lines + 1);
            lines++;
            sha.update(`${m.text}\n`);
            yield m.text;
        }
    }
    writeMembers(masked(), dest, tmp);
    return { sha256: sha.digest('hex'), mask: MASK_VERSION, unparsed, pending: false, lines };
}
/** One archive at a time per store (archive.lock). The hook sync runs archive as its own process, so it holds no archive lock itself. */
export function archive(cfg, opts = {}) {
    if (cfg.off)
        return archiveLocked(cfg, opts);
    const base = join(cfg.memDir, 'archive');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
        return withLock(join(base, 'archive'), () => archiveLocked(cfg, opts), Number(process.env.THENWISE_ARCHIVE_WAIT_MS ?? 5000));
    }
    catch (e) {
        if (String(e?.message).startsWith('another ingest holds'))
            throw new Error('archive already running');
        throw e;
    }
}
function archiveLocked(cfg, opts) {
    const base = join(cfg.memDir, 'archive');
    const out = join(base, 'sessions');
    const manifestFile = join(base, 'manifest.json');
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
    const sources = new Map();
    collect(join(base, 'claude-projects'), sources, false);
    collect(join(cfg.claudeDir, 'projects'), sources, true);
    // A chat file can go between the listing and the stat (Copilot clears a session, Codex moves a rollout): skip it.
    const other = (tool, found, conv) => {
        for (const c of found) {
            const st = statSync(c.path, { throwIfNoEntry: false });
            if (st)
                sources.set(c.rel, { rel: c.rel, path: c.path, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, tool, convert: () => conv(c.id, c.cwd) });
        }
    };
    other('copilot', copilotSources(cfg.home), copilotConverter);
    other('codex', codexSources(cfg.home), codexConverter);
    other('antigravity', antigravitySources(cfg.home), antigravityConverter);
    const res = { seen: 0, archived: 0, remasked: 0, newer: 0, skipped: 0, excluded: 0, failed: [], failures: [], excludedChats: 0, off: 0, leftover: [], pruned: [], unparsed: [], bytes: 0 };
    if (cfg.off)
        return { ...res, off: sources.size };
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const d of [cfg.memDir, base, out])
        chmodSync(d, 0o700);
    // Tmp files of a killed run: the sync stops archive with SIGTERM, so no finally ran. The archive lock keeps other archives of
    // this store out, but an older Thenwise in another tool still takes a lock older than 30 minutes, so a live pid's fresh files
    // stay. An hour untouched means no writer at all: a dead run's pid that another process now has.
    try {
        for (const f of [...readdirSync(out, { recursive: true, encoding: 'utf8' }).map((f) => join(out, f)), ...readdirSync(base).map((f) => join(base, f))]) {
            const pid = Number(/(?:\.gz|manifest\.json)\.(\d+)\.tmp$/.exec(f)?.[1]);
            if (pid && (pid === process.pid || !alive(pid) || Date.now() - (statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 3600e3))
                rmSync(f, { force: true });
        }
    }
    catch (e) {
        logger('archive', cfg.memDir).warn('tmp_cleanup_failed', errFields(e)); // only leftovers: the run goes on
    }
    const check = `${cfg.ingestExcludeMarkers.join('\n')}|2`;
    const parents = new Map(); // a chat's own facts, inherited by its subagent files
    const leftover = (rel) => existsSync(join(out, `${rel}.gz`)) && res.leftover.push(rel);
    const tombs = loadTombs(cfg.memDir);
    const keys = [...sources.keys()].sort();
    const shrankLog = (tool, rel, lines, kept) => logger('archive', cfg.memDir).warn(`${tool ?? 'converted'}_chat_shrank`, { rel, lines, kept });
    const save = () => {
        const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
        const mtmp = `${manifestFile}.${process.pid}.tmp`;
        writeFileSync(mtmp, JSON.stringify(sorted, null, 1), { mode: 0o600 });
        renameSync(mtmp, manifestFile);
        chmodSync(manifestFile, 0o600);
    };
    let done = 0;
    let saved = Date.now();
    for (const rel of keys) {
        // A run killed partway (the sync stops archive at 600 s) keeps what it finished. Between chats every entry's .gz is in place.
        if (done && (done % 200 === 0 || Date.now() - saved > 30e3)) {
            try {
                save();
            }
            catch (e) {
                logger('archive', cfg.memDir).warn('checkpoint_failed', errFields(e)); // the save at the end tries again
            }
            saved = Date.now();
        }
        try {
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
            const tmp = `${dest}.${process.pid}.tmp`;
            let st;
            if (!unchanged) {
                mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
                for (let d = dirname(dest); d !== out; d = dirname(d))
                    chmodSync(d, 0o700);
                st = streamMask(src.path, tmp, parts.length === 2, src.convert?.()); // a long chat is read in chunks, never whole
                // Another tool changed its file format: it has prompts, and nothing came out. Without this the memory just goes quiet.
                if (src.convert && !st.lines && /"user\.message"|"role":\s*"user"|"USER_INPUT"/.test(readFileSync(src.path, 'utf8')))
                    logger('archive', cfg.memDir).warn('chat_not_understood', { rel });
            }
            const raw = unchanged ? (old.checked === check ? null : chatText(readFileSync(dest))) : st.slim;
            let info = parents.get(parts.length === 4 ? `${parts[0]}/${parts[1]}.jsonl` : '') ?? { cwd: old?.cwd ?? '', marked: false };
            if (parts.length === 2 && raw !== null) {
                const s = parseSession(raw, parts[1], cfg.home);
                info = { cwd: s.cwd, marked: isMarked(cfg.ingestExcludeMarkers, s.turns.map((t) => t.prompt)) };
            }
            if (parts.length === 2)
                parents.set(rel, info);
            if (st && (info.marked || isForgotten(tombs, rel, info.cwd) || isOff(cfg, info.cwd)))
                rmSync(tmp, { force: true });
            if (info.marked) {
                res.excludedChats++;
                // A marker added after an earlier sync: drop the archived copy now, so the next ingest drops the chat.
                if (existsSync(dest)) {
                    unlinkSync(dest);
                    delete manifest[rel];
                    res.pruned.push(rel);
                }
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
            // An entry a newer Thenwise wrote is left as it is: masking or converting it here would undo that, and it would redo it (#137).
            if (old && existsSync(dest) && ((old.mask ?? 0) > MASK_VERSION || (old.conv ?? 0) > CONVERT_VERSION)) {
                if (st)
                    rmSync(tmp, { force: true });
                res.newer++;
                res.skipped++;
                res.bytes += statSync(dest).size;
                for (const line of old.unparsed)
                    res.unparsed.push({ rel, line });
                continue;
            }
            if (unchanged) {
                const cur = (manifest[rel] = { ...old, cwd: info.cwd, checked: check });
                const reconvert = !!src.convert && CONVERTED_AGAIN.has(src.tool ?? '') && (old.conv ?? 1) !== CONVERT_VERSION && existsSync(src.path) && statSync(src.path).size === old.size;
                if (old.mask !== MASK_VERSION || reconvert) {
                    // Newer patterns reach old files. Re-read Claude Code's own file when it still exists (words an older mask ate come
                    // back); masking is idempotent, so otherwise re-mask the archived copy.
                    const fromSrc = existsSync(src.path) && statSync(src.path).size === old.size;
                    const m = fromSrc ? streamMask(src.path, tmp, false, src.convert?.()) : undefined;
                    // Converting or masking again only adds lines: a shorter result means the archived copy holds turns the source lost, so it stays.
                    const shrank = !!src.convert && !!m && m.lines < old.lines;
                    if (m && !shrank) {
                        renameSync(tmp, dest);
                        manifest[rel] = { ...cur, ctimeMs: src.ctimeMs, sha256: m.sha, mask: MASK_VERSION, ...(src.convert ? { conv: CONVERT_VERSION } : {}), unparsed: m.unparsed, pending: m.pending, lines: m.lines };
                    }
                    else {
                        rmSync(tmp, { force: true });
                        if (shrank)
                            shrankLog(src.tool, rel, m.lines, old.lines);
                        // A source whose size moved since the check above is read at the next sync, so it is not marked converted.
                        if (old.mask !== MASK_VERSION)
                            manifest[rel] = { ...cur, ctimeMs: src.ctimeMs, ...remaskKept(dest, tmp), ...(shrank && reconvert ? { conv: CONVERT_VERSION } : {}) };
                        else if (shrank)
                            manifest[rel] = { ...cur, conv: CONVERT_VERSION };
                    }
                    res.remasked++;
                }
                if (lastMemberSize(dest) > 2 * MEMBER)
                    writeMembers(chatLines(dest), dest, tmp);
                manifest[rel] = { ...manifest[rel], ctimeMs: src.ctimeMs };
                res.skipped++;
                res.bytes += statSync(dest).size;
                for (const line of manifest[rel].unparsed)
                    res.unparsed.push({ rel, line });
                continue;
            }
            const masked = st;
            // Touched or restored with the same bytes: note the new times, keep the archived copy as it is.
            if (old && old.sha256 === masked.sha && old.mask === MASK_VERSION && existsSync(dest)) {
                rmSync(tmp, { force: true });
                manifest[rel] = { ...old, source: src.path, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs, cwd: info.cwd, checked: check, pending: masked.pending };
                for (const line of old.unparsed)
                    res.unparsed.push({ rel, line });
                res.skipped++;
                res.bytes += statSync(dest).size;
                continue;
            }
            // Copilot can replace its chat file. A /rewind withdraws turns on purpose; losing turns any other way must not lose them here too.
            // shortcut: the archived copy is kept only until the file outgrows it, merge by event id if this log line ever shows up.
            if (src.convert && old && masked.lines < old.lines && existsSync(dest) && !(src.tool === 'copilot' && /"infoType":\s*"rewind"/.test(readFileSync(src.path, 'utf8')))) {
                rmSync(tmp, { force: true });
                shrankLog(src.tool, rel, masked.lines, old.lines);
                const remask = old.mask !== MASK_VERSION;
                manifest[rel] = { ...old, source: src.path, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs, cwd: info.cwd, checked: check, ...(remask ? remaskKept(dest, tmp) : {}), pending: masked.pending };
                if (remask)
                    res.remasked++;
                for (const line of manifest[rel].unparsed)
                    res.unparsed.push({ rel, line });
                res.skipped++;
                res.bytes += statSync(dest).size;
                continue;
            }
            renameSync(tmp, dest);
            chmodSync(dest, 0o600);
            manifest[rel] = { source: src.path, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs, sha256: masked.sha, mask: MASK_VERSION, ...(src.convert ? { conv: CONVERT_VERSION } : {}), cwd: info.cwd, checked: check, lines: masked.lines, unparsed: masked.unparsed, pending: masked.pending };
            for (const line of masked.unparsed)
                res.unparsed.push({ rel, line });
            res.archived++;
            res.bytes += masked.gzBytes;
        }
        catch (e) {
            // One bad file must not stop the run; the reason and size tell which file and why.
            const reason = e?.code ?? String(e?.message ?? e).split('\n')[0];
            const size = sources.get(rel)?.size ?? 0;
            res.failed.push(rel);
            res.failures.push({ rel, reason, size });
            logger('archive', cfg.memDir).error('file_failed', { rel, reason, bytes: size, ...errFields(e) });
            rmSync(`${join(out, rel)}.gz.${process.pid}.tmp`, { force: true });
        }
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
    if (remaskPlans(base))
        res.newer++;
    if (res.newer)
        newerThenwise(cfg.memDir, 'the archived chats and plans');
    save();
    return res;
}
