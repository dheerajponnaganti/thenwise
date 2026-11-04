// `thenwise connect <tool>`: adds the memory tools to another coding tool through its MCP config, so that tool can read
// this memory and whatever a team shared into it. It reads only: chats from those tools are not captured.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const TOOLS = ['codex', 'cursor', 'gemini', 'opencode'];
/** Full paths, because a desktop app's PATH often has no node. The server command: this Node and this package. */
export function serverCommand(node = process.execPath, cli = realpathSync(process.argv[1])) {
    return [node, [cli, 'mcp']];
}
const fileOf = (tool, home, env) => tool === 'codex' ? join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
    : tool === 'cursor' ? join(home, '.cursor', 'mcp.json')
        : tool === 'gemini' ? join(home, '.gemini', 'settings.json')
            : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json');
/** The entry in each tool's own JSON shape. Cursor starts servers outside the project, so it is told the folder. */
function jsonEntry(tool, [command, args], extra) {
    if (tool === 'opencode')
        return ['mcp', { type: 'local', command: [command, ...args], ...(Object.keys(extra).length ? { environment: extra } : {}) }];
    const env = tool === 'cursor' ? { ...extra, THENWISE_PROJECT: '${workspaceFolder}' } : extra;
    return ['mcpServers', { command, args, ...(Object.keys(env).length ? { env } : {}) }];
}
const tomlString = (s) => JSON.stringify(s);
const TOML_BLOCK = /^\[mcp_servers\.thenwise(\.[^\]]*)?\]\n(?:(?!\[)[^\n]*\n?)*/gm;
function tomlBlock([command, args], extra) {
    const env = Object.entries(extra).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
    return `[mcp_servers.thenwise]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n${env ? `env = { ${env} }\n` : ''}`;
}
/** What connecting (or with remove, disconnecting) would do. Writes nothing. */
export function plan(tool, opts = {}) {
    const env = opts.env ?? process.env;
    const file = fileOf(tool, opts.home ?? homedir(), env);
    const command = opts.command ?? serverCommand();
    const extra = env.THENWISE_HOME ? { THENWISE_HOME: env.THENWISE_HOME } : {};
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (tool === 'codex') {
        const block = tomlBlock(command, extra);
        const without = before.replace(TOML_BLOCK, '');
        const had = without !== before;
        if (opts.remove)
            return { file, snippet: block, next: had ? without.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') : null, note: had ? 'removed' : 'not connected' };
        if (before.includes(block))
            return { file, snippet: block, next: null, note: 'already connected' };
        const base = without.replace(/\s*$/, '');
        return { file, snippet: block, next: `${base ? `${base}\n\n` : ''}${block}`, note: 'connected' };
    }
    const [key, entry] = jsonEntry(tool, command, extra);
    const snippet = JSON.stringify({ [key]: { thenwise: entry } }, null, 2);
    let config;
    try {
        config = before.trim() ? JSON.parse(before) : {};
        if (!config || typeof config !== 'object' || Array.isArray(config))
            throw new Error('not an object');
    }
    catch {
        // Comments or a mistake in the file: rewriting it would lose them, so it stays the user's to edit.
        return { file, snippet, next: null, note: 'cannot read this file as plain JSON, so it was left alone; add the entry by hand' };
    }
    const servers = config[key] && typeof config[key] === 'object' ? config[key] : {};
    if (opts.remove) {
        if (!servers.thenwise)
            return { file, snippet, next: null, note: 'not connected' };
        delete servers.thenwise;
        return { file, snippet, next: `${JSON.stringify({ ...config, [key]: servers }, null, 2)}\n`, note: 'removed' };
    }
    if (JSON.stringify(servers.thenwise) === JSON.stringify(entry))
        return { file, snippet, next: null, note: 'already connected' };
    return { file, snippet, next: `${JSON.stringify({ ...config, [key]: { ...servers, thenwise: entry } }, null, 2)}\n`, note: 'connected' };
}
export function apply(p) {
    if (p.next === null)
        return;
    mkdirSync(dirname(p.file), { recursive: true });
    const tmp = `${p.file}.thenwise-tmp`;
    writeFileSync(tmp, p.next, { mode: 0o600 });
    renameSync(tmp, p.file);
}
