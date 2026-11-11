// The first stop for the hooks that fire on most tool calls and prompts (read, post, prompt): decides from the hook input alone whether
// there is anything to do, before the CLI loads SQLite and the store code. Imports nothing but node:fs, node:path and the
// Copilot shape mapper and the progress file reader (which import only those two).

import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { resolveDataDir } from '../core/home.ts'
import { isTestRun } from '../core/testrun.ts'
import { readProgress, running } from '../core/progress.ts'
import { claudeHookInput } from '../ingest/copilot.ts'

/** The planning-with-files plan files. */
export const STEMS = ['task_plan', 'findings', 'progress']
/** Commands that print a file, so a plain `cat src/x.ts` gets the same history hint as Read. */
export const READERS = /^(?:cat|head|tail|less|bat|sed)$/

// Words that ask about the past. A prompt without one gets no pointers: most prompts are about the work at hand.
// "did you" stays out: it usually asks about this chat, and the chat already holds that answer.
const CUE = /\b(?:why (?:did|do|does|is|was) (?:we|i|you|it)|why (?:was|were|did|has|have|had)|(?:what|how|when|where|who) did (?:we|i)|(?:did|have|had) (?:we|i)|we (?:chose|picked|tried|dropped|rejected|settled|agreed)|last time|before|earlier|we decided|remember|again|what happened|used to|previously|history of)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:PR|pull request)\s*#?\d+|(?:^|\s)#\d{1,5}\b|[\w.-]+\/[\w./-]*\.\w{1,6}\b/i
/** A prompt that may want past work: a cue, and not a slash command. */
export const asksAboutThePast = (prompt: string) => !!prompt.trim() && !prompt.trimStart().startsWith('/') && CUE.test(prompt.slice(0, 2000))

// Search time grows with query words: 150 words took 1.3 s on a 62 MB store, past the hook's 900 ms, so long prompts lost their pointers.
const FOCUS_WORDS = 60
/** The words a pointer search uses: a short prompt whole; a long one only its sentences that ask about the past,
 * at most FOCUS_WORDS of them, starting a little before the cue. */
export function pointerQuery(prompt: string): string {
  const words = (s: string) => s.split(/\s+/).filter(Boolean)
  if (words(prompt).length <= FOCUS_WORDS) return prompt
  const cued = prompt.split(/(?<=[.?!])\s+|\n+/).filter((s) => CUE.test(s))
  // A pasted log can hold a loose cue word such as "before"; a sentence that ends in "?" is the question.
  const asks = cued.filter((s) => s.trimEnd().endsWith('?'))
  const text = (asks.length ? asks : cued).join(' ') || prompt
  const start = Math.max(0, words(text.slice(0, CUE.exec(text)?.index ?? 0)).length - 15)

  return words(text).slice(start, start + FOCUS_WORDS).join(' ')
}

export const hasPlanFiles = (cwd: string) => STEMS.some((s) => existsSync(join(cwd, `${s}.md`))) || existsSync(join(cwd, '.planning'))

let input: Record<string, any> | undefined
/** The hook's stdin as JSON, read once: the quick check and the hook itself share it. */
export async function hookInput(): Promise<Record<string, any>> {
  if (input) return input
  let raw = ''
  for await (const d of process.stdin) raw += d
  try {
    input = claudeHookInput(JSON.parse(raw || '{}'))
  } catch {
    input = {}
  }

  return input!
}

/** Copilot sends no text-carrying event after it compacts a chat, so its PreCompact hook leaves this mark and the next prompt
 * carries the resume brief. Claude Code needs none: it starts the session again with source "compact". */
export const compactedMark = (dir: string, session: string) => join(dir, 'compacted', session.replace(/[^\w.-]/g, '_'))
export const resumePending = (i: Record<string, any>) => {
  const sid = i.session_id ?? i.sessionId

  return !!process.env.COPILOT_PLUGIN_ROOT && typeof sid === 'string' && !!sid && existsSync(compactedMark(resolveDataDir(), sid))
}

/** Set at session start for a team member: a teammate's chat that the start's sync fetches arrives after the brief, so the
 * first prompts check for it. */
export const lateMark = (dir: string, session: string) => join(dir, 'hook-state', `${session.replace(/[^\w.-]/g, '_')}.late`)
const latePending = (i: Record<string, any>) => {
  const sid = i.session_id ?? i.sessionId

  return typeof sid === 'string' && !!sid && existsSync(lateMark(resolveDataDir(), sid))
}

/** A first sync or a rebuild the person has not heard about lately (Claude Code and Codex: Copilot and Antigravity show no hook text). */
const syncToTell = () => {
  if (process.env.COPILOT_PLUGIN_ROOT || process.env.ANTIGRAVITY_CONVERSATION_ID) return false
  const p = readProgress(resolveDataDir())

  return !!p && p.kind !== 'auto' && (p.finished ? !p.told || p.told < p.finished : running(p)) // a killed sync has nothing to tell
}

// After each reply, a team member's sync runs at most this often, so a teammate gets the chat while it is still fresh.
export const STOP_SYNC_MS = 10 * 60_000
export const stopStamp = (dir: string) => join(dir, 'hook-state', 'stop-sync')
/** A stop hook only matters to a team member: alone, the next session reads the chat file itself. */
export function stopIdle(name: string, now = Date.now()): boolean {
  const dir = resolveDataDir()
  if (!existsSync(join(dir, 'team.json'))) return true
  try {
    // Cut off by a limit or an error: send the chat now, at most once a minute (Copilot reports every error).
    return now - statSync(stopStamp(dir)).mtimeMs < (name === 'stop-failure' ? 60_000 : STOP_SYNC_MS)
  } catch {
    return false
  }
}

/** True when the hook has nothing to do: a Read hook for another tool, or a Bash command that prints no single file,
 * run in a folder with no plan files. Anything else goes on to the full hook, which decides exactly. */
export function nothingToDo(name: string, i: Record<string, any>): boolean {
  if (name === 'prompt') return !resumePending(i) && !syncToTell() && !latePending(i) && (typeof i.prompt !== 'string' || !asksAboutThePast(i.prompt))
  if (name === 'read') return i.tool_name !== 'Read' || typeof i.tool_input?.file_path !== 'string'
  if (name === 'stop' || name === 'stop-failure') return stopIdle(name)
  if (name !== 'post') return false
  if (i.tool_name !== 'Bash') {
    // An edit only matters when it touches a plan file, and that is a name check.
    const f = i.tool_input?.file_path
    return typeof f !== 'string' || !f.endsWith('.md') || !STEMS.includes(basename(f, '.md'))
  }
  const cmd = i.tool_input?.command
  if (typeof cmd !== 'string' || !i.cwd) return true
  const first = cmd.trim().split(/\s+/)[0]!.split('/').pop()!
  const mayRead = READERS.test(first) && !/[|;&<>`$()\n]/.test(cmd)

  return !mayRead && !isTestRun(cmd) && !hasPlanFiles(String(i.cwd))
}
