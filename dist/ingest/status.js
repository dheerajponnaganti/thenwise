// `thenwise status`: what the store holds, when it was updated, and what ingest could not use. Read only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORE_FORMAT } from "./ingest.js";
import { prStatus } from "./prs.js";
import { skippedDocs } from "./parts.js";
import { sharesStatus } from "../teams/chats.js";
import { teamStatus } from "../teams/client.js";
export function statusLines(cfg, dbPath) {
    if (!existsSync(dbPath))
        return [`no store at ${dbPath}: run \`thenwise ingest\``];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const all = (sql) => db.prepare(sql).all();
    const out = [`store ${dbPath}, ${(statSync(dbPath).size / 1e6).toFixed(1)} MB, updated ${statSync(dbPath).mtime.toISOString()}`];
    out.push(`nodes: ${all('SELECT kind, count(*) n FROM nodes GROUP BY kind ORDER BY kind').map((r) => `${r.kind} ${r.n}`).join(', ')}`);
    const meta = Object.fromEntries(all('SELECT * FROM meta').map((r) => [r.key, r.value]));
    // An older store still answers, but new search features (emoji, for one) wait for the rebuild at the next sync.
    if (Number(meta.format ?? 1) < STORE_FORMAT)
        out.push(`store format ${meta.format ?? 1} is older than this Thenwise (${STORE_FORMAT}): it rebuilds at the next sync, or run \`thenwise ingest\` now`);
    out.push(`chats: ${meta.sessions_in_scope} in scope, ${meta.sessions_out_of_scope} out of scope, ${meta.excluded_eval_projects} test chats left out, ${meta.excluded_entrypoint} not interactive`);
    const capped = all("SELECT sum(json_extract(extra, '$.capped')) n FROM nodes WHERE kind = 'session'")[0]?.n ?? 0;
    if (capped)
        out.push(`timestamps: ${capped === 1 ? '1 row was dated after its' : `${capped} rows were dated after their`} file's change time and moved back to it`);
    const dup = all("SELECT id FROM nodes WHERE kind = 'session' AND id LIKE 'ses:%@%' ORDER BY id").map((r) => String(r.id));
    if (dup.length)
        out.push(`${dup.length === 1 ? '1 chat shares a session id with an earlier one and is' : `${dup.length} chats share a session id with an earlier one and are`} kept under a folder suffix: ${dup.join(', ')}`);
    const manifestFile = join(cfg.memDir, 'archive/manifest.json');
    if (existsSync(manifestFile)) {
        const man = Object.values(JSON.parse(readFileSync(manifestFile, 'utf8')));
        const bad = man.reduce((n, e) => n + e.unparsed.length, 0);
        const open = man.filter((e) => e.pending).length;
        out.push(`archive: ${man.length} chat files; ${bad} lines did not parse and were skipped${open ? `; ${open} chats end in a half-written line, read on the next run` : ''}`);
    }
    const repos = JSON.parse(all("SELECT value FROM ingest_state WHERE key = 'repos'")[0]?.value ?? '[]');
    out.push(`git: ${repos.length ? repos.join(', ') : 'no repository found in the chats working folders'}`);
    out.push(...prStatus(cfg, repos));
    out.push(...teamStatus(cfg.memDir));
    const sharing = sharesStatus(cfg).summary;
    if (sharing)
        out.push(sharing);
    const skipped = skippedDocs(cfg);
    if (skipped.length)
        out.push(`CLAUDE.md files not read (more than one folder below a root): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}. Add one with "docs" under "ingest" in config.json.`);
    // A project folder that was moved or renamed no longer exists: its old chats keep their old project name.
    const gone = new Map();
    for (const r of all("SELECT json_extract(extra, '$.cwd') cwd, count(*) n FROM nodes WHERE kind = 'session' GROUP BY cwd"))
        if (r.cwd && !existsSync(r.cwd))
            gone.set(r.cwd, r.n);
    for (const [cwd, n] of gone)
        out.push(`project folder gone: ${cwd} (${n} chats). If it was moved or renamed, those chats stay under the old name.`);
    db.close();
    return out;
}
