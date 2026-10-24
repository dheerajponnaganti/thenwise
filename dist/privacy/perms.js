// Everything in the data folder is for the user only: folders 0700, files 0600. Runs after each sync and each forget,
// so a file made loose by an older version or by hand is fixed on the next run.
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export function tighten(dir) {
    let fixed = 0;
    const walk = (p) => {
        const st = lstatSync(p);
        if (st.isSymbolicLink())
            return;
        const want = st.isDirectory() ? 0o700 : 0o600;
        if ((st.mode & 0o777) !== want)
            (chmodSync(p, want), fixed++);
        if (st.isDirectory())
            for (const e of readdirSync(p))
                walk(join(p, e));
    };
    try {
        walk(dir);
    }
    catch { }
    return fixed;
}
