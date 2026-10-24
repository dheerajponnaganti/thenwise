// `thenwise views --vault <dir>`: generated Obsidian notes, written to <dir>/Memory v2/Generated/.
// Timelines per project, a page per busy file, and an index. Deterministic: the same graph gives the same files,
// and a file is only rewritten when its text changes. Only files this command made (front matter `generated: true`)
// are ever removed. No model.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GENERATED } from "../ingest/ingest.js";
import { Graph, local } from "../query/engine.js";
const TOP_FILES = 30;
const PASSAGE = 300;
const flat = (s) => s.replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
export const cut = (s, n) => (flat(s).length > n ? `${flat(s).slice(0, n).trimEnd()}...` : flat(s));
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
const short = (id) => id.replace(/^(ses|turn|sum):(.{8}).*$/, '$1:$2');
// A private mirror repo named "<name>-private" shares its timeline with the repo it mirrors.
export const repo = (p) => p.replace(/-private$/, '');
const ms = (n) => Date.parse(n.at) || 0;
const MARK = (built) => `---\ngenerated: true\n---\n\n> Generated and rebuilt by \`memory views\` (graph built ${built}). Do not edit: changes are overwritten.\n\n`;
export function sourceOf(n) {
    if (n.kind === 'pr')
        return `[PR #${n.id.split('#').pop()}](${n.extra.url ?? n.source})`;
    if (n.kind === 'commit')
        return `commit ${n.id.split(':').pop().slice(0, 7)} in ${n.project}`;
    if (n.kind === 'summary')
        return `summary of ${short(n.source)}`;
    if (n.kind === 'session')
        return `session ${short(n.id)}`;
    if (n.kind === 'note' || n.kind === 'section')
        return `note ${basename(n.source, '.md')}`;
    return n.id;
}
/** The project folder a file sits in: the first folder under the home folder, with worktrees counted as their repo. */
export function folderOf(fileId) {
    const m = /^file:\/(?:Users|home)\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(fileId);
    if (!m || m[1].startsWith('.'))
        return undefined;
    return m[1];
}
/** The project of each session, and the sessions that touched each file. */
export function sessionProjects(g, projects = []) {
    // A session belongs to the repo whose commits and PRs its turns made or opened; failing that, to the top folder its
    // turns worked in most (a chat run from the home folder about ~/my-project is that project's); failing that, its cwd.
    const sessions = [...g.nodes.values()].filter((n) => n.kind === 'session');
    const projectOf = new Map();
    const touchedBy = new Map(); // file id -> sessions/PRs/commits/notes that touched it
    for (const s of sessions) {
        const votes = new Map();
        const folders = new Map();
        const named = new Set();
        for (const e of g.adj.get(s.id) ?? []) {
            if (e.kind !== 'part_of' || e.out)
                continue;
            for (const t of g.adj.get(e.to) ?? []) {
                const x = g.nodes.get(t.to);
                if (t.out && (t.kind === 'made' || t.kind === 'opened') && x)
                    votes.set(repo(x.project), (votes.get(repo(x.project)) ?? 0) + 1);
                if (t.out && x?.kind === 'file' && (t.kind === 'edited' || t.kind === 'ran_in'))
                    for (const p of projects ?? [])
                        if (p.paths.some((r) => x.id.slice(5) === r || x.id.slice(5).startsWith(`${r}/`)))
                            named.add(p.name);
                if (t.out && x?.kind === 'file' && t.kind !== 'mentions') {
                    ;
                    (touchedBy.get(x.id) ?? touchedBy.set(x.id, new Set()).get(x.id)).add(s.id);
                    const f = folderOf(x.id);
                    // Where a chat wrote and ran things says more about its project than what it read.
                    if (f)
                        folders.set(f, (folders.get(f) ?? 0) + (t.kind === 'edited' || t.kind === 'ran_in' ? 3 : 1));
                }
            }
        }
        const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
        const folder = [...folders].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
        // A named project the owner configured wins: its words in the chat's first prompt, or its folders edited.
        const first = `${s.title} ${g.fullText(s.id)}`.toLowerCase();
        const chosen = (projects ?? []).find((p) => named.has(p.name) || p.words.some((w) => first.includes(w)))?.name;
        projectOf.set(s.id, chosen ?? best ?? folder ?? (basename(String(s.extra.cwd ?? '')) || s.project));
    }
    return { projectOf, touchedBy };
}
export function writeViews(dbPath, vault, opts = {}) {
    const g = new Graph(dbPath);
    const built = local(opts.builtAt ?? statSync(dbPath).mtime.toISOString());
    const root = join(vault, GENERATED);
    const out = new Map(); // relative path -> text
    const { projectOf, touchedBy } = sessionProjects(g, opts.projects);
    // Timelines.
    const lines = new Map();
    const add = (project, n, text) => (lines.get(project) ?? lines.set(project, []).get(project)).push({ n, text });
    for (const n of g.nodes.values()) {
        if (n.kind === 'pr')
            add(repo(n.project), n, `PR #${n.id.split('#').pop()}: ${cut(n.title, 140)}${n.until ? ` (merged ${local(n.until).slice(0, 10)})` : ` (${String(n.extra.state ?? 'open').toLowerCase()})`}`);
        else if (n.kind === 'commit') {
            const t = n.extra.trailers;
            if (t?.decision)
                add(repo(n.project), n, `decision: ${cut(t.decision.join('; '), 160)} (commit "${cut(n.title, 80)}")`);
        }
        else if (n.kind === 'session')
            add(projectOf.get(n.id), n, `session began: "${cut(n.title, 140)}"`);
        else if (n.kind === 'summary')
            add(projectOf.get(n.source) ?? n.project, n, `compaction summary: ${cut(g.fullText(n.id), 140)}`);
    }
    for (const [project, items] of lines) {
        const body = items.sort((a, b) => ms(a.n) - ms(b.n) || (a.n.id < b.n.id ? -1 : 1)).map((x) => `- ${local(x.n.at)}  ${x.text}  (${sourceOf(x.n)})`);
        out.set(`Timelines/${slug(project)}.md`, `${MARK(built)}# Timeline: ${project}\n\n${body.join('\n')}\n`);
    }
    // Files with the most history. A turn counts as its session.
    const histories = new Map();
    const touch = (file, n) => (histories.get(file) ?? histories.set(file, new Map()).get(file)).set(n.id, n);
    for (const [file, ids] of touchedBy)
        for (const id of ids)
            touch(file, g.nodes.get(id));
    for (const n of g.nodes.values()) {
        if (!['pr', 'commit', 'note', 'summary'].includes(n.kind))
            continue;
        for (const e of g.adj.get(n.id) ?? [])
            if (e.out && g.nodes.get(e.to)?.kind === 'file' && ['touches', 'changed', 'mentions'].includes(e.kind))
                touch(e.to, n);
    }
    const used = new Set();
    const top = [...histories].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_FILES);
    const index = [];
    for (const [file, items] of top) {
        const f = g.nodes.get(file);
        const name = f.extra.aliases?.[0] ?? file.slice(5);
        let s = slug(name);
        if (used.has(s))
            s = `${s}-${createHash('sha1').update(file).digest('hex').slice(0, 6)}`;
        used.add(s);
        const body = [...items.values()].sort((a, b) => ms(b) - ms(a) || (a.id < b.id ? -1 : 1)).map((n) => {
            const text = n.kind === 'pr' || n.kind === 'commit' ? `${n.title}${g.fullText(n.id) ? `: ${g.fullText(n.id)}` : ''}` : g.fullText(n.id) || n.title;
            return `- ${local(n.at)}  ${n.kind} (${sourceOf(n)}): ${cut(text, PASSAGE)}`;
        });
        out.set(`Files/${s}.md`, `${MARK(built)}# File: ${name}\n\n${items.size} records touched it, newest first.\n\n${body.join('\n')}\n`);
        index.push(`- [[${GENERATED}Files/${s}|${name}]] (${items.size})`);
    }
    const tl = [...out.keys()].filter((k) => k.startsWith('Timelines/')).sort();
    out.set('Index.md', `${MARK(built)}# Memory v2 views\n\nBuilt from the graph of ${built}.\n\n## Timelines\n\n${tl.map((k) => `- [[${GENERATED}${k.replace(/\.md$/, '')}|${k.slice(10, -3)}]]`).join('\n')}\n\n## Files with the most history\n\n${index.join('\n')}\n`);
    // Write what changed; remove stale files that this command made, inside the Generated folder only.
    let written = 0;
    let removed = 0;
    for (const [rel, text] of out) {
        const p = join(root, rel);
        if (existsSync(p) && readFileSync(p, 'utf8') === text)
            continue;
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
        written++;
    }
    const sweep = (dir) => {
        if (!existsSync(dir))
            return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                sweep(p);
                if (!readdirSync(p).length)
                    rmdirSync(p);
            }
            else if (e.isFile() && !out.has(p.slice(root.length)) && /^---\ngenerated: true\n/.test(readFileSync(p, 'utf8')))
                (rmSync(p), removed++);
        }
    };
    sweep(root);
    return { dir: root, files: [...out.keys()].sort(), written, removed };
}
