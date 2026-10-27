# Runs a command in a pseudo-terminal inside this (visible) window. Keys come from the keyboard and from a FIFO,
# so a driver can type into the session while the owner watches and can answer prompts.
# Usage: python3 relay.py <fifo> <command...>
import fcntl, os, pty, select, signal, struct, sys, termios, tty

fifo, argv = sys.argv[1], sys.argv[2:]
if not os.path.exists(fifo):
    os.mkfifo(fifo)
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

def resize(*_):
    size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b'\0' * 8)
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    os.kill(pid, signal.SIGWINCH)

resize()
signal.signal(signal.SIGWINCH, resize)
# Opened read-write so the FIFO never reports end-of-file between writers.
feed = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
saved = termios.tcgetattr(sys.stdin.fileno())
tty.setraw(sys.stdin.fileno())
try:
    while True:
        try:
            ready, _, _ = select.select([master, sys.stdin.fileno(), feed], [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            os.write(master, os.read(sys.stdin.fileno(), 4096))
        if feed in ready:
            os.write(master, os.read(feed, 65536))
finally:
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved)
