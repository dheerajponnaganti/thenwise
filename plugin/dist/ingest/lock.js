// One holder at a time per lock file. A lock holds its pid, and is stale when that process is dead, the machine restarted since the
// lock was written, or the process with that pid started after the lock was written (the pid was reused). Its age alone never makes
// it stale: an ingest can run for long, and a laptop can sleep.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { alive } from "../core/progress.js";
const POLL_MS = 50;
// shortcut: the boot time is the wall clock minus uptime, so a clock step over a minute (NTP, a VM resume) can make a live lock look
// older than this boot; compare the holder's start time instead of the boot time if double runs show up after such steps.
const BOOT_SLACK_MS = 60_000; // two reads of the boot time differ by clock steps and rounding
const TAKEOVER_MS = 10_000; // a takeover lasts microseconds; one this old was left by a crash
// Locks this process took. A lock that names this process but is not in here was left by a dead process with the same pid.
const taken = new Set();
const starts = new Map();
/** When the process with this pid started, or undefined when the OS cannot say (no `ps`, as in some containers). Asked once per
 * lock seen, since a waiting taker reads the same lock many times. */
function startedAt(pid, key) {
    if (starts.has(key))
        return starts.get(key);
    let at;
    try {
        const r = process.platform === 'win32'
            ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
            : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
        const t = Date.parse((r.stdout ?? '').trim()); // ps prints local time in whole seconds, which Date.parse reads as local
        at = Number.isFinite(t) ? t : undefined;
    }
    catch { } // no way to ask: trust the pid
    starts.set(key, at);
    return at;
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (f) => ({ text: readFileSync(f, 'utf8'), mtimeMs: statSync(f).mtimeMs });
/** An empty lock is a holder that has not written its pid yet. A lock written before this boot is stale even if its pid lives again.
 * With `deep`, a live pid whose process started after the lock was written is a reused pid, so the lock is stale too. */
function holds({ text, mtimeMs }, deep) {
    const pid = Number(text.trim());
    if (!pid)
        return Date.now() - mtimeMs < 10_000;
    if (!alive(pid) || mtimeMs <= Date.now() - uptime() * 1000 - BOOT_SLACK_MS)
        return false;
    const start = deep ? startedAt(pid, `${pid}:${mtimeMs}`) : undefined;
    return start === undefined || start <= mtimeMs + 1000; // start times are whole seconds
}
/** True while a live process holds the lock. Asking the OS when that process started costs a process spawn, so a lock younger than
 * `deepAfterMs` is trusted on its pid alone; a pid is reused only long after its process died. */
export function lockHeld(file, deepAfterMs = 30 * 60000) {
    try {
        const seen = read(file);
        return holds(seen, Date.now() - seen.mtimeMs > deepAfterMs);
    }
    catch {
        return false; // no lock, or released between the two reads
    }
}
/** True when this process now holds the lock. A stale lock is removed by one taker at a time, the one holding `<lock>.takeover`. */
export function takeLock(file, pid = process.pid) {
    for (let i = 0; i < 2; i++) {
        try {
            writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
            taken.add(`${pid}:${file}`);
            return true;
        }
        catch (e) {
            // Windows reports a file that is being deleted as EPERM.
            const code = e.code;
            if (code !== 'EEXIST' && !(code === 'EPERM' && process.platform === 'win32'))
                throw e;
        }
        let seen;
        try {
            seen = read(file);
            // A lock naming this very process that it did not take was left by a dead process with our pid, as in a container that
            // restarts with the same pids. One it took is still held: a second take waits like any other.
            const ours = Number(seen.text.trim()) === pid;
            if (ours ? taken.has(`${pid}:${file}`) : holds(seen, true))
                return false;
        }
        catch {
            continue; // released between our create and our read: try again
        }
        if (!removeStale(file, pid, (now) => now.text === seen.text && now.mtimeMs === seen.mtimeMs))
            return false;
    }
    return false;
}
/** Removes the lock if `still` holds, as the one taker holding `<lock>.takeover`. False when another taker holds it. */
function removeStale(file, pid, still) {
    const takeover = `${file}.takeover`;
    try {
        writeFileSync(takeover, String(pid), { flag: 'wx', mode: 0o600 });
    }
    catch {
        if (Date.now() - (statSync(takeover, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > TAKEOVER_MS)
            rmSync(takeover, { force: true });
        return false;
    }
    try {
        // Only a takeover holder removes a lock it did not write, so the file changed only if its holder released it.
        if (still(read(file)))
            rmSync(file, { force: true });
    }
    catch { } // released meanwhile
    rmSync(takeover, { force: true });
    return true;
}
/** After a killed child: no `finally` ran, so its lock stays. Removes the lock only while it still names that pid. */
export function dropLock(file, pid) {
    if (pid)
        removeStale(file, process.pid, (now) => Number(now.text.trim()) === pid);
}
/** Runs `run` under `<path>.lock`, waiting up to waitMs for another holder. */
export function withLock(path, run, waitMs = 10 * 60000) {
    const lock = `${path}.lock`;
    const until = Date.now() + waitMs;
    while (!takeLock(lock)) {
        if (Date.now() > until)
            throw new Error(`another ingest holds ${lock}`);
        sleep(POLL_MS);
    }
    try {
        return run();
    }
    finally {
        rmSync(lock, { force: true });
    }
}
