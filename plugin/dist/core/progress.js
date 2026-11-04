// What the background sync is doing, for the person: first sync, a rebuild or an automatic one, which phase, and how far it
// got. The sync writes <data folder>/sync-progress.json as it goes; status, the hooks and the memory tools read it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const progressFile = (dir) => join(dir, 'sync-progress.json');
export function readProgress(dir) {
    try {
        return JSON.parse(readFileSync(progressFile(dir), 'utf8'));
    }
    catch {
        return null;
    }
}
/** Merges fields into the file, through a temp file and a rename, so a reader never sees half of it. */
export function writeProgress(dir, p, replace = false) {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const next = { ...(replace ? {} : readProgress(dir)), ...p, updated: new Date().toISOString() };
        const tmp = `${progressFile(dir)}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        renameSync(tmp, progressFile(dir));
    }
    catch { } // progress is a courtesy: it never fails a sync
}
/** A callback for a phase's loop that writes at most every half second, and always the last step. Null when no sync asked. */
export function reporter(dir, phase) {
    if (!process.env.THENWISE_PROGRESS)
        return null;
    let last = 0;
    return (done, total) => {
        const now = Date.now();
        if (done < total && now - last < 500)
            return;
        last = now;
        writeProgress(dir, { phase, done, total });
    };
}
// Copying chats is the first half of a sync, building the store the second.
const WEIGHT = { 'copying chats': [0, 50], 'building the store': [50, 50] };
/** The whole sync's share done, 0 to 100. */
export function percent(p) {
    if (p.finished)
        return 100;
    const [from, span] = WEIGHT[p.phase] ?? [p.phase === 'team sync' ? 50 : 0, 0];
    return Math.min(99, Math.floor(from + (p.total ? (span * p.done) / p.total : 0)));
}
/** Whether a process lives. EPERM means it does, under another user. */
export const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
};
/** True while a sync is running: started, not finished, and its process still alive. */
export const running = (p) => !!p && !p.finished && alive(p.pid);
const n = (x) => x.toLocaleString('en-US');
const secs = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const NAME = { first: 'first sync', rebuild: 'rebuild after an update', auto: 'sync' };
/** One line for the person, or '' when there is nothing worth saying. */
export function progressLine(p, now = Date.now()) {
    if (!p)
        return '';
    if (p.finished)
        return `${NAME[p.kind]} done${p.chats ? `: ${n(p.chats)} chats remembered` : ''}${p.ms ? ` in ${secs(p.ms)}` : ''}`;
    if (!running(p))
        return '';
    const what = p.total ? `${p.phase}, ${n(p.done)} of ${n(p.total)} chats` : p.phase;
    return `${NAME[p.kind]} ${percent(p)}% (${what}), started ${secs(now - Date.parse(p.started))} ago`;
}
/** For answers given while the first sync or a rebuild runs: the memory is incomplete, and the agent should say so. */
export function incompleteNote(dir) {
    const p = readProgress(dir);
    if (!running(p) || p.kind === 'auto')
        return '';
    return `Note: Thenwise's ${NAME[p.kind]} is ${percent(p)}% done, so older chats may be missing from these results. Say so rather than claiming something was never recorded.`;
}
export const hasStore = (dir) => existsSync(join(dir, 'graph.db'));
