// A throwaway Postgres cluster for tests: own data dir, own port, unix socket only. It never touches another server.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import pg from 'pg'

const BIN = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin'

export const pgAvailable = existsSync(join(BIN, 'initdb')) && existsSync(join(BIN, 'pg_ctl'))
/** Pass as `{ skip }` to a test or suite so a missing server says why. */
export const pgSkip = pgAvailable ? false : `Postgres binaries not found in ${BIN} (set PG_BIN); Postgres-backed tests skipped`

export interface PgCluster {
  /** Connection config for a database on this cluster. */
  config(database?: string, user?: string): pg.PoolConfig
  /** Creates a database as a copy of `template` (default: template1) and returns its name. */
  createDb(template?: string): Promise<string>
  dropDb(name: string): Promise<void>
  /** A superuser client on the maintenance database. */
  admin(): pg.Pool
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 55000 + Math.floor(Math.random() * 10000)
    const ok = await new Promise<boolean>(res => {
      const s = createServer()
      s.once('error', () => res(false))
      s.listen(port, '127.0.0.1', () => s.close(() => res(true)))
    })
    if (ok) return port
  }
  throw new Error('no free port above 55000')
}

const run = (bin: string, args: string[]) => execFileSync(join(BIN, bin), args, { stdio: ['ignore', 'pipe', 'pipe'] })

export async function startCluster(): Promise<PgCluster> {
  if (!pgAvailable) throw new Error(pgSkip as string)
  const dir = mkdtempSync(join(tmpdir(), 'memv2pg-'))
  const data = join(dir, 'data')
  const port = await freePort()
  let started = false
  const cleanup = () => {
    if (started) {
      try {
        run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'])
      } catch {
        // already stopped
      }
      started = false
    }
    rmSync(dir, { recursive: true, force: true })
  }
  // A crashed test run must not leave a server behind.
  process.once('exit', cleanup)
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync', '-E', 'UTF8', '--locale=C'])
    // listen_addresses='' keeps the server off the network: the port only names the socket file.
    run('pg_ctl', ['-D', data, '-w', '-l', join(dir, 'log'), '-o', `-p ${port} -c listen_addresses='' -c unix_socket_directories='${dir}' -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, 'start'])
    started = true
  } catch (e) {
    cleanup()
    throw e
  }
  const pools: pg.Pool[] = []
  const config = (database = 'postgres', user = 'postgres'): pg.PoolConfig => ({ host: dir, port, user, database, max: 4 })
  const admin = new pg.Pool(config())
  pools.push(admin)
  let n = 0

  return {
    config,
    admin: () => admin,
    async createDb(template = 'template1') {
      const name = `t${++n}_${Math.random().toString(36).slice(2, 8)}`
      await admin.query(`create database ${name} template ${template}`)

      return name
    },
    async dropDb(name) {
      await admin.query(`drop database if exists ${name} with (force)`)
    },
    async stop() {
      await Promise.all(pools.map(p => p.end().catch(() => undefined)))
      cleanup()
    },
  }
}
