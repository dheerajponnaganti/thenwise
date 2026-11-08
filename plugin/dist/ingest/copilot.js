// GitHub Copilot CLI: its chats (session-state/<id>/events.jsonl) and its hook payloads, in Claude Code's shapes, so one
// pipeline (masking, [no-memory], forget, search) serves both. Copilot's own files are only ever read.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const COPILOT_ENTRYPOINT = 'copilot-cli';
export const copilotDir = (home) => process.env.COPILOT_HOME || join(home, '.copilot');
// Claude Code names a project folder by its path with every other character turned into "-"; Copilot chats join the same key.
export const projectKey = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-');
/** `apply_patch` sends one patch text for many files: each file becomes an Edit (or a Write for a new file). */
function patchTools(patch) {
    const files = [];
    for (const line of patch.split('\n')) {
        const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
        if (m)
            files.push({ kind: m[1], path: m[2].trim(), del: [], add: [] });
        else if (files.length && !line.startsWith('***')) {
            if (line.startsWith('-'))
                files.at(-1).del.push(line.slice(1));
            else if (line.startsWith('+'))
                files.at(-1).add.push(line.slice(1));
        }
    }
    return files.map((f) => (f.kind === 'Add' ? { name: 'Write', input: { file_path: f.path, content: f.add.join('\n') } } : { name: 'Edit', input: { file_path: f.path, old_string: f.del.join('\n'), new_string: f.add.join('\n') } }));
}
/** A Copilot tool call as the Claude Code tool it matches (view is Read, bash is Bash and so on); other tools keep their name. */
export function asClaudeTool(name, args) {
    // With a Claude-format hooks file apply_patch arrives named Edit, its text unchanged.
    if (typeof args === 'string' && (name === 'apply_patch' || args.includes('*** Begin Patch')))
        return patchTools(args);
    const a = (args && typeof args === 'object' ? args : {});
    // Antigravity: names vary by version, so both generations are mapped.
    if (name === 'read_file' || name === 'view_file')
        return [{ name: 'Read', input: { file_path: a.Path ?? a.AbsolutePath ?? a.TargetFile } }];
    if (name === 'edit_file' || name === 'replace_file_content' || name === 'multi_replace_file_content')
        return [{ name: 'Edit', input: { file_path: a.Path ?? a.TargetFile, old_string: a.Target ?? a.TargetContent, new_string: a.Replacement ?? a.ReplacementContent } }];
    if (name === 'write_file' || name === 'write_to_file')
        return [{ name: 'Write', input: { file_path: a.Path ?? a.TargetFile, content: a.Content ?? a.CodeContent } }];
    if (name === 'run_command')
        return [{ name: 'Bash', input: { command: a.CommandLine } }];
    if (name === 'call_mcp_tool')
        return [{ name: `mcp__${a.ServerName}__${a.ToolName}`, input: a.Arguments ?? {} }];
    if (name === 'view')
        return [{ name: 'Read', input: { file_path: a.path } }];
    if (name === 'edit')
        return [{ name: 'Edit', input: { file_path: a.path, old_string: a.old_str, new_string: a.new_str } }];
    if (name === 'create')
        return [{ name: 'Write', input: { file_path: a.path, content: a.file_text } }];
    if (name === 'bash' || name === 'powershell')
        return [{ name: 'Bash', input: { command: a.command } }];
    if (name === 'grep' || name === 'rg')
        return [{ name: 'Grep', input: a }];
    if (name === 'glob')
        return [{ name: 'Glob', input: a }];
    if (name === 'str_replace_editor') {
        if (a.command === 'view')
            return asClaudeTool('view', a);
        if (a.command === 'create')
            return asClaudeTool('create', a);
        return asClaudeTool('edit', a);
    }
    return [{ name, input: a }];
}
/** A hook payload in Claude Code's fields and tool names. Claude Code's own payloads come back as they were. */
export function claudeHookInput(raw) {
    // Antigravity: camelCase, its folders as a list, and the prompt on every model call of a turn: only the first one counts.
    if (raw.conversationId !== undefined) {
        const { toolCall, invocationNum, lastUserInput, workspacePaths, transcriptPath, conversationId } = raw;
        raw = { session_id: conversationId, cwd: Array.isArray(workspacePaths) ? (workspacePaths[0] ?? '') : '', source: 'startup', transcript_path: transcriptPath, ...(invocationNum ? {} : { prompt: lastUserInput }), ...(toolCall ? { tool_name: toolCall.name, tool_input: toolCall.args } : {}), ...(raw.fullyIdle === false ? { fullyIdle: false } : {}) };
    }
    // Copilot's own payloads say sessionId; with a Claude-format hooks file it may send either.
    let i = raw.session_id === undefined && raw.sessionId !== undefined ? { ...raw, session_id: raw.sessionId } : raw;
    // Copilot starts a fresh session with source "new" where Claude Code says "startup".
    if (i.source === 'new')
        i = { ...i, source: 'startup' };
    const name = i.tool_name ?? i.toolName;
    if (typeof name !== 'string')
        return i;
    let args = i.tool_input ?? i.toolArgs;
    // Codex hands a patch as { command: <patch text> }.
    if (name === 'apply_patch' && typeof args?.command === 'string')
        args = args.command;
    if (typeof args === 'string' && name !== 'apply_patch') {
        try {
            args = JSON.parse(args); // Copilot sends toolArgs as JSON text
        }
        catch { }
    }
    // shortcut: a hook sees only the first file of a patch that touches several, read chats still link them all; hooks can't answer per file.
    const t = asClaudeTool(name, args)[0];
    // With a Claude-format hooks file Copilot renames the tool (view arrives as Read) but keeps its own argument names.
    const a = { ...(t?.input ?? {}) };
    for (const [from, to] of [['path', 'file_path'], ['old_str', 'old_string'], ['new_str', 'new_string'], ['file_text', 'content']])
        if (a[to] === undefined && a[from] !== undefined)
            a[to] = a[from];
    // The patch stays beside the first file, so the pre-edit hook can hint every file it names.
    return { ...i, tool_name: t?.name ?? name, tool_input: a, ...(name === 'apply_patch' && typeof args === 'string' ? { patch: args } : {}) };
}
/** Turns one Copilot events.jsonl line into Claude Code transcript lines: prompts, replies, tool calls and their results.
 * Everything else (hooks, usage, model routing, skill and system text, encrypted reasoning) is left out. */
