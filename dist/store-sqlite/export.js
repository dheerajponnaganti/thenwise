// `memory export`: writes the database as read-only Markdown notes (spec 04 §6). Obsidian can show them;
// `managed_by: memory-v2` and `version` tell a reader that edits must come back through `memory import --changes`.
import { resolve, sep } from 'node:path';
import { setFields } from "../core/frontmatter.js";
import { serializeNote } from "../store-files/files-store.js";
export function exportNote({ record: n, extra }, now) {
    const edges = {};
    for (const l of n.links)
        if (l.type !== 'mentions')
            (edges[l.type] ??= []).push(l.target);
    const input = {
        type: n.type, title: n.title, summary: n.summary, body: n.body, status: n.status, confidence: n.confidence, origin: n.origin, author: n.author,
        aliases: n.aliases, tags: n.tags, edges, sources: n.sources, paths: n.paths, urls: n.urls,
        ...(n.validFrom ? { validFrom: n.validFrom } : {}), ...(n.due ? { due: n.due } : {}), ...(n.done !== null ? { done: n.done } : {}),
    };
    const text = serializeNote(n.id, input, { now: n.updatedAt ?? n.recordedAt ?? now, version: n.version, recordedAt: n.recordedAt ?? n.updatedAt ?? now });
    return setFields(text, { ...extra, ...(n.validTo ? { valid_to: n.validTo } : {}), managed_by: 'memory-v2' });
}
/** Writes every node to `<dir>/<path>`; returns how many. A path that would leave `dir` stops the export. */
export async function exportVault(store, dir, io, now) {
    const root = resolve(dir);
    const all = store.dump();
    for (const s of all) {
        const file = resolve(root, s.record.path);
        if (!file.startsWith(root + sep))
            throw new Error(`refusing to write outside ${root}: ${s.record.path}`);
        await io.writeText(file, exportNote(s, now));
    }
    return all.length;
}
