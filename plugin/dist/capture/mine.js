// Rule mining: where dead ends keep happening becomes a rule proposal in the inbox, for the person to accept or reject.
// Only dead ends the store saw happen count (a failed test, an undone edit, a closed PR, a revert, a [dead-end] line
// someone wrote). A sentence picked from a reply does not: a release turn that mentions one would tie it to every file
// the release touched. No model; the same evidence never proposes twice, and a rejected proposal stays rejected.
import { Graph } from "../query/engine.js";
import { trigramSim } from "./similar.js";
import { makeId, readNotes, saveNote } from "./notes.js";
/** Chats or commits that must hit a dead end at one file before it is proposed as a rule. */
export const MIN_SOURCES = 3;
const SAME_LINE = 0.8;
/** A dead end that changed more files than this (a release, a big revert) says nothing about any one of them. */
export const MAX_FILES = 5;
/** A file changed by this share of all chats and commits (a changelog, a lock file) is churn, never a rule. */
const CHURN = 0.3;
const CHURN_MIN = 10;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);
/** Writes rule proposals to the inbox; returns how many were new. `off` is the paused-folder check: their dead ends never count. */
export function mineRules(memDir, dbPath, now = new Date(), off) {
    const g = new Graph(dbPath, { lazy: true });
    g.off = off;
    const db = g.db;
    let dead;
    const files = new Map();
    const alias = new Map();
    try {
        dead = db.prepare("SELECT id, kind, source, at, project, json_extract(extra, '$.deadEnd') AS text, json_extract(extra, '$.deadEndKind') AS how FROM nodes WHERE kind IN ('turn', 'commit', 'pr') AND json_extract(extra, '$.deadEnd') IS NOT NULL AND coalesce(json_extract(extra, '$.deadEndKind'), 'phrase') != 'phrase' ORDER BY at, id").all().filter((d) => !g.paused(g.nodes.get(d.id))).map((d) => ({ ...d, text: String(d.text ?? '') }));
        const edges = db.prepare("SELECT dst FROM edges WHERE src = ? AND kind IN ('edited', 'changed', 'touches') AND dst LIKE 'file:%'");
        const fileNode = db.prepare('SELECT extra FROM nodes WHERE id = ?');
        const touched = db.prepare("SELECT dst, count(DISTINCT src) AS n FROM edges WHERE kind IN ('edited', 'changed', 'touches') AND dst LIKE 'file:%' GROUP BY dst").all();
        const all = Number(db.prepare("SELECT count(DISTINCT src) AS n FROM edges WHERE kind IN ('edited', 'changed', 'touches') AND dst LIKE 'file:%'").get().n);
        const churn = new Set(touched.filter((t) => t.n >= CHURN_MIN && t.n >= all * CHURN).map((t) => t.dst));
        for (const d of dead) {
            const hit = edges.all(d.id).filter((e) => !churn.has(e.dst));
            if (hit.length > MAX_FILES)
                continue;
            for (const { dst } of hit) {
                files.set(dst, [...(files.get(dst) ?? []), d]);
                if (!alias.has(dst)) {
                    const extra = JSON.parse(String(fileNode.get(dst)?.extra ?? '{}'));
                    alias.set(dst, extra.aliases?.[0] ?? dst.slice(5));
                }
            }
        }
    }
    finally {
        db.close();
    }
    // A chat counts once however many of its turns hit the dead end; a commit or a PR counts as its own source.
    const sourceOf = (d) => (d.kind === 'turn' ? d.source : d.id);
    const have = new Set(readNotes(memDir).map((n) => n.id));
    let wrote = 0;
    const propose = (key, title, intro, ds) => {
        const id = makeId('mine', key);
        if (have.has(id))
            return;
        have.add(id);
        const projects = ds.map((d) => d.project).filter(Boolean);
        const project = projects.sort((a, b) => projects.filter((p) => p === b).length - projects.filter((p) => p === a).length)[0] ?? '';
        const lines = ds.slice(-8).map((d) => `- ${d.at.slice(0, 10)} ${d.how}: ${cut(d.text.replace(/\s+/g, ' '), 140)} (${d.id})`);
        saveNote(memDir, { id, type: 'rule', title, summary: [intro, ...lines].join('\n'), status: 'inbox', valid_from: ds[ds.length - 1].at, valid_to: '', supersedes: '', sources: ds.map((d) => d.id), created: now.toISOString(), project, path: '' });
        wrote++;
    };
    for (const [file, ds] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const sources = new Set(ds.map(sourceOf));
        if (sources.size < MIN_SOURCES)
            continue;
        const name = alias.get(file);
        propose(`file\0${file}`, `Dead ends keep happening at ${cut(name, 80)}`, `${sources.size} chats or commits hit a dead end after changing ${name}. A rule for this file (check first, or a test to run) may save the next one.`, ds);
    }
    // The same [dead-end] line written in two or more chats: the person already knows it, the next agent does not.
    const marked = dead.filter((d) => d.how === 'marked');
    const used = new Set();
    for (const d of marked) {
        if (used.has(d.id))
            continue;
        const same = marked.filter((x) => !used.has(x.id) && trigramSim(x.text, d.text) >= SAME_LINE);
        if (new Set(same.map(sourceOf)).size < 2)
            continue;
        for (const x of same)
            used.add(x.id);
        propose(`line\0${d.text.toLowerCase().replace(/\s+/g, ' ').trim()}`, `Repeated dead end: ${cut(d.text, 80)}`, `This dead end was written in ${new Set(same.map(sourceOf)).size} chats. As a rule, the next agent hears it before trying again.`, same);
    }
    return wrote;
}
