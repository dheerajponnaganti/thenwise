// Tokens and memberships (spec 08 §3). Only the SHA-256 hash of a bearer token is stored; the token itself is shown once.
// The admin functions run as the schema owner. The server only calls `verify`, which an unprivileged role may use.

import { randomBytes } from 'node:crypto'

import type { Pool } from 'pg'

import { hashToken } from '../host/token.ts'
import type { Scope } from './pg-store.ts'

export { hashToken }

/** Creates a token for a principal and returns it. It cannot be read back later. */
export async function createToken(pool: Pool, principal: string, label = ''): Promise<string> {
  const token = `mv2_${randomBytes(32).toString('base64url')}`
  await pool.query('insert into tokens (token_hash, principal, label) values ($1, $2, $3)', [hashToken(token), principal, label])

  return token
}

/** Revokes by token or by its hash. Returns false when nothing matched or it was already revoked. */
export async function revokeToken(pool: Pool, tokenOrHash: string): Promise<boolean> {
  const hash = /^[0-9a-f]{64}$/.test(tokenOrHash) ? tokenOrHash : hashToken(tokenOrHash)
  const r = await pool.query('update tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [hash])

  return (r.rowCount ?? 0) > 0
}

export async function addMembership(pool: Pool, principal: string, scope: Scope, role: 'member' | 'admin' = 'member'): Promise<void> {
  await pool.query('insert into scopes (scope_kind, scope_key) values ($1, $2) on conflict do nothing', [scope.kind, scope.key])
  await pool.query('insert into memberships (principal, scope_kind, scope_key, role) values ($1, $2, $3, $4) on conflict (principal, scope_kind, scope_key) do update set role = excluded.role', [principal, scope.kind, scope.key, role])
}

export async function removeMembership(pool: Pool, principal: string, scope: Scope): Promise<void> {
  await pool.query('delete from memberships where principal = $1 and scope_kind = $2 and scope_key = $3', [principal, scope.kind, scope.key])
}

/** The principal behind a live token that is a member of the scope, or null. Safe to call as an unprivileged role. */
export function pgVerifier(pool: Pool, scope: Scope): (tokenHash: string) => Promise<{ id: string } | null> {
  return async tokenHash => {
    const c = await pool.connect()
    try {
      await c.query('begin read only')
      const id = (await c.query<{ p: string | null }>('select memory_verify_token($1) as p', [tokenHash])).rows[0]?.p
      if (!id) return null
      await c.query("select set_config('app.principal', $1, true)", [id])
      const m = await c.query('select 1 from memberships where principal = $1 and scope_kind = $2 and scope_key = $3', [id, scope.kind, scope.key])

      return m.rows[0] ? { id } : null
    } finally {
      await c.query('rollback').catch(() => undefined)
      c.release()
    }
  }
}
