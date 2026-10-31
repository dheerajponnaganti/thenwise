// Preload for `npm test`: a data folder set by the caller is dropped, so every test uses its own temp home, as on CI.
// (A test run inside an evaluation once inherited THENWISE_HOME and replaced a frozen store's chats with fixtures.)
delete process.env.THENWISE_HOME
delete process.env.MEMORY_HOME
// A hook in a test must never start the background sync: it would read the real ~/.claude through HOME.
process.env.THENWISE_SYNC = 'off'
// Code under test logs to the default data folder, which is the real one: the log test turns logging back on.
process.env.THENWISE_LOG = 'off'
if (process.platform === 'win32') {
  const home = new URL('./win-home.mjs', import.meta.url).href
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${home}`.trim()
  await import(home)
}
