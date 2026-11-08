// Finds the projects in Claude Code's history, and in Copilot CLI's. A folder name under ~/.claude/projects is a lossy mangling
// of the real path (dots, underscores, spaces and slashes all become "-"), so the real folder comes from the `cwd` field.
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normPath } from "../core/vault-index.js";
import { antigravitySources } from "../ingest/antigravity.js";
import { codexSources } from "../ingest/codex.js";
import { copilotSources } from "../ingest/copilot.js";
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
    for (const e of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []).sort((a, b) => (a.name < b.name ? -1 : 1))) {
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
    // Copilot CLI chats name their folder in workspace.yaml; a folder only Copilot has worked in is a project too.
    for (const c of [...copilotSources(dirname(claudeDir)), ...codexSources(dirname(claudeDir)), ...antigravitySources(dirname(claudeDir))]) {
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
