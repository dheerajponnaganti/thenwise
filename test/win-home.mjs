// Windows reads the home folder from USERPROFILE and ignores HOME, which is what the tests set. Loaded by every child process.
if (process.env.HOME) process.env.USERPROFILE = process.env.HOME
