#!/usr/bin/env node
// Entry point: checks the runtime before anything loads SQLite, then runs main.ts.
// A pipe can be asynchronous (it is on macOS), so process.exit would drop output past 64 KB. This covers every command and hook.
// Node does the same for TTYs and Windows pipes; a file has no handle and is already synchronous.
for (const s of [process.stdout, process.stderr])
    s._handle?.setBlocking?.(true);
// The hooks on most tool calls stop here when they have nothing to do, before SQLite and the store code load.
if (process.argv[2] === 'hook' && ['post', 'read', 'prompt', 'stop', 'stop-failure'].includes(process.argv[3])) {
    const { hookInput, nothingToDo } = await import("./hooks/entry.js");
    if (nothingToDo(process.argv[3], await hookInput())) {
        if (process.env.ANTIGRAVITY_CONVERSATION_ID)
            console.log('{}');
        process.exit(0);
    }
}
const origEmit = process.emitWarning.bind(process);
// Silence only the SQLite ExperimentalWarning.
process.emitWarning = ((w, ...a) => {
    const msg = typeof w === 'string' ? w : w.message;
    if (/SQLite/i.test(msg) && (a[0] === 'ExperimentalWarning' || a[0]?.type === 'ExperimentalWarning'))
        return;
    origEmit(w, ...a);
});
try {
    const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 16))
        throw new Error('old node');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter unicode61')");
    db.close();
}
catch {
    const msg = `Thenwise needs Node 22.16 or later with built-in SQLite; you have ${process.version}. Install a newer Node from https://nodejs.org, then start a new session.`;
    // Hooks stay quiet, except at session start: a system message is what the user sees, the context is what Claude sees.
    if (process.argv[2] === 'hook') {
        if (process.env.ANTIGRAVITY_CONVERSATION_ID)
            console.log(JSON.stringify(process.argv[3] === 'session-start' ? { injectSteps: [{ ephemeralMessage: msg }] } : {}));
        else if (process.argv[3] === 'session-start')
            console.log(JSON.stringify(process.env.COPILOT_PLUGIN_ROOT ? { additionalContext: msg } : { systemMessage: msg, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }));
        process.exit(0);
    }
    console.error(msg);
    process.exit(1);
}
const { cloudWarning, resolveDataDir } = await import("./core/home.js");
const warning = cloudWarning(resolveDataDir());
if (warning)
    console.error(warning);
/** SQLite says only that a file is damaged, never which one. Check the files a command may open (the store, a --db store,
 * the team chat cache, the team server's database) and name each that cannot be read, with advice that fits it. */
async function unreadable(dir) {
    const { existsSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const { flag } = await import("./core/args.js");
    const ok = (f) => {
        try {
            const d = new DatabaseSync(f, { readOnly: true });
            try {
                return d.prepare('PRAGMA quick_check(1)').get()?.quick_check === 'ok';
            }
            finally {
                d.close();
            }
        }
        catch {
            return false;
        }
    };
    const db = flag('db');
    const store = join(dir, 'graph.db');
    const files = [
        [store, ` The store is damaged: delete graph.db in ${dir} and run: thenwise ingest.`],
        ...(db ? [[resolve(db), ` ${db} cannot be read as a Thenwise store. If it is one, it is damaged: delete it and run thenwise ingest --db ${db} to build it again. If you meant another file, point --db at a graph.db.`]] : []),
        [join(dir, 'team-chats.db'), ` The team chat cache ${join(dir, 'team-chats.db')} is damaged: delete it, and the next team sync fetches the chats again.`],
        [join(flag('dir') ?? join(dir, 'team-server'), 'team.db'), ` The team server's database ${join(flag('dir') ?? join(dir, 'team-server'), 'team.db')} is damaged: do not delete it; restore it with thenwise team restore <backup file>.`],
    ];
    const seen = new Set();
    const bad = files.filter(([f]) => !seen.has(f) && seen.add(f) && existsSync(f) && !ok(f));
    return bad.length ? bad.map(([, advice]) => advice).join('') : ' A database file could not be read; thenwise doctor checks the store.';
}
try {
    await import("./main.js");
}
catch (e) {
    // One plain line instead of a stack trace; THENWISE_DEBUG=1 shows the stack.
    const err = e;
    const msg = String(err?.message ?? e).split('\n')[0] ?? '';
    const dir = resolveDataDir();
    const hint = /not a database|malformed|disk image/i.test(msg)
        ? await unreadable(dir)
        : err?.code === 'EACCES' || err?.code === 'EPERM'
            ? ` Check the permissions of ${dir}, or set THENWISE_HOME to a folder you can write.`
            : err?.code === 'ENOTDIR' || err?.code === 'EEXIST' || (err?.code === 'ENOENT' && (await import('node:fs')).statSync(dir, { throwIfNoEntry: false })?.isFile())
                ? ` ${dir} must be a folder: set THENWISE_HOME to a folder.`
                : err?.code === 'ENOENT'
                    ? ` Run thenwise setup first, or check that ${dir} can be created.`
                    : '';
    const { errFields, logger } = await import("./core/log.js");
    logger('cli').error('failed', { cmd: process.argv[2], code: err?.code, ...errFields(e) });
    console.error(`thenwise: ${msg}.${hint}`);
    if (process.env.THENWISE_DEBUG)
        console.error(err?.stack);
    process.exit(1);
}
export {};
