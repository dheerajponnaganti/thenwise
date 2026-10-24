// Parse one (already masked) Claude Code transcript into sessions, turns, compaction summaries and tool facts.
import { posix } from 'node:path';
import { normPath } from "../core/vault-index.js";
const BASH_PATH = /(?:^|[\s"'=:(])((?:~|\/Users)\/[^\s"'`;|&)<>]+)/g;
const TRANSCRIPT_REF = /read the full transcript at:\s*(\S+?\.jsonl)/i;
export function normalizePath(path, home, cwd = '/') {
    const p = normPath(path);
    const abs = p.startsWith('~/') ? posix.join(normPath(home), p.slice(2)) : p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : posix.join(normPath(cwd) || '/', p);
    return posix.normalize(abs).replace(/\/+$/, '') || '/';
}
export function bashPaths(cmd, home) {
    const out = new Set();
    for (const m of cmd.matchAll(BASH_PATH)) {
        const p = m[1].replace(/[.,:]+$/, '');
        if (p.length > 3 && !p.endsWith('/'))
            out.add(normalizePath(p, home));
    }
    return [...out];
}
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
function promptText(content) {
    let t;
    if (typeof content === 'string')
        t = content;
    else if (Array.isArray(content) && content.length && !content.some((b) => b?.type === 'tool_result'))
        t = textOf(content.filter((b) => b?.type === 'text'));
    else
        return null;
    t = t.trim();
    return !t || t.startsWith('<') || t.startsWith('[Request interrupted') ? null : t;
}
/** `until` (ISO) drops every entry stamped after it. */
export function parseSession(text, id, home, until = '') {
    const cut = until ? Date.parse(until) : Infinity;
    const s = { id, cwd: '', entrypoint: '', start: '', end: '', turns: [], summaries: [], paths: new Set() };
    const pending = new Map();
    let turn = null;
    for (const line of text.split('\n')) {
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!d || typeof d !== 'object' || (d.type !== 'user' && d.type !== 'assistant') || d.isSidechain)
            continue;
        if (typeof d.timestamp === 'string' && Date.parse(d.timestamp) > cut)
            continue;
        if (!s.entrypoint && typeof d.entrypoint === 'string')
            s.entrypoint = d.entrypoint;
        if (!s.cwd && typeof d.cwd === 'string')
            s.cwd = d.cwd;
        if (typeof d.timestamp === 'string') {
            if (!s.start || d.timestamp < s.start)
                s.start = d.timestamp;
            if (d.timestamp > s.end)
                s.end = d.timestamp;
        }
        const content = d.message?.content;
        if (d.type === 'user') {
            if (d.isCompactSummary) {
                const t = textOf(content);
                s.summaries.push({ id: d.uuid, at: d.timestamp ?? '', text: t, continuedFrom: TRANSCRIPT_REF.exec(t)?.[1]?.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? null });
                continue;
            }
            if (Array.isArray(content)) {
                for (const b of content) {
                    const hit = b?.type === 'tool_result' ? pending.get(b.tool_use_id) : undefined;
                    if (!hit)
                        continue;
                    const out = textOf(b.content);
                    if (hit.kind === 'commit')
                        for (const m of out.matchAll(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g))
                            hit.turn.commitShas.add(m[1]);
                    else
                        for (const m of out.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g))
                            hit.turn.prUrls.add(m[0]);
                }
            }
            const p = d.isMeta ? null : promptText(content);
            if (p && typeof d.uuid === 'string') {
                turn = { id: d.uuid, at: d.timestamp ?? '', prompt: p, reply: [], reads: new Set(), edits: new Set(), ran: new Set(), commitMsgs: [], commitShas: new Set(), prUrls: new Set() };
                s.turns.push(turn);
            }
        }
        else if (Array.isArray(content)) {
            for (const b of content) {
                if (b?.type === 'text' && turn && typeof b.text === 'string')
                    turn.reply.push(b.text);
                if (b?.type !== 'tool_use')
                    continue;
                const inp = b.input ?? {};
                const file = inp.file_path ?? inp.notebook_path;
                if (typeof file === 'string') {
                    const p = normalizePath(file, home, s.cwd || '/');
                    s.paths.add(p);
                    if (turn)
                        (b.name === 'Read' ? turn.reads : /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name) ? turn.edits : turn.reads).add(p);
                }
                if (b.name === 'Bash' && typeof inp.command === 'string') {
                    for (const p of bashPaths(inp.command, home)) {
                        s.paths.add(p);
                        turn?.ran.add(p);
                    }
                    if (turn && /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(inp.command)) {
                        pending.set(b.id, { turn, kind: 'commit' });
                        const m = /\s-[a-zA-Z]*m\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(inp.command);
                        const subject = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split('\n')[0].trim();
                        if (subject)
                            turn.commitMsgs.push({ subject, at: d.timestamp ?? turn.at });
                    }
                    if (turn && !/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(inp.command) && /\bgh\s+pr\s+create\b/.test(inp.command))
                        pending.set(b.id, { turn, kind: 'pr' });
                }
            }
        }
    }
    return s;
}
