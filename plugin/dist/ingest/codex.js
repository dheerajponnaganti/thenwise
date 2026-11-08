// OpenAI Codex: its chats (sessions/YYYY/MM/DD/rollout-*.jsonl) in Claude Code's transcript shape, so one pipeline
// (masking, [no-memory], forget, search) serves them too. Codex's own files are only ever read.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asClaudeTool, projectKey } from "./copilot.js";
export const CODEX_ENTRYPOINT = 'codex-cli';
export const codexDir = (home) => process.env.CODEX_HOME || join(home, '.codex');
// Codex puts its own context into user messages, each part starting with a tag. Only the rest was typed by the person.
const INJECTED = /^\s*(<\/?(environment_context|skill|image|user_shell_command|turn_aborted|subagent_notification|user_instructions|external_[a-z_]*)\b|# AGENTS\.md instructions for )/;
const textOf = (content, kind) => (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === kind && typeof c.text === 'string' && !(kind === 'input_text' && INJECTED.test(c.text)))
    .map((c) => c.text)
    .join('\n');
/** The command a shell item ran: Codex stores ["/bin/zsh", "-lc", "the command"]. */
const shellText = (command) => (Array.isArray(command) ? String(command.at(-1) ?? '') : String(command ?? ''));
/** Current Codex writes folders as file:/// URLs, older files as plain paths. A URL that names no local file stays out. */
const localPath = (p) => {
    if (!p.startsWith('file:'))
        return p;
    try {
        return fileURLToPath(p);
    }
    catch {
        return '';
    }
};
const resolvePath = (cwd, path) => {
    const p = localPath(path);
    return isAbsolute(p) ? p : join(localPath(cwd), p);
};
/** One finished command: a plain read of files links those files, anything else is a shell command. */
function commandTools(item) {
    const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
    const reads = parsed.length && parsed.every((p) => p?.type === 'read' && typeof p.path === 'string');
    if (reads)
        return parsed.map((p, j) => ({ type: 'tool_use', id: `${item.id}#${j}`, name: 'Read', input: { file_path: resolvePath(item.cwd ?? '', p.path) } }));
    return [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: shellText(item.command) } }];
}
/** One finished file change: each file becomes a Write or an Edit, as an apply_patch would. */
function fileTools(item) {
    return Object.entries((item.changes ?? {})).map(([key, c], j) => {
        const path = localPath(key);
        if (c?.type === 'add')
            return { type: 'tool_use', id: `${item.id}#${j}`, name: 'Write', input: { file_path: path, content: c.content ?? '' } };
        const lines = String(c?.unified_diff ?? c?.content ?? '').split('\n');
        const pick = (mark) => lines.filter((l) => l.startsWith(mark) && !l.startsWith(mark.repeat(3))).map((l) => l.slice(1)).join('\n');
        return { type: 'tool_use', id: `${item.id}#${j}`, name: 'Edit', input: { file_path: path, old_string: pick('-'), new_string: pick('+') } };
    });
}
/** Turns one rollout line into Claude Code transcript lines: prompts, replies, tool calls and their results. The model's
 * reasoning (encrypted) and settings are left out; token counts become cost rows. Current files report tools as `item_completed` events;
 * older ones as `function_call` items, so both are read and neither appears twice in one file.
 * shortcut: a rollback inside a file (`thread_rolled_back`) keeps the withdrawn turns; no file here has one, drop them when one shows up. */
