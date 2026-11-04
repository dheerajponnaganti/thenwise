// Windows reads the home folder from USERPROFILE and ignores HOME, which is what the tests set. Loaded by every child process.
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

if (process.env.HOME) process.env.USERPROFILE = process.env.HOME
// A test that moves HOME after start (to its World's home) must move homedir() with it, as on macOS and Linux.
const real = os.homedir
os.homedir = () => process.env.HOME || real()
syncBuiltinESMExports()
