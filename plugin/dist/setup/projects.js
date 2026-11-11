// Finds the projects in Claude Code's history, and in Copilot CLI's. A folder name under ~/.claude/projects is a lossy mangling
// of the real path (dots, underscores, spaces and slashes all become "-"), so the real folder comes from the `cwd` field.
import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listDir } from "../core/home.js";
import { errFields, logger } from "../core/log.js";
import { normPath } from "../core/vault-index.js";
import { antigravitySources } from "../ingest/antigravity.js";
import { codexSources } from "../ingest/codex.js";
import { copilotSources } from "../ingest/copilot.js";
function headCwd(file) {
    try {
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
        finally {
            closeSync(fd);
        }
    }
    catch {
        // unreadable, or a dangling link: the next file may name a folder
    }
    return null;
}
/** Reads the head of up to `sample` chats per project; counts every top-level chat. */
/** Projects in the chat history that the config's roots leave out and no exclude rule names: they are silently out of scope. */
export function newProjectLines(claudeDir, roots, excluded) {
    const norm = roots.map(normPath); // Windows separators and a trailing slash still match
    const out = discoverProjects(claudeDir).filter((p) => p.folder && !excluded(p.key) && !norm.some((r) => normPath(p.folder) === r || normPath(p.folder).startsWith(`${r}/`)));
    return out.length ? [`not remembered yet: ${out.map((p) => p.folder).join(', ')}. Run \`thenwise setup\` to add ${out.length === 1 ? 'it' : 'them'}.`] : [];
}
// A hook process loads the config more than once and lives under a second: it scans four tools' folders once.
// Longer processes (ingest, the memory server) scan every time, so a new project folder is seen.
const found = new Map();
let memo = false;
export const memoProjects = () => (memo = true);
export function discoverProjects(claudeDir, sample = 20) {
    if (!memo)
        return scanProjects(claudeDir, sample);
    const k = `${claudeDir}\0${sample}`;
    if (!found.has(k))
        found.set(k, scanProjects(claudeDir, sample));
    return found.get(k);
}
function scanProjects(claudeDir, sample) {
    const root = join(claudeDir, 'projects');
    const out = [];
    for (const e of listDir(root).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!e.isDirectory())
            continue;
        const files = listDir(join(root, e.name)).map((f) => f.name).filter((f) => f.endsWith('.jsonl')).sort();
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
    // Copilot CLI chats name their folder in workspace.yaml; a folder only Copilot has worked in is a project too.
    // One tool's broken folder must not hide the others, or stop the config from loading.
    const sources = (f) => {
        try {
            return f(dirname(claudeDir));
        }
        catch (e) {
            logger('config').warn('chat_scan_failed', { tool: f.name, ...errFields(e) });
            return [];
        }
    };
    for (const c of [copilotSources, codexSources, antigravitySources].flatMap(sources)) {
        if (/^([a-zA-Z]:)?[\\/]?$/.test(c.cwd))
            continue;
        const name = c.rel.split('/')[0];
        const p = out.find(({ key }) => key === name);
        if (!p)
            out.push({ key: name, chats: 1, folder: c.cwd, clash: [] });
        else {
            p.chats++;
            p.folder ??= c.cwd;
        }
    }
    return out.sort(({ key: a }, { key: z }) => (a < z ? -1 : 1));
}