export function codexConverter(sessionId, cwd) {
    let n = 0;
    return (line) => {
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            return [line]; // kept as masked plain text, like any unreadable line
        }
        n++;
        const p = d?.payload ?? {};
        if ((d?.type === 'session_meta' || d?.type === 'turn_context') && typeof p.cwd === 'string')
            cwd = localPath(p.cwd);
        const row = (type, content, more = {}) => JSON.stringify({ type, uuid: `${sessionId}:${d.ordinal ?? n}`, timestamp: d.timestamp, cwd, sessionId, entrypoint: CODEX_ENTRYPOINT, ...more, message: { role: type, content } });
        if (d?.type === 'response_item' && p.type === 'message') {
            if (p.role === 'user') {
                const text = textOf(p.content, 'input_text');
                return text ? [row('user', text)] : [];
            }
            const text = p.role === 'assistant' ? textOf(p.content, 'output_text') : '';
            return text ? [row('assistant', [{ type: 'text', text }])] : [];
        }
        // Codex's running token total, as the cost row the parser reads (Codex records tokens, not dollars).
        if (d?.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
            const t = p.info.total_token_usage;
            const num = (v) => (typeof v === 'number' ? v : 0);
            return [JSON.stringify({ type: 'cost-state', sessionId, timestamp: d.timestamp, tokens: { input: Math.max(0, num(t.input_tokens) - num(t.cached_input_tokens)), cached: num(t.cached_input_tokens), output: num(t.output_tokens) } })];
        }
        if (d?.type === 'compacted')
            return typeof p.message === 'string' && p.message ? [row('user', p.message, { isCompactSummary: true })] : []; // remote compaction is encrypted
        // Older files: the call and its output are separate lines.
        if (d?.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
            let tools = [];
            if (p.name === 'apply_patch')
                tools = asClaudeTool('apply_patch', p.input ?? p.arguments);
            else if (p.name === 'exec_command' || p.name === 'shell') {
                let args = {};
                try {
                    args = JSON.parse(p.arguments ?? '{}');
                }
                catch { } // unreadable arguments still mark that a command ran
                tools = [{ name: 'Bash', input: { command: args.cmd ?? shellText(args.command) } }];
            }
            else if (/^mcp__/.test(p.name ?? ''))
                tools = [{ name: p.name, input: {} }];
            if (!tools.length)
                return []; // `exec` wraps the tools reported below, and wait or sleep say nothing
            return [row('assistant', tools.map((t, j) => ({ type: 'tool_use', id: j ? `${p.call_id}#${j}` : p.call_id, ...t })))];
        }
        if (d?.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
            const out = typeof p.output === 'string' ? p.output : '';
            return out && p.name !== 'exec' ? [row('user', [{ type: 'tool_result', tool_use_id: p.call_id, content: out }])] : [];
        }
        if (d?.type === 'event_msg' && p.type === 'item_completed') {
            const item = p.item ?? {};
            if (item.type === 'CommandExecution') {
                const tools = commandTools(item);
                if (item.cwd && typeof item.cwd === 'string')
                    cwd = localPath(item.cwd);
                // One command can read several files: each read gets a result, the first one carrying the output.
                const failed = typeof item.exit_code === 'number' && item.exit_code !== 0;
                return [row('assistant', tools), row('user', tools.map((t, j) => ({ type: 'tool_result', tool_use_id: t.id, content: j ? '' : String(item.aggregated_output ?? ''), is_error: failed })))];
            }
            // A completed item is a finished step: each call gets its result row, so none reads as a step the chat stopped in.
            const done = (tools) => row('user', tools.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: '' })));
            if (item.type === 'FileChange') {
                const tools = fileTools(item);
                return tools.length ? [row('assistant', tools), done(tools)] : [];
            }
            if (item.type === 'McpToolCall') {
                const tools = [{ type: 'tool_use', id: String(item.id), name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }];
                return [row('assistant', tools), done(tools)];
            }
        }
        return [];
    };
}
/** The first line of a rollout: session_meta, small enough to read without the rest of a long file. */
function metaOf(path) {
    const fd = openSync(path, 'r');
    try {
        const buf = Buffer.alloc(1 << 20);
        const got = readSync(fd, buf, 0, buf.length, 0);
        const end = buf.subarray(0, got).indexOf(10);
        const d = JSON.parse(buf.subarray(0, end < 0 ? got : end).toString('utf8'));
        return d?.type === 'session_meta' ? d.payload : undefined;
    }
    catch {
        return undefined; // not a rollout, or being written: the next sync reads it
    }
    finally {
        closeSync(fd);
    }
}
function rollouts(dir, out) {
    if (!existsSync(dir))
        return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory())
            rollouts(join(dir, e.name), out);
        // shortcut: compressed .jsonl.zst rollouts are skipped, Node 22 cannot read zstd; add them once Node 22 support ends.
        else if (/^rollout-.*\.jsonl$/.test(e.name))
            out.push(join(dir, e.name));
    }
    return out;
}
/** Chats /import copied in from Claude Code or Cursor: those chats are already remembered from their own files. */
function importedIds(root) {
    try {
        return new Set(readFileSync(join(root, 'external_agent_session_imports.json'), 'utf8').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
    }
    catch {
        return new Set();
    }
}
/** Codex chats as archive sources: rel is `<project key>/<thread id>.jsonl`, in the same project as Claude Code's chats of
 * that folder. Subagent threads are left out: their report reaches the main chat. A thread reverted into a new file, or one
 * in both folders, counts once: the newest file. */
export function codexSources(home) {
    const root = codexDir(home);
    const imported = importedIds(root);
    const newest = new Map();
    for (const path of [...rollouts(join(root, 'sessions'), []), ...rollouts(join(root, 'archived_sessions'), [])]) {
        const meta = metaOf(path);
        if (!meta || typeof meta.id !== 'string' || typeof meta.cwd !== 'string')
            continue;
        const cwd = localPath(meta.cwd);
        if (!cwd)
            continue;
        if (imported.has(meta.id) || (meta.thread_source ?? 'user') !== 'user' || (meta.source && typeof meta.source === 'object'))
            continue;
        const at = statSync(path).mtimeMs;
        if ((newest.get(meta.id)?.at ?? -1) < at)
            newest.set(meta.id, { rel: `${projectKey(cwd)}/${meta.id}.jsonl`, path, id: meta.id, cwd, at });
    }
    return [...newest.values()].map(({ at: _at, ...s }) => s);
}
/** Whether Codex trusts Thenwise's hooks: true or false when the plugin is in Codex's config, undefined when it is not
 * installed there. Codex runs plugin hooks only after the person trusts them in /hooks, and asks again after each update.
 * shortcut: reads Codex's [hooks.state] keys as seen in 0.164 (`thenwise@<marketplace>:hooks/codex.json:...`), undocumented. */
export function codexHooksTrusted(home) {
    let toml = '';
    try {
        toml = readFileSync(join(codexDir(home), 'config.toml'), 'utf8');
    }
    catch {
        return undefined;
    }
    if (!/^\[plugins\."thenwise@[^"]+"\]/m.test(toml))
        return undefined;
    return /^\[hooks\.state\."thenwise@[^"]+:hooks\/codex\.json:session_start[^"]*"\]/m.test(toml);
}
