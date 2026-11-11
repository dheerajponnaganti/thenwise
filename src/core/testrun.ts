// Whether a shell command runs tests. One rule for the chat parser (which records the run) and the hooks (which give a
// test's history when it runs), kept here so the hooks' fast path can use it without loading the parser.

// Runners matched by the start of a command part. Every branch is a fixed word sequence, so matching is linear.
const RUNNER = /^(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|pytest|go\s+test|cargo\s+test|vitest|jest|mocha|deno\s+test|python\d?\s+-m\s+pytest)(?:[\s)]|$)/
// What may come before the runner in one part of a command: env settings and launchers, read word by word.
const LAUNCHERS = new Set(['env', 'npx', 'bunx', 'time', 'nice', 'exec'])

/** The words of one command part after its env settings and launchers. A masked env value reads `[secret masked]`. */
function runWords(part: string): string[] {
  const w = part.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < w.length) {
    if (/^\w+=/.test(w[i]!)) {
      if (/^\w+=\[/.test(w[i]!)) while (i < w.length - 1 && !w[i]!.endsWith(']')) i++
      i++
    } else if (LAUNCHERS.has(w[i]!)) i++
    else if ((w[i] === 'pnpm' || w[i] === 'yarn') && w[i + 1] === 'exec') i += 2
    else break
  }
  return w.slice(i)
}

/** `node [its flags, each with at most one value] --test`. Read word by word: a regex for it backtracks without end. */
function nodeTest(w: string[]): boolean {
  if (w[0] !== 'node') return false
  for (let i = 1; i < w.length; i++) {
    const t = w[i]!.replace(/\)+$/, '')
    if (t === '--test') return true
    if (!t.startsWith('-')) return false // a script: `node script.js --test` runs no tests itself
    if (!t.includes('=') && w[i + 1] && !w[i + 1]!.startsWith('-')) i++ // the flag's value, as in `--import ./setup.mjs`
  }
  return false
}

/** A command's parts, split at && || ; | & and newlines outside quotes, each with the operator after it ('' for the
 * last). The & of a redirect (`2>&1`, `&>log`) splits nothing. */
export function commandParts(cmd: string): { text: string; op: string }[] {
  const parts: { text: string; op: string }[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) (ch === quote && (quote = ''), (cur += ch))
    else if (ch === '"' || ch === "'") (quote = ch), (cur += ch)
    else {
      const two = cmd.slice(i, i + 2)
      const op = two === '&&' || two === '||' ? two : ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && !/[<>]$/.test(cur) && cmd[i + 1] !== '>') ? ch : ''
      if (op) (parts.push({ text: cur, op }), (cur = ''), (i += op.length - 1))
      else cur += ch
    }
  }
  parts.push({ text: cur, op: '' })
  return parts
}

/** True when one part of the command (see `commandParts`) starts with a test runner. A runner named inside a quoted
 * string, an argument or a file name (`cat jest.config.js`, `git commit -m "npm test"`) is no test run. */
export const isTestRun = (cmd: string): boolean => commandParts(cmd).some((p) => testPart(p.text))
const testPart = (p: string) => {
  const w = runWords(p.trim().replace(/^\(+/, '').replace(/^cd\s+\S+\s*$/, ''))
  return RUNNER.test(w.join(' ')) || nodeTest(w)
}