export function copilotConverter(sessionId, cwd) {
    return (line) => {
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            return [line]; // kept as masked plain text, like any unreadable line
        }
        const x = d?.data ?? {};
        if (d?.type === 'session.start' && typeof x.context?.cwd === 'string')
            cwd = x.context.cwd;
        // A subagent's events share the file; its report reaches the main chat through the task tool's result.
        if (d?.agentId || x.parentToolCallId)
            return []; // older files mark it only with parentToolCallId
        const row = (type, content, more = {}) => JSON.stringify({ type, uuid: d.id, timestamp: d.timestamp, cwd, sessionId, entrypoint: COPILOT_ENTRYPOINT, ...more, message: { role: type, content } });
        // Messages a skill, an agent or autopilot added are not the person's prompts.
        if (d?.type === 'user.message' && typeof x.content === 'string')
            return x.source || x.isAutopilotContinuation ? [] : [row('user', x.content)];
        if (d?.type === 'session.compaction_complete' && typeof x.summaryContent === 'string' && x.summaryContent)
            return [row('user', x.summaryContent, { isCompactSummary: true })];
        if (d?.type === 'assistant.message') {
            const calls = Array.isArray(x.toolRequests) ? x.toolRequests : [];
            const blocks = [
                ...(typeof x.content === 'string' && x.content ? [{ type: 'text', text: x.content }] : []),
                ...calls.flatMap((r) => asClaudeTool(String(r?.name), r?.arguments).map((t, j) => ({ type: 'tool_use', id: j ? `${r.toolCallId}#${j}` : r.toolCallId, ...t }))),
            ];
            return blocks.length ? [row('assistant', blocks)] : [];
        }
        if (d?.type === 'session.task_complete' && typeof x.summary === 'string' && x.summary)
            return [row('assistant', [{ type: 'text', text: x.summary }])];
        // Copilot stopped the turn: an abort (a credit limit, a remote stop) or a shutdown on an error. Claude Code writes such a stop
        // as an assistant row marked isApiErrorMessage, so both reach the parser the same way.
        const stop = d?.type === 'abort' ? String(x.reason ?? 'aborted') : d?.type === 'session.shutdown' && x.shutdownType === 'error' ? `an error${x.errorReason ? `: ${x.errorReason}` : ''}` : '';
        if (stop)
            return [row('assistant', [{ type: 'text', text: stop }], { isApiErrorMessage: true })];
        if (d?.type === 'tool.execution_complete') {
            const out = typeof x.result?.content === 'string' ? x.result.content : '';
            // A shell call that ran is `success: true` whatever its command did; the command's own result is its exit code.
            const failed = x.success === false || (typeof x.shellExecution?.exitCode === 'number' && x.shellExecution.exitCode !== 0);
            return [row('user', [{ type: 'tool_result', tool_use_id: x.toolCallId, content: out, is_error: failed }])];
        }
        return [];
    };
}
/** The project of the running Copilot session. Its MCP servers start in the plugin folder and get no project variable, only this session id. */
export function copilotSessionCwd(home, id = process.env.COPILOT_AGENT_SESSION_ID) {
    return id && !/[\\/]/.test(id) ? workspaceCwd(join(copilotDir(home), 'session-state', id, 'workspace.yaml')) : '';
}
/** The folder a Copilot chat ran in, from its workspace.yaml (a flat file: one `cwd:` line). */
function workspaceCwd(file) {
    try {
        const m = /^cwd:[ \t]*(.+)$/m.exec(readFileSync(file, 'utf8'));
        const v = m?.[1]?.trim() ?? '';
        return v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v.startsWith('"') ? JSON.parse(v) : v;
    }
    catch {
        return '';
    }
}
/** Copilot CLI chats as archive sources: rel is `<project key>/<session id>.jsonl`, the key made from the chat's folder. */
export function copilotSources(home) {
    const root = join(copilotDir(home), 'session-state');
    if (!existsSync(root))
        return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((e) => {
        const path = join(root, e.name, 'events.jsonl');
        const cwd = e.isDirectory() && existsSync(path) ? workspaceCwd(join(root, e.name, 'workspace.yaml')) : '';
        return cwd ? [{ rel: `${projectKey(cwd)}/${e.name}.jsonl`, path, id: e.name, cwd }] : [];
    });
}
