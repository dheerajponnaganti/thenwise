// `memory import`: loads a Markdown vault into a SQLite store, once. After that the database is the truth (spec 04 §6).
// Parsing and link resolution reuse the Files code, so notes, ids and edges come out exactly as in Files mode.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter } from "../core/frontmatter.js";
import { FRONT_MATTER_EDGES } from "../core/model.js";
import { parseNote } from "../core/note.js";
import { StoreError } from "../core/store.js";
import { VaultIndex } from "../core/vault-index.js";
import { LOG_DIR } from "../store-files/files-store.js";
/** Front-matter keys the data model knows; anything else is kept in `extra` and written back on export. */
const KNOWN = new Set(['id', 'type', 'title', 'summary', 'aliases', 'tags', 'status', 'confidence', 'origin', 'scope', 'valid_from', 'valid_to', 'recorded_at', 'updated_at', 'version', 'author', 'sources', 'paths', 'urls', 'done', 'due', 'managed_by', ...FRONT_MATTER_EDGES]);
/** Every Markdown file under `dir` as vault-relative path to text, skipping what the Files store skips. */
export function readVaultFiles(dir) {
    const files = {};
    const walk = (rel) => {
        for (const e of readdirSync(rel === '' ? dir : join(dir, rel), { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || (rel === '' && e.name === LOG_DIR))
                continue;
            const path = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory())
                walk(path);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.md'))
                files[path] = readFileSync(join(dir, path), 'utf8');
        }
    };
    walk('');
    return files;
}
export function importVault(store, files) {
    if (!store.isEmpty())
        throw new StoreError('invalid', 'the database already holds notes; import into an empty one');
    const index = new VaultIndex(store.hubConfig);
    const extras = new Map();
    for (const [path, text] of Object.entries(files)) {
        index.upsert(parseNote(path, text));
        extras.set(path, Object.fromEntries(Object.entries(parseFrontMatter(text).data).filter(([k]) => !KNOWN.has(k))));
    }
    index.refreshGraph();
    store.transaction(() => {
        for (const [id, n] of index.byId)
            store.addNode({ ...n, id }, extras.get(n.path) ?? {});
        store.setGraph(index.edges, index.unresolved);
    });
    return { nodes: index.byId.size, edges: index.edges.length, unresolved: index.unresolved.length, duplicates: [...index.duplicateIds.values()].flatMap(p => p.slice(1)) };
}
