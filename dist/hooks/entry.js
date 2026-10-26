// The first stop for the hooks that fire on most tool calls (read, post): decides from the hook input alone whether
// there is anything to do, before the CLI loads SQLite and the store code. Imports nothing but node:fs and node:path.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** The planning-with-files plan files. */
export const STEMS = ['task_plan', 'findings', 'progress'];
/** Commands that print a file, so a plain `cat src/x.ts` gets the same history hint as Read. */
export const READERS = /^(?:cat|head|tail|less|bat|sed)$/;
export const hasPlanFiles = (cwd) => STEMS.some((s) => existsSync(join(cwd, `${s}.md`))) || existsSync(join(cwd, '.planning'));
let input;
/** The hook's stdin as JSON, read once: the quick check and the hook itself share it. */
export async function hookInput() {
    if (input)
        return input;
    let raw = '';
    for await (const d of process.stdin)
        raw += d;
    try {
        input = JSON.parse(raw || '{}');
    }
    catch {
        input = {};
    }
    return input;
}
/** True when the hook has nothing to do: a Read hook for another tool, or a Bash command that prints no single file,
 * run in a folder with no plan files. Anything else goes on to the full hook, which decides exactly. */
export function nothingToDo(name, i) {
    if (name === 'read')
        return i.tool_name !== 'Read' || typeof i.tool_input?.file_path !== 'string';
    if (name !== 'post' || i.tool_name !== 'Bash')
        return false;
    const cmd = i.tool_input?.command;
    if (typeof cmd !== 'string' || !i.cwd)
        return true;
    const first = cmd.trim().split(/\s+/)[0].split('/').pop();
    const mayRead = READERS.test(first) && !/[|;&<>`$()\n]/.test(cmd);
    return !mayRead && !hasPlanFiles(String(i.cwd));
}
