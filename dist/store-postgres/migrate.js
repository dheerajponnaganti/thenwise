// Numbered, idempotent migrations (spec 04 §5). Migration 0001 is schema.sql; later ones are 0002_*.sql files beside it.
import { readFileSync } from 'node:fs';
const here = (f) => new URL(f, import.meta.url);
export const MIGRATIONS = [{ id: '0001_init', file: here('./schema.sql') }];
/** Applies the migrations that are not recorded yet, in order, each in its own transaction. Returns the ids applied. */
export async function migrate(pool) {
    const client = await pool.connect();
    const applied = [];
    try {
        // One migrator at a time; a second caller waits and then finds nothing to do.
        await client.query('select pg_advisory_lock(hashtext($1))', ['memory-v2-migrate']);
        await client.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
        const done = new Set((await client.query('select id from schema_migrations')).rows.map(r => r.id));
        for (const m of MIGRATIONS) {
            if (done.has(m.id))
                continue;
            await client.query('begin');
            try {
                await client.query(readFileSync(m.file, 'utf8'));
                await client.query('insert into schema_migrations (id) values ($1)', [m.id]);
                await client.query('commit');
                applied.push(m.id);
            }
            catch (e) {
                await client.query('rollback');
                throw e;
            }
        }
    }
    finally {
        await client.query('select pg_advisory_unlock(hashtext($1))', ['memory-v2-migrate']).catch(() => undefined);
        client.release();
    }
    return applied;
}
/** Lets an unprivileged role use the store under row-level security. Run as the schema owner. */
export async function grantApp(pool, role) {
    const r = `"${role.replace(/"/g, '""')}"`;
    await pool.query(`grant select, insert, update, delete on nodes, edges, sources, match_keys, episodes, scopes to ${r};
     grant select, insert on events to ${r};
     grant usage on all sequences in schema public to ${r};
     grant select on memberships to ${r};
     grant execute on function memory_verify_token(text) to ${r}`);
}
