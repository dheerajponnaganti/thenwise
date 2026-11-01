#!/usr/bin/env node
// Entry point: checks the runtime before anything loads SQLite, then runs main.ts.
// The hooks on most tool calls stop here when they have nothing to do, before SQLite and the store code load.
if (process.argv[2] === 'hook' && ['post', 'read', 'prompt'].includes(process.argv[3])) {
    const { hookInput, nothingToDo } = await import("./hooks/entry.js");
    if (nothingToDo(process.argv[3], await hookInput()))
        process.exit(0);
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
    const msg = `Thenwise needs Node 22.16 or later with built-in SQLite; you have ${process.version}.`;
    // Hooks stay quiet, except at session start, where stdout reaches the chat once.
    if (process.argv[2] === 'hook') {
        if (process.argv[3] === 'session-start')
            console.log(msg);
        process.exit(0);
    }
    console.error(msg);
    process.exit(1);
}
const { cloudWarning, resolveDataDir } = await import("./core/home.js");
const warning = cloudWarning(resolveDataDir());
if (warning)
    console.error(warning);
try {
    await import("./main.js");
}
catch (e) {
    // One plain line instead of a stack trace; THENWISE_DEBUG=1 shows the stack.
    const err = e;
    const msg = String(err?.message ?? e).split('\n')[0] ?? '';
    const dir = resolveDataDir();
    const hint = /not a database|malformed|disk image/i.test(msg)
        ? ` The store is damaged: delete graph.db in ${dir} and run: thenwise ingest`
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
