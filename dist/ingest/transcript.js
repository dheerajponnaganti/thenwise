// Parse one (already masked) Claude Code transcript into sessions, turns, compaction summaries and tool facts.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { normPath } from "../core/vault-index.js";
const BASH_PATH = /(?:^|[\s"'=:(])((?:~|\/Users)\/[^\s"'`;|&)<>]+)/g;
const TAGS = 'local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|command-message|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|ide_opened_file|ide_selection|ide_diagnostics';
const WRAPPER = new RegExp(`^<(${TAGS})>[\\s\\S]*?</\\1>\\s*`);
const WRAPPER_OPEN = new RegExp(`^<(${TAGS})>`);
const AGENT_TOOLS = /^(Agent|Task)$/;
const TEST_RUN = /(?:^|[\s;&|(])(?:npm (?:run )?test|node --test|pytest|go test|cargo test|vitest|jest|bun test|pnpm test|yarn test)\b/;
const h = (s) => (typeof s === 'string' ? createHash('sha1').update(s).digest('hex').slice(0, 16) : '');
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
    const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t);
    if (t.startsWith('<') && cmd?.[1]) {
        // A typed slash command: "/review args" is the prompt.
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
        return args ? `${cmd[1]} ${args}` : cmd[1];
    }
    // System and editor wrappers are not prompts; text after them is. Any other "<..." (say "<div>") is the user's.
    for (let m; (m = WRAPPER.exec(t));)
        t = t.slice(m[0].length).trim();
    return !t || WRAPPER_OPEN.test(t) || t.startsWith('[Request interrupted') ? null : t;
}
/** `until` (ISO) drops every entry stamped after it. */
/** `sub`: a subagent file, whose lines are all sidechain and whose turns attach to the parent session `id`. */
export function parseSession(text, id, home, until = '', sub = false) {
    const cut = until ? Date.parse(until) : Infinity;
    const s = { id, cwd: '', entrypoint: '', start: '', end: '', turns: [], summaries: [], paths: new Set(), sub };
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
        if (!d || typeof d !== 'object' || (d.type !== 'user' && d.type !== 'assistant') || (d.isSidechain && !sub))
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
                    if (hit.kind === 'agent')
                        out && (hit.turn.reply.push(out.slice(0, 8000)), hit.turn.agentReports.push(out.slice(0, 8000))); // a subagent's report to the turn that asked
                    else if (hit.kind === 'test')
                        hit.turn.tests.push({ at: hit.at ?? hit.turn.at, failed: b.is_error === true });
                    else if (hit.kind === 'commit')
                        for (const m of out.matchAll(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g))
                            hit.turn.commitShas.add(m[1]);
                    else
                        for (const m of out.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g))
                            hit.turn.prUrls.add(m[0]);
                }
            }
            const p = d.isMeta ? null : promptText(content);
            if (p && typeof d.uuid === 'string') {
                turn = { id: d.uuid, at: d.timestamp ?? '', prompt: p, reply: [], agentReports: [], reads: new Set(), edits: new Set(), ran: new Set(), commitMsgs: [], commitShas: new Set(), prUrls: new Set(), changes: [], tests: [] };
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
                    const at = d.timestamp ?? turn?.at ?? '';
                    if (turn && b.name === 'Edit')
                        turn.changes.push({ file: p, oldHash: h(inp.old_string), newHash: h(inp.new_string), at });
                    if (turn && b.name === 'MultiEdit' && Array.isArray(inp.edits))
                        for (const e of inp.edits)
                            turn.changes.push({ file: p, oldHash: h(e?.old_string), newHash: h(e?.new_string), at });
                    if (turn && b.name === 'Write')
                        turn.changes.push({ file: p, oldHash: '', newHash: h(inp.content), at });
                }
                if (turn && AGENT_TOOLS.test(b.name))
                    pending.set(b.id, { turn, kind: 'agent' });
                if (b.name === 'Bash' && typeof inp.command === 'string') {
                    for (const p of bashPaths(inp.command, home)) {
                        s.paths.add(p);
                        turn?.ran.add(p);
                    }
                    if (turn && TEST_RUN.test(inp.command))
                        pending.set(b.id, { turn, kind: 'test', at: d.timestamp ?? turn.at });
                    if (turn && /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(inp.command)) {
                        pending.set(b.id, { turn, kind: 'commit' });
                        const m = /\s-[a-zA-Z]*m\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(inp.command);
                        const msg = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split('\n');
                        // -m "$(cat <<'EOF' ... EOF)": the subject is the first line after the heredoc opener.
                        const subject = (/^\$\(cat\s*<</.test(msg[0]) ? (msg.slice(1).find((l) => l.trim()) ?? '') : msg[0]).trim();
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
