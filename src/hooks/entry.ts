// The first stop for the hooks that fire on most tool calls and prompts (read, post, prompt): decides from the hook input alone whether
// there is anything to do, before the CLI loads SQLite and the store code. Imports nothing but node:fs and node:path.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
    input = JSON.parse(raw || '{}')
  } catch {
    input = {}
  }

  return input!
}

/** True when the hook has nothing to do: a Read hook for another tool, or a Bash command that prints no single file,
 * run in a folder with no plan files. Anything else goes on to the full hook, which decides exactly. */
export function nothingToDo(name: string, i: Record<string, any>): boolean {
  if (name === 'prompt') return typeof i.prompt !== 'string' || !asksAboutThePast(i.prompt)
  if (name === 'read') return i.tool_name !== 'Read' || typeof i.tool_input?.file_path !== 'string'
  if (name !== 'post' || i.tool_name !== 'Bash') return false
  const cmd = i.tool_input?.command
  if (typeof cmd !== 'string' || !i.cwd) return true
  const first = cmd.trim().split(/\s+/)[0]!.split('/').pop()!
  const mayRead = READERS.test(first) && !/[|;&<>`$()\n]/.test(cmd)

  return !mayRead && !hasPlanFiles(String(i.cwd))
}
