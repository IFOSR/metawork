"""Acceptance-only POSIX terminal for the installed CLI, with owned cleanup."""
import errno
import fcntl
import os
import pty
import selectors
import struct
import sys
import termios

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 140, 0, 0))
selector = selectors.DefaultSelector()
selector.register(terminal, selectors.EVENT_READ)
selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
try:
    while True:
        for key, _ in selector.select():
            try:
                data = os.read(key.fd, 16384)
            except OSError as error:
                if error.errno == errno.EIO:
                    data = b''
                else:
                    raise
            if not data:
                raise EOFError()
            target = sys.stdout.fileno() if key.fd == terminal else terminal
            while data:
                data = data[os.write(target, data):]
except EOFError:
    pass
finally:
    selector.close()
    # Closing the last PTY master hangs up its owned terminal session. Do not
    # signal a numeric process group after its leader may already have exited.
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
