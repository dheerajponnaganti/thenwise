// Files backend (spec 04 §2, 03): the Markdown files are the truth; the index and its cache are disposable.
import { doctor } from "../core/doctor.js";
import { episodeEvent, episodeLine, insertEpisodeLine, sessionFileName } from "../core/episode.js";
import { insertField, quote, setFields, yamlValue } from "../core/frontmatter.js";
import { manifestDataOf } from "../core/manifest.js";
import { StoreError } from "../core/store.js";
import { newId } from "../core/ids.js";
import { ID_PREFIX, SCHEMA_VERSION } from "../core/model.js";
import { parseNote } from "../core/note.js";
import { DEFAULT_CONFIG, termsOf, VaultIndex } from "../core/vault-index.js";
/** Bumped whenever the cache layout or the parser changes, so old caches are rebuilt. */
export const CACHE_VERSION = 2;
/**
 * The cache is split into this many files by path hash. Hosts may cap one read or write
 * (carapace: 4 MiB); one 2,000-note cache was 3.9 MB, so a single file would not scale.
 */
export const CACHE_SHARDS = 16;
const shardOf = (path) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++)
        h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0;
    return h % CACHE_SHARDS;
};
// shortcut: stops scanning past this many files; Files mode targets 10k notes, use a database backend beyond.
export const MAX_FILES = 20_000;
const SKIP_DIRS = new Set(['node_modules']);
/** The human view of episodes. Not indexed: the truth is in .memory/events, and logs would crowd search. */
export const LOG_DIR = 'memory-log';
export const EVENTS_DIR = '.memory/events';
export const CONFIG_FILE = '.memory/config.json';
export const DEFAULT_VAULT_CONFIG = {
    hubs: DEFAULT_CONFIG.hubs,
    manifestBudget: 1500,
    legacyTasksNote: null,
    legacyIndexNote: null,
    layers: { exact: true, map: true, tools: true },
    map: { minCoverage: 0.34, minKnown: 0.8, relCutoff: 0.7, expand: 'off' },
    corrections: false,
};
export async function loadVaultConfig(io, vault) {
    const text = await io.readText(`${vault.replace(/\/+$/, '')}/${CONFIG_FILE}`);
    if (!text)
        return DEFAULT_VAULT_CONFIG;
    try {
        const c = JSON.parse(text);
        const bool = (v, d) => (typeof v === 'boolean' ? v : d);
        const num = (v, d) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
        const D = DEFAULT_VAULT_CONFIG;
        return {
            hubs: { ...DEFAULT_CONFIG.hubs, ...(c.hubs ?? {}) },
            manifestBudget: typeof c.budgets?.manifest === 'number' ? c.budgets.manifest : DEFAULT_VAULT_CONFIG.manifestBudget,
            legacyTasksNote: typeof c.legacy?.tasks_note === 'string' ? c.legacy.tasks_note : null,
            legacyIndexNote: typeof c.legacy?.index_note === 'string' ? c.legacy.index_note : null,
            layers: { exact: bool(c.layers?.exact, D.layers.exact), map: bool(c.layers?.map, D.layers.map), tools: bool(c.layers?.tools, D.layers.tools) },
            map: { minCoverage: num(c.map?.minCoverage, D.map.minCoverage), minKnown: num(c.map?.minKnown, D.map.minKnown), relCutoff: num(c.map?.relCutoff, D.map.relCutoff), expand: c.map?.expand === 'ppr' ? 'ppr' : 'off' },
            corrections: bool(c.corrections, D.corrections),
        };
    }
    catch {
        // A broken config never stops the memory: defaults apply and the checker can say why later.
        return DEFAULT_VAULT_CONFIG;
    }
}
/** Folder per type for notes this store creates. Inbox is a status, not a folder: hosts like carapace cannot move files. */
export const TYPE_FOLDER = { decision: 'decisions', finding: 'findings', entity: 'entities', rule: 'rules', task: 'tasks', note: 'notes' };
/** A lowercase file-name slug of a title, at most 80 characters. */
export const slug = (title) => title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '') || 'note';
/** A whole note file from a NodeInput (spec 03 §2): flat front matter, then the body. */
export function serializeNote(id, input, meta) {
    const lines = [
        '---',
        `id: ${id}`,
        `type: ${input.type}`,
        `title: ${quote(input.title)}`,
        `summary: ${quote(input.summary)}`,
        `status: ${input.status}`,
        `confidence: ${input.confidence}`,
        `origin: ${input.origin}`,
        'scope: project',
        `valid_from: ${input.validFrom ?? meta.now.slice(0, 10)}`,
        `recorded_at: ${meta.recordedAt}`,
        `updated_at: ${meta.now}`,
        `version: ${meta.version}`,
        `author: ${yamlValue(input.author)}`,
    ];
    if (input.aliases?.length)
        lines.push(`aliases: ${yamlValue(input.aliases)}`);
    if (input.tags?.length)
        lines.push(`tags: ${yamlValue(input.tags)}`);
    for (const [type, targets] of Object.entries(input.edges ?? {}))
        if (targets && targets.length)
            lines.push(`${type}: ${yamlValue(targets.map(t => `[[${t}]]`))}`);
    if (input.sources?.length) {
        lines.push('sources:');
        for (const src of input.sources)
            lines.push(`  - ${quote(`${src.kind}:${src.ref}${src.hash ? `@${src.hash}` : ''}${src.at ? ` ${src.at}` : ''}`)}`);
    }
    if (input.paths?.length)
        lines.push(`paths: ${yamlValue(input.paths)}`);
    if (input.urls?.length)
        lines.push(`urls: ${yamlValue(input.urls)}`);
    if (input.due)
        lines.push(`due: ${input.due}`);
    if (input.done !== undefined)
        lines.push(`done: ${input.done}`);
    lines.push('---', input.body.trimEnd(), '');
    return lines.join('\n');
}
export class FilesStore {
    kind = 'files';
    index;
    meta = new Map();
    unavailable = [];
    vault;
    /** Public so a host whose IO is tied to one event (carapace's `$`) can hand in a fresh one per event. */
    io;
    cachePath;
    constructor(io, vault, cachePath, config = DEFAULT_CONFIG) {
        this.io = io;
        this.vault = vault;
        this.cachePath = cachePath;
        this.index = new VaultIndex(config);
    }
    abs(rel) {
        return `${this.vault.replace(/\/+$/, '')}/${rel}`;
    }
    /** Every Markdown file in the vault, vault-relative, skipping dot folders. */
    async scan() {
        const files = new Map();
        let truncated = false;
        const walk = async (rel) => {
            const entries = await this.io.list(rel === '' ? this.vault : this.abs(rel)).catch(() => []);
            for (const e of entries) {
                if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || (rel === '' && e.name === LOG_DIR))
                    continue;
                const path = rel === '' ? e.name : `${rel}/${e.name}`;
                if (e.kind === 'dir')
                    await walk(path);
                else if (e.name.toLowerCase().endsWith('.md')) {
                    if (files.size >= MAX_FILES) {
                        truncated = true;
                        return;
                    }
                    files.set(path, { mtimeMs: e.mtimeMs, size: e.size });
                }
            }
        };
        await walk('');
        return { files, truncated };
    }
    shardPath(i) {
        return `${(this.cachePath ?? '').replace(/\.json$/, '')}.${String(i).padStart(2, '0')}.json`;
    }
    async loadCache() {
        if (!this.cachePath)
            return {};
        const files = {};
        for (let i = 0; i < CACHE_SHARDS; i++) {
            const text = await this.io.readText(this.shardPath(i));
            if (!text)
                continue;
            try {
                const c = JSON.parse(text);
                // An old or foreign shard is ignored, so its files are parsed again: the cache is disposable by design.
                if (c.schema_version === SCHEMA_VERSION && c.cache_version === CACHE_VERSION && c.vault === this.vault)
                    Object.assign(files, c.files ?? {});
            }
            catch {
                // A broken shard costs only a re-parse of its files.
            }
        }
        return files;
    }
    async saveCache() {
        if (!this.cachePath)
            return;
        const shards = Array.from({ length: CACHE_SHARDS }, () => ({}));
        for (const [path, m] of this.meta) {
            const note = this.index.byPath.get(path);
            // Bodies are not cached: they live in the vault and are read when a note is opened.
            if (note)
                shards[shardOf(path)][path] = { mtimeMs: m.mtimeMs, size: m.size, note: { ...note, body: '' }, terms: m.terms };
        }
        for (let i = 0; i < CACHE_SHARDS; i++) {
            const cache = { schema_version: SCHEMA_VERSION, cache_version: CACHE_VERSION, vault: this.vault, files: shards[i] };
            await this.io.writeText(this.shardPath(i), JSON.stringify(cache));
        }
    }
    /** Scans the vault and brings the index up to date, re-reading only files whose size or time changed. */
    async open() {
        const t0 = this.io.now();
        const cached = await this.loadCache();
        const { files, truncated } = await this.scan();
        let parsed = 0;
        let reused = 0;
        this.unavailable = [];
        for (const [path, stat] of files) {
            const c = cached[path];
            if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) {
                this.index.upsert(c.note, c.terms);
                this.meta.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, terms: c.terms });
                reused++;
                continue;
            }
            const ok = await this.readOne(path, stat);
            if (ok)
                parsed++;
            else if (c) {
                // Unreadable now (cloud placeholder): keep the last good copy rather than losing the note.
                this.index.upsert(c.note, c.terms);
                this.meta.set(path, { mtimeMs: c.mtimeMs, size: c.size, terms: c.terms });
            }
        }
        let removed = 0;
        for (const path of [...this.index.byPath.keys()]) {
            if (!files.has(path)) {
                this.index.removePath(path);
                this.meta.delete(path);
                removed++;
            }
        }
        this.index.refreshGraph();
        await this.saveCache().catch(() => undefined);
        return { files: files.size, parsed, reused, removed, unavailable: this.unavailable, truncated, ms: this.io.now() - t0 };
    }
    async readOne(path, stat) {
        const text = await this.io.readText(this.abs(path));
        if (text === null) {
            this.unavailable.push(path);
            return false;
        }
        const note = parseNote(path, text);
        const terms = termsOf(note);
        this.index.upsert(note, terms);
        this.meta.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, terms });
        return true;
    }
    /** Re-reads one file after it changed (or drops it if it is gone). The cheap path for edits during a session. */
    async refreshPath(path) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const name = path.slice(path.lastIndexOf('/') + 1);
        const entries = await this.io.list(parent === '' ? this.vault : this.abs(parent)).catch(() => []);
        const e = entries.find(x => x.name === name && x.kind === 'file');
        if (!e) {
            this.index.removePath(path);
            this.meta.delete(path);
        }
        else
            await this.readOne(path, { mtimeMs: e.mtimeMs, size: e.size });
        this.index.refreshGraph();
    }
    /**
     * Records one episode: an event line in this session's JSONL file (the truth) and a bullet in this
     * session's day log (the human view). Each session writes only its own two files, so sessions never race.
     */
    async appendEpisode(ep, at) {
        const file = sessionFileName(ep.sessionId);
        const eventsPath = this.abs(`${EVENTS_DIR}/${file}.jsonl`);
        const logPath = this.abs(`${LOG_DIR}/${at.day}/${file}.md`);
        const events = await this.io.readText(eventsPath);
        // A log that exists but cannot be read is never replaced (it could be a cloud placeholder).
        if (events === null && (await this.io.exists(eventsPath)))
            throw new Error(`cannot read ${eventsPath}; nothing written`);
        await this.io.writeText(eventsPath, `${events ?? ''}${episodeEvent(ep, at.eventId)}\n`);
        const log = await this.io.readText(logPath);
        if (log === null && (await this.io.exists(logPath)))
            throw new Error(`cannot read ${logPath}; event kept, log not written`);
        const line = episodeLine(at.time, ep);
        await this.io.writeText(logPath, insertEpisodeLine(log ?? '', `${at.day} · session ${file}`, line));
        return { eventsPath, logPath, line };
    }
    /** A note with its body, read fresh from the vault. */
    async get(id) {
        const n = this.index.byId.get(id);
        if (!n)
            return null;
        const text = await this.io.readText(this.abs(n.path));
        return { ...(text === null ? n : parseNote(n.path, text)), id };
    }
    async getMany(ids) {
        const out = new Map();
        for (const id of ids) {
            const n = this.index.byId.get(id);
            if (n)
                out.set(id, { ...n, id });
        }
        return out;
    }
    async search(q) {
        return this.index.search(q.text, { limit: q.limit, includeInbox: q.includeInbox, ...(q.types ? { types: q.types } : {}) });
    }
    async matchExact(key) {
        return this.index.matchExact(key);
    }
    async links(q) {
        return this.index.links(q.ids, { depth: q.depth, limit: q.limit, ...(q.types ? { types: q.types } : {}) });
    }
    async edgesOf(ids, types) {
        this.index.refreshGraph();
        const want = new Set(ids);
        return this.index.edges.filter(e => types.includes(e.type) && (want.has(e.from) || want.has(e.to)));
    }
    async supersedeHead(id) {
        this.index.refreshGraph();
        return this.index.supersedeHead.get(id) ?? id;
    }
    async isHub(id) {
        this.index.refreshGraph();
        return this.index.hubs.has(id);
    }
    async manifestData(opts) {
        return manifestDataOf(this.index, opts.maxTopics);
    }
    async knownTerms(terms) {
        return new Set(terms.filter(t => this.index.lexicon.knows(t)));
    }
    async stats() {
        return this.index.stats();
    }
    /**
     * Writes a new note (or a new version of an agent-written one). Human-written notes are never rewritten:
     * a change to one is a new note that supersedes it (spec 06 §3).
     */
    async put(input, opts) {
        const existing = opts.id ? this.index.byId.get(opts.id) : undefined;
        if (opts.id && !existing)
            throw new StoreError('not_found', `no node ${opts.id}`);
        if (existing) {
            if (existing.confidence !== 'agent')
                throw new StoreError('invalid', `"${existing.title}" was written by ${existing.confidence === 'human' ? 'a person' : 'an import'}; propose a new note that supersedes it`);
            if (opts.expectedVersion !== undefined && opts.expectedVersion !== existing.version)
                throw new StoreError('conflict', `"${existing.title}" is at version ${existing.version}, not ${opts.expectedVersion}`);
            const fresh = await this.io.readText(this.abs(existing.path));
            if (fresh === null)
                throw new StoreError('unavailable', `cannot read ${existing.path}; nothing written`);
            if (parseNote(existing.path, fresh).version !== existing.version)
                throw new StoreError('conflict', `${existing.path} changed on disk since it was indexed`);
            const id = opts.id;
            await this.io.writeText(this.abs(existing.path), serializeNote(id, input, { now: opts.now, version: existing.version + 1, recordedAt: existing.recordedAt ?? opts.now }));
            await this.refreshPath(existing.path);
            return (await this.get(id));
        }
        const prefix = { decision: 'dec', finding: 'fnd', entity: 'ent', rule: 'rul', task: 'tsk', note: 'not' }[input.type];
        const id = opts.newId(prefix);
        const folder = TYPE_FOLDER[input.type];
        let path = `${folder}/${slug(input.title)}.md`;
        for (let n = 2; this.index.byPath.has(path) || (await this.io.exists(this.abs(path))); n++)
            path = `${folder}/${slug(input.title)}-${n}.md`;
        await this.io.writeText(this.abs(path), serializeNote(id, input, { now: opts.now, version: 1, recordedAt: opts.now }));
        await this.refreshPath(path);
        return (await this.get(id));
    }
    /** Changes status in place (one or two front-matter lines); every other byte of the file is kept. */
    async setStatus(id, status, opts) {
        const n = this.index.byId.get(id);
        if (!n)
            throw new StoreError('not_found', `no node ${id}`);
        const text = await this.io.readText(this.abs(n.path));
        if (text === null)
            throw new StoreError('unavailable', `cannot read ${n.path}; nothing written`);
        const fields = { status, updated_at: opts.now };
        if (opts.validTo)
            fields.valid_to = opts.validTo;
        await this.io.writeText(this.abs(n.path), setFields(text, fields));
        await this.refreshPath(n.path);
        return (await this.get(id));
    }
    doctor() {
        return doctor(this.index, this.unavailable);
    }
    /**
     * Gives every note without an id one, by adding a single `id:` line to its front matter
     * (or creating front matter for a plain note). No other byte of the file changes.
     */
    async ensureIds(random) {
        const done = [];
        for (const n of [...this.index.byPath.values()]) {
            if (n.id !== null)
                continue;
            const text = await this.io.readText(this.abs(n.path));
            // Never write a file that could not be read.
            if (text === null)
                continue;
            const fresh = parseNote(n.path, text);
            if (fresh.id !== null)
                continue;
            const id = newId(ID_PREFIX[fresh.type], this.io.now(), random);
            await this.io.writeText(this.abs(n.path), insertField(text, 'id', id));
            await this.refreshPath(n.path);
            done.push({ path: n.path, id });
        }
        await this.saveCache().catch(() => undefined);
        return done;
    }
}
