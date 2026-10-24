// Finds the projects in Claude Code's history. A folder name under ~/.claude/projects is a lossy mangling of the
// real path (dots, underscores, spaces and slashes all become "-"), so the real folder comes from the `cwd` field.
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
function headCwd(file) {
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(32768);
        const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
        for (const line of text.split('\n')) {
            const m = /"cwd":\s*("(?:[^"\\]|\\.)*")/.exec(line);
            if (m)
                return JSON.parse(m[1]);
        }
    }
    catch {
        // unreadable: the next file may name a folder
    }
    finally {
        closeSync(fd);
    }
    return null;
}
/** Reads the head of up to `sample` chats per project; counts every top-level chat. */
export function discoverProjects(claudeDir, sample = 20) {
    const root = join(claudeDir, 'projects');
    if (!existsSync(root))
        return [];
    const out = [];
    for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!e.isDirectory())
            continue;
        const files = readdirSync(join(root, e.name)).filter((f) => f.endsWith('.jsonl')).sort();
        if (!files.length)
            continue;
        const seen = new Map();
        for (const f of files.slice(0, sample)) {
            const cwd = headCwd(join(root, e.name, f));
            // The disk root is no project: as a root it would put every chat in scope.
            if (cwd && !/^([a-zA-Z]:)?[\\/]?$/.test(cwd))
                seen.set(cwd, (seen.get(cwd) ?? 0) + 1);
        }
        const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
        out.push({ key: e.name, chats: files.length, folder: ranked[0] ?? null, clash: ranked.slice(1) });
    }
    return out;
}
