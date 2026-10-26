// Preload for `npm test`: a data folder set by the caller is dropped, so every test uses its own temp home, as on CI.
// (A test run inside an evaluation once inherited THENWISE_HOME and replaced a frozen store's chats with fixtures.)
delete process.env.THENWISE_HOME
delete process.env.MEMORY_HOME
// Code under test logs to the default data folder, which is the real one: the log test turns logging back on.
process.env.THENWISE_LOG = 'off'
