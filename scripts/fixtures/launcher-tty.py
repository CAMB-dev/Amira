"""Exercise console delivery in a real headless POSIX foreground process group."""
import errno
import os
import pty
import signal
import sys


def timeout(_signal, _frame):
    raise TimeoutError("Launcher terminal test timed out")


signal.signal(signal.SIGALRM, timeout)
signal.alarm(10)
pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:4])


def read_output():
    try:
        return os.read(terminal, 4096)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


output = b""
try:
    while b"ready" not in output:
        chunk = read_output()
        assert chunk, output
        output += chunk
    # The terminal driver sends this to BOTH the launcher and its child.
    os.write(terminal, {"SIGINT": b"\x03", "SIGQUIT": b"\x1c"}[sys.argv[4]])
    while True:
        chunk = read_output()
        if not chunk:
            break
        output += chunk
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 42, (status, output)
    assert output.count(b"interrupt:1") == 1, output
    assert b"interrupt:2" not in output, output
    print("one console interrupt; child exit 42 preserved")
finally:
    signal.alarm(0)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(terminal)
