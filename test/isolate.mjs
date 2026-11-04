// Preload for `npm test`: a data folder set by the caller is dropped, so every test uses its own temp home, as on CI.
// (A test run inside an evaluation once inherited THENWISE_HOME and replaced a frozen store's chats with fixtures.)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The home itself is a temp folder too: code that loads the config from the home (every hook) must never read or write the
// real ~/.thenwise. It once did: the R10-H4 test wrote the real update-check.json and failed whenever a real session had
// stamped an older version there.
process.env.HOME = mkdtempSync(join(tmpdir(), 'tw-home-'))
delete process.env.THENWISE_HOME
delete process.env.MEMORY_HOME
// Copilot chats are read from COPILOT_HOME when set: tests read only their temp home's .copilot.
delete process.env.COPILOT_HOME
delete process.env.CODEX_HOME
// A hook in a test must never start the background sync: it would read the real ~/.claude through HOME.
process.env.THENWISE_SYNC = 'off'
// Code under test logs to the default data folder, which is the real one: the log test turns logging back on.
process.env.THENWISE_LOG = 'off'
if (process.platform === 'win32') {
  const home = new URL('./win-home.mjs', import.meta.url).href
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${home}`.trim()
  await import(home)
}
