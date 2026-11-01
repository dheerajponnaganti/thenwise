// The daily version check. One GET to npm from the background sync, sending no version, id or project data.
// Search, MCP tools and foreground hooks never touch the network: the session-start hook only reads the saved answer.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logger } from '../core/log.ts'
import type { Config } from '../ingest/config.ts'

const LATEST = 'https://registry.npmjs.org/thenwise/latest'
const DAY = 864e5
const RELEASES = 'https://github.com/dheerajponnaganti/thenwise/releases/tag'
export const OFF_LINE = 'Turn this off with: thenwise update-check off'

interface UpdateState {
  checked?: number
  latest?: string
  notified?: string
  ran?: string
}

export const runningVersion = (): string => JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

const stateFile = (dir: string) => join(dir, 'update-check.json')
function readState(dir: string): UpdateState {
  try {
    return JSON.parse(readFileSync(stateFile(dir), 'utf8'))
  } catch {
    return {}
  }
}
const saveState = (dir: string, s: UpdateState) => writeFileSync(stateFile(dir), JSON.stringify(s), { mode: 0o600 })

/** Above zero when `a` is the newer version. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))

  return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!
}

export const checkEnabled = (cfg: Pick<Config, 'off' | 'updateCheck'>): boolean => cfg.updateCheck && !cfg.off && !process.env.THENWISE_NO_UPDATE_CHECK

/** Asks npm for the latest version. Only a plain version number is kept from the answer, so it can never carry text to Claude. A failure is silent. */
export async function checkForUpdate(cfg: Config, opts: { daily?: boolean; now?: number; url?: string; timeoutMs?: number } = {}): Promise<string | undefined> {
  const now = opts.now ?? Date.now()
  const s = readState(cfg.memDir)
  if (!checkEnabled(cfg) || (opts.daily && s.checked && now - s.checked < DAY)) return undefined
  const log = logger('update', cfg.memDir)
  let latest: string | undefined
  try {
    const res = await fetch(opts.url ?? process.env.THENWISE_UPDATE_URL ?? LATEST, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) })
    const version = res.ok ? ((await res.json()) as { version?: unknown }).version : undefined
    if (typeof version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) latest = version
    log.info('check', { status: res.status, found: !!latest })
  } catch (e) {
    log.info('check_failed', { err: e instanceof Error ? e.name : 'unknown' })
  }
  saveState(cfg.memDir, { ...readState(cfg.memDir), checked: now, ...(latest ? { latest } : {}) })

  return latest
}

/** Claude Code updates the plugin itself when auto-update is on for our marketplace, so there is nothing to tell. */
function autoUpdateOn(cfg: Config): boolean {
  try {
    return JSON.parse(readFileSync(join(cfg.claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8')).thenwise?.autoUpdate === true
  } catch {
    return false
  }
}

/** What to tell the person at the start of a session: once per version, from the saved answer only. */
export function updateNotice(cfg: Config, running = runningVersion()): string {
  if (!checkEnabled(cfg) && !existsSync(stateFile(cfg.memDir))) return ''
  const s = readState(cfg.memDir)
  const lines: string[] = []
  // A first run has no record to compare: an install is not an update.
  if (s.ran && compareVersions(running, s.ran) > 0) lines.push(`Thenwise updated to ${running}. What changed: ${RELEASES}/v${running}`)
  const newer = s.latest && compareVersions(s.latest, running) > 0 && s.notified !== s.latest && checkEnabled(cfg) && !autoUpdateOn(cfg) ? s.latest : undefined
  if (newer) lines.push(`Thenwise ${newer} is out, you have ${running}. Update in /plugin (Marketplaces, thenwise), or run: npm install -g thenwise@latest. ${OFF_LINE}`)
  if (s.ran !== running || newer) saveState(cfg.memDir, { ...s, ran: running, ...(newer ? { notified: newer } : {}) })

  return lines.join('\n')
}

/** One line for `status` and `doctor`, read from the saved answer. */
export function updateStatus(cfg: Pick<Config, 'off' | 'updateCheck' | 'memDir'>, running = runningVersion()): { line: string; newer: boolean } {
  if (!checkEnabled(cfg)) return { line: 'update check is off', newer: false }
  const { latest, checked } = readState(cfg.memDir)
  if (latest && compareVersions(latest, running) > 0) return { line: `${latest} is out, you have ${running}. Update in /plugin, or run: npm install -g thenwise@latest`, newer: true }

  return { line: checked ? `${running} is the latest seen, checked ${new Date(checked).toISOString().slice(0, 10)}` : `${running}, not checked yet`, newer: false }
}
