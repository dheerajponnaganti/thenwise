// `memory import <vault> --postgres`: loads a Markdown vault into a Postgres scope (spec 04 §6).
// The vault is parsed by the Files index, so ids, links and hubs resolve exactly as in Files mode.
import { resolve } from 'node:path';
import { DEFAULT_CONFIG } from "../core/vault-index.js";
import { nodeIO } from "../host/node-io.js";
import { FilesStore } from "../store-files/files-store.js";
import { PgStore } from "./pg-store.js";
export async function importVault(pool, scope, vault, opts = {}) {
    const files = new FilesStore(opts.io ?? nodeIO, opts.io ? vault : resolve(vault), null, { hubs: opts.hubs ?? DEFAULT_CONFIG.hubs });
    const opened = await files.open();
    const loaded = await new PgStore(pool, scope, opts).importIndex(files.index);
    return { files: opened.files, ...loaded };
}
