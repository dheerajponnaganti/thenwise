// `memory distill`: Haiku proposes, the owner decides. Reads only the masked archive, sends masked text through
// `claude -p --model haiku` (the owner's subscription), and writes proposals as inbox notes. No model in retrieval.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { logger } from "../core/log.js";
import { maskSecrets } from "../core/secrets.js";
import { globMatch } from "../ingest/config.js";
import { parseSession } from "../ingest/transcript.js";
import { expireInbox, makeId, readNotes, saveNote } from "./notes.js";
import { related } from "./similar.js";
const MAX_ITEMS = 4;
const CHUNK_CHARS = 9000;
const CHUNK_UNITS = 12;
const TYPES = new Set(['decision', 'dead_end', 'rule', 'now']);
const PROMPT = `You review excerpts of a software work session and propose long-term memory notes for the owner to approve.
Each excerpt starts with a label such as [t3] or [s1].
Return ONLY a JSON object: {"items":[{"type":"decision|dead_end|rule|now","title":"...","summary":"...","sources":["t3"]}]}
Rules:
- At most ${MAX_ITEMS} items. At most one "rule" and at most one "now" ("where the work stands").
- decision: a choice made, with its reason in the summary. dead_end: what was tried and why it failed.
- Only stable, non-obvious facts a future session needs. Never one-off chatter, status updates or things visible in the code.
- Quote no secrets, keys, tokens or passwords.
- title under 100 characters, summary under 300 characters, plain sentences.
- Every item must cite the labels it came from in "sources". An item without a source is discarded.
- If nothing qualifies, return {"items":[]}.

EXCERPTS:
`;
const CONTRA = (oldFact, newFact) => `Old fact: ${oldFact}
New fact: ${newFact}
Mark a fact as contradicted ONLY if the new fact explicitly makes the old fact false. Do NOT infer contradiction from recency alone. If unsure, answer no.
Reply with JSON only: {"contradicts":"yes"} or {"contradicts":"no"}`;
/** One model call. Everything sent is masked again here, whatever the caller did. */
export function callModel(prompt) {
    const bin = process.env.MEMORY_CLAUDE_BIN ?? 'claude';
    const r = spawnSync(bin, ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--disable-slash-commands'], { input: maskSecrets(prompt).text, encoding: 'utf8', cwd: tmpdir(), timeout: 240000, maxBuffer: 1 << 24 });
    if (r.status !== 0)
        throw new Error(`model call failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).toString().trim().split('\n')[0]}`);
    try {
        const j = JSON.parse(r.stdout);
        if (typeof j?.result === 'string')
            return { text: j.result, outTokens: j.usage?.output_tokens ?? null };
    }
    catch {
        // plain text from a wrapper: use as is
    }
    return { text: r.stdout, outTokens: null };
}
/** Strict parse: sourceless or unknown-label items are dropped, then the per-chunk caps apply. */
export function parseItems(text, labels) {
    let raw = [];
    try {
        raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).items;
    }
    catch {
        return { items: [], dropped: 0 };
    }
    if (!Array.isArray(raw))
        return { items: [], dropped: 0 };
    const items = [];
    let dropped = 0;
    const used = {};
    for (const x of raw) {
        const sources = Array.isArray(x?.sources) ? [...new Set(x.sources.map(String).filter((l) => labels.has(l)))] : [];
        const ok = TYPES.has(x?.type) && typeof x.title === 'string' && x.title.trim() && typeof x.summary === 'string' && x.summary.trim() && sources.length;
        const cap = x?.type === 'rule' || x?.type === 'now' ? 1 : MAX_ITEMS;
        if (!ok || items.length >= MAX_ITEMS || (used[x.type] ?? 0) >= cap) {
            dropped++;
            continue;
        }
        used[x.type] = (used[x.type] ?? 0) + 1;
        items.push({ type: x.type, title: maskSecrets(x.title.trim()).text.slice(0, 120), summary: maskSecrets(x.summary.trim()).text.slice(0, 400), sources });
    }
    return { items, dropped };
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
export function distill(cfg, opts = {}) {
    const now = opts.now ?? Date.now();
    const res = { lines: [], proposals: 0, dropped: 0, calls: 0 };
    const stateFile = join(cfg.memDir, 'distill-state.json');
    const logFile = join(cfg.memDir, 'distill-log.jsonl');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    if (!opts.dryRun) {
        const ex = expireInbox(cfg.memDir, now);
        if (ex.length)
            res.lines.push(`expired ${ex.length} unreviewed inbox note(s) older than 14 days`);
    }
    const events = logger('distill', cfg.memDir);
    const log = (o) => {
        ;
        (o.error ? events.error : events.info)(String(o.kind), o);
        appendFileSync(logFile, `${JSON.stringify({ time: new Date(now).toISOString(), ...o })}\n`, { mode: 0o600 }); // read for one more release
    };
    const root = join(cfg.memDir, 'archive/sessions');
    const under = (p, r) => p === r || p.startsWith(`${r}/`);
    for (const key of existsSync(root) ? readdirSync(root).sort() : []) {
        if (cfg.ingestExcludeProjects.some((g) => globMatch(g, key)))
            continue;
        for (const f of readdirSync(join(root, key)).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
            const id = f.replace(/\.jsonl\.gz$/, '');
            if (opts.session && opts.session !== id)
                continue;
            const s = parseSession(gunzipSync(readFileSync(join(root, key, f))).toString('utf8'), id, cfg.home);
            if (!cfg.includeEntrypoints.includes(s.entrypoint) || !s.start || ![s.cwd, ...s.paths].some((p) => p && cfg.roots.some((r) => under(p, r))))
                continue;
            if (opts.since && Date.parse(s.end) < Date.parse(opts.since))
                continue;
            const st = state[id] ?? { turn: '', summaries: [] };
            const at = s.turns.findIndex((t) => t.id === st.turn);
            let turns = s.turns.slice(at + 1);
            if (opts.last)
                turns = turns.slice(-opts.last);
            const units = [
                ...s.summaries.filter((m) => !st.summaries.includes(m.id)).map((m, i) => ({ label: `s${i + 1}`, node: `sum:${m.id}`, text: clip(m.text, 1500), turn: false })),
                ...turns.map((t, i) => ({ label: `t${i + 1}`, node: `turn:${t.id}`, text: `USER: ${clip(t.prompt, 600)}\nASSISTANT: ${clip(t.reply.join('\n'), 900)}`, turn: true })),
            ];
            if (!units.length)
                continue;
            const chunks = [];
            for (const u of units) {
                const cur = chunks[chunks.length - 1];
                if (cur && cur.length < CHUNK_UNITS && cur.reduce((a, x) => a + x.text.length, 0) + u.text.length <= CHUNK_CHARS)
                    cur.push(u);
                else
                    chunks.push([u]);
            }
            res.lines.push(`session ${id}: ${units.length} unit(s) in ${chunks.length} chunk(s)`);
            for (const chunk of chunks) {
                const body = chunk.map((u) => `[${u.label}]\n${u.text}`).join('\n\n');
                const prompt = PROMPT + maskSecrets(body).text;
                if (opts.dryRun) {
                    res.lines.push(`  dry run: chunk of ${chunk.length} unit(s), ${prompt.length} characters, no model call`);
                    continue;
                }
                let out;
                try {
                    res.calls++;
                    out = callModel(prompt);
                }
                catch (e) {
                    res.lines.push(`  stopped session ${id}: ${e instanceof Error ? e.message : e}`);
                    log({ session: id, kind: 'distill', chunk_chars: prompt.length, error: true });
                    break;
                }
                const parsed = parseItems(out.text, new Set(chunk.map((u) => u.label)));
                let kept = 0;
                let dropped = parsed.dropped;
                const byLabel = new Map(chunk.map((u) => [u.label, u.node]));
                for (const it of parsed.items) {
                    const notes = readNotes(cfg.memDir);
                    const active = notes.filter((n) => n.status === 'active');
                    const rel = related(it, notes.filter((n) => n.status === 'active' || n.status === 'inbox'), active);
                    if (rel.dup) {
                        dropped++;
                        continue;
                    }
                    let supersedes = '';
                    if (rel.candidate) {
                        res.calls++;
                        const c = callModel(CONTRA(rel.candidate.summary, it.summary));
                        log({ session: id, kind: 'contradiction', chunk_chars: 0, output_tokens: c.outTokens, items: 0, dropped: 0 });
                        if (/"contradicts"\s*:\s*"yes"/i.test(c.text))
                            supersedes = rel.candidate.id;
                    }
                    const sources = [`ses:${id}`, ...it.sources.map((l) => byLabel.get(l))];
                    // One "where the work stands" per session: a newer one replaces the older unreviewed ones.
                    if (it.type === 'now')
                        for (const n of readNotes(cfg.memDir).filter((x) => x.type === 'now' && x.status === 'inbox' && x.sources.includes(`ses:${id}`)))
                            saveNote(cfg.memDir, { ...n, status: 'expired' });
                    saveNote(cfg.memDir, { id: makeId('n', `${it.type}\0${it.title}\0${sources.join(',')}`), type: it.type, title: it.title, summary: it.summary, status: 'inbox', valid_from: '', valid_to: '', supersedes, sources, created: new Date(now).toISOString(), project: key, path: '' });
                    kept++;
                }
                res.proposals += kept;
                res.dropped += dropped;
                log({ session: id, kind: 'distill', chunk_chars: prompt.length, output_tokens: out.outTokens, items: kept, dropped });
                const lastTurn = [...chunk].reverse().find((u) => u.turn);
                state[id] = { turn: lastTurn ? lastTurn.node.slice(5) : st.turn, summaries: [...st.summaries, ...chunk.filter((u) => !u.turn).map((u) => u.node.slice(4))] };
                st.turn = state[id].turn;
                st.summaries = state[id].summaries;
                writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });
                res.lines.push(`  chunk: ${kept} proposal(s) written, ${dropped} dropped`);
            }
        }
    }
    return res;
}
