"""Private WSL bridge, launched via python3 -I -u -c; no installed service.

Only this process writes protocol stdout. Workload bytes travel in base64 frames.
The parent pipe is also the lifetime lease: EOF always cleans up the process group.
"""
import base64
import errno
import fcntl
import json
import os
import platform
import pwd
import select
import signal
import stat
import struct
import subprocess
import sys
import termios
import time

LIMIT = 128 * 1024
EXEC_INPUT_LIMIT = 64 * 1024 * 1024


def emit(kind, **values):
    print(json.dumps(dict(type=kind, **values), ensure_ascii=True), flush=True)


def parts(path):
    result = path.split("/")
    if not path or any(p in ("", ".", "..") or "\0" in p for p in result):
        raise ValueError("invalid workspace path")
    return result


def directory(parent, names):
    fd = os.dup(parent)
    try:
        for name in names:
            try:
                os.mkdir(name, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def main():
    process = None
    root = None
    upload = None
    master = None
    outputs = {}
    pending = bytearray()
    incoming = bytearray()
    initialized = False
    start = None
    stopped = None
    stop_at = None
    stage = 0
    group_cleaned = False
    request = None
    stdin_fd = None
    stdin_owned = None
    total = 0
    file_size = 0
    entries = 0
    # Managed Runtime 结构化 exec 状态（00027）：与 run 流程互斥
    exec_proc = None
    exec_argv = None
    exec_env = None
    exec_cwd = None
    exec_input = None
    exec_pending = bytearray()
    exec_stdin = None
    exec_fds = set()
    exec_reported = False

    def kill_group(sig):
        if process is not None:
            if request and request.get("terminal"):
                # Interactive shells create a new process group for each job.
                # Restrict cleanup to this helper's child session, never the distro.
                groups = {process.pid}
                for name in os.listdir("/proc"):
                    if name.isdigit():
                        try:
                            pid = int(name)
                            if os.getsid(pid) == process.pid:
                                groups.add(os.getpgid(pid))
                        except (ProcessLookupError, PermissionError):
                            pass
                for group in groups:
                    try:
                        os.killpg(group, sig)
                    except ProcessLookupError:
                        pass
                return
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        if exec_proc is not None:
            try:
                os.killpg(exec_proc.pid, sig)
            except ProcessLookupError:
                pass

    def stop(reason):
        nonlocal stopped, stop_at, stage
        if stopped is None:
            stopped = reason
            pending.clear()
            kill_group(signal.SIGINT)
            stage = 1
            stop_at = time.monotonic() + 3

    def resize(cols, rows):
        if not (1 <= cols <= 4096 and 1 <= rows <= 4096):
            raise ValueError("invalid terminal dimensions")
        if master is not None:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    try:
        os.umask(0o077)
        emit("ready", version=1, info="%s; Python %s; user %s" % (platform.platform(), platform.python_version(), os.getuid()))
        while True:
            now = time.monotonic()
            if exec_proc is not None and not exec_reported:
                code = exec_proc.poll()
                alive_fds = exec_fds & set(outputs)
                if code is not None and not alive_fds:
                    emit("exec_exit", code=code if code >= 0 else 128 - code)
                    exec_reported = True
                    exec_proc = None
                    exec_fds = set()
                    exec_stdin = None
                    stdin_fd = None
            if process is not None:
                code = process.poll()
                if code is not None and not group_cleaned:
                    # A run owns its entire group, including children holding output open.
                    kill_group(signal.SIGKILL)
                    group_cleaned = True
                    pending.clear()
                if code is not None and not outputs:
                    emit("exit", code=code if code >= 0 else 128 - code, stopped=stopped)
                    return
                if code is None and request["timeout"] and now - start >= request["timeout"]:
                    stop("timeout")
                if code is None and stopped and now >= stop_at:
                    kill_group(signal.SIGTERM if stage == 1 else signal.SIGKILL)
                    stage += 1
                    stop_at = now + 3
                    if stage > 3:
                        raise RuntimeError("WSL process did not confirm termination")

            read_fds = [0] + list(outputs)
            write_fds = []
            if pending and stdin_fd is not None:
                write_fds.append(stdin_fd)
            if exec_pending and exec_stdin is not None:
                write_fds.append(exec_stdin)
            readable, writable, _ = select.select(read_fds, write_fds, [], 0.05)
            # Process controls first, even during continuous output.
            if 0 in readable:
                chunk = os.read(0, 65536)
                if not chunk:
                    return
                incoming.extend(chunk)
                while b"\n" in incoming:
                    line, _, remainder = incoming.partition(b"\n")
                    incoming = bytearray(remainder)
                    if len(line) > LIMIT:
                        raise ValueError("protocol frame exceeds limit")
                    message = json.loads(line)
                    kind = message["type"]
                    if kind == "shutdown":
                        return
                    if kind == "stop":
                        if process is None and exec_proc is None:
                            emit("exit", code=None, stopped="user")
                            return
                        stop("user")
                    elif kind == "exec_begin" and exec_proc is None and process is None:
                        argv = message.get("argv")
                        if (not isinstance(argv, list) or not argv
                                or not all(isinstance(a, str) and a and "\0" not in a for a in argv)):
                            raise ValueError("invalid exec argv")
                        env = message.get("env") or {}
                        if not isinstance(env, dict) or not all(
                                isinstance(k, str) and isinstance(v, str) and "\0" not in k for k, v in env.items()):
                            raise ValueError("invalid exec env")
                        cwd = message.get("cwd")
                        if cwd is not None and (not isinstance(cwd, str) or not cwd.startswith("/")):
                            raise ValueError("invalid exec cwd")
                        exec_argv = argv
                        exec_env = {str(k): str(v) for k, v in env.items()}
                        exec_cwd = cwd
                        exec_input = bytearray()
                        emit("ack")
                    elif kind == "exec_input" and exec_proc is None and exec_input is not None:
                        data = base64.b64decode(message["data"], validate=True)
                        if len(exec_input) + len(data) > EXEC_INPUT_LIMIT:
                            raise ValueError("exec input exceeds 64 MiB")
                        exec_input.extend(data)
                        emit("ack")
                    elif kind == "exec_run" and exec_proc is None and exec_input is not None:
                        child_env = dict(os.environ)
                        child_env.update(exec_env)
                        stdin_pipe = subprocess.PIPE if exec_input else subprocess.DEVNULL
                        exec_proc = subprocess.Popen(
                            exec_argv, cwd=exec_cwd, env=child_env,
                            stdin=stdin_pipe, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True)
                        exec_pending.extend(exec_input)
                        exec_input = None
                        exec_fds = {exec_proc.stdout.fileno(), exec_proc.stderr.fileno()}
                        outputs[exec_proc.stdout.fileno()] = "stdout"
                        outputs[exec_proc.stderr.fileno()] = "stderr"
                        if exec_pending:
                            exec_stdin = exec_proc.stdin.fileno()
                            stdin_fd = exec_stdin
                            os.set_blocking(exec_stdin, False)
                        for fd in exec_fds:
                            os.set_blocking(fd, False)
                        emit("ack")
                    elif kind == "init" and not initialized:
                        request = message
                        if request.get("terminal") and (request.get("remote") is not None or request.get("mode") != "pty"):
                            raise ValueError("terminal requires PTY and no workspace")
                        initialized = True
                        remote = request.get("remote")
                        if remote is not None:
                            if not remote.startswith("/"):
                                raise ValueError("workspace must be absolute")
                            names = parts(remote[1:])
                            anchor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
                            try:
                                parent = directory(anchor, names[:-1])
                            finally:
                                os.close(anchor)
                            try:
                                # Never reuse an existing run directory, even an empty one.
                                os.mkdir(names[-1], 0o700, dir_fd=parent)
                                root = os.open(names[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                            finally:
                                os.close(parent)
                        emit("ack")
                    elif kind in ("directory", "file", "chunk", "end") and initialized and process is None:
                        if root is None:
                            raise ValueError("no workspace")
                        if kind in ("directory", "file"):
                            entries += 1
                            if upload is not None or entries > 4096:
                                raise ValueError("invalid upload sequence or too many entries")
                            names = parts(message["path"])
                            parent = directory(root, names if kind == "directory" else names[:-1])
                            try:
                                if kind == "file":
                                    upload = os.open(names[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                                     message["mode"] & 0o777, dir_fd=parent)
                                    os.fchmod(upload, message["mode"] & 0o777)
                                    file_size = 0
                            finally:
                                os.close(parent)
                        elif kind == "chunk":
                            if upload is None:
                                raise ValueError("no open upload")
                            data = base64.b64decode(message["data"], validate=True)
                            total += len(data)
                            file_size += len(data)
                            if file_size > 16 * 1024 * 1024 or total > 64 * 1024 * 1024:
                                raise ValueError("workspace limit exceeded")
                            view = memoryview(data)
                            while view:
                                view = view[os.write(upload, view):]
                        else:
                            if upload is None:
                                raise ValueError("no open upload")
                            os.close(upload)
                            upload = None
                        emit("ack")
                    elif kind == "start" and initialized and process is None and upload is None:
                        if root is not None:
                            os.fchdir(root)
                        else:
                            os.chdir(os.path.expanduser("~"))
                        env = dict(os.environ, TERM="xterm-256color")
                        if request.get("terminal"):
                            shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
                            env["SHELL"] = shell
                            argv = [shell, "-i"]
                        else:
                            argv = ["/bin/sh", "-c", request["command"]]
                        if request["mode"] == "pty":
                            master, slave = os.openpty()
                            resize(request["cols"], request["rows"])
                            def setup_terminal():
                                os.setsid()
                                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
                            try:
                                process = subprocess.Popen(argv,
                                    stdin=slave, stdout=slave, stderr=slave, env=env, preexec_fn=setup_terminal)
                            finally:
                                os.close(slave)
                            outputs[master] = "stdout"
                            stdin_fd = master
                        elif request["mode"] == "pipe":
                            process = subprocess.Popen(["/bin/sh", "-c", request["command"]],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, start_new_session=True)
                            stdin_owned = process.stdin
                            stdin_fd = process.stdin.fileno()
                            outputs[process.stdout.fileno()] = "stdout"
                            outputs[process.stderr.fileno()] = "stderr"
                        else:
                            raise ValueError("invalid console mode")
                        for fd in set(outputs) | {stdin_fd}:
                            os.set_blocking(fd, False)
                        start = time.monotonic()
                        emit("started")
                    elif kind == "input" and process is not None:
                        if not stopped and process.poll() is None and stdin_fd is not None:
                            pending.extend(base64.b64decode(message["data"], validate=True))
                            if len(pending) > 1024 * 1024:
                                raise ValueError("pending stdin exceeds 1 MiB")
                    elif kind == "resize" and process is not None:
                        resize(message["cols"], message["rows"])
                    else:
                        raise ValueError("unexpected protocol message: " + kind)
                if len(incoming) > LIMIT:
                    raise ValueError("protocol frame exceeds limit")

            for fd in writable:
                if not pending and not exec_pending:
                    break
                try:
                    if exec_stdin is not None and fd == exec_stdin:
                        del exec_pending[:os.write(fd, exec_pending[:65536])]
                        if not exec_pending and exec_proc is not None and exec_proc.stdin is not None:
                            # EOF：让 `cat` 类命令退出
                            try:
                                exec_proc.stdin.close()
                            except OSError:
                                pass
                            exec_stdin = None
                            if stdin_fd == fd:
                                stdin_fd = None
                        continue
                    del pending[:os.write(fd, pending[:65536])]
                except BlockingIOError:
                    pass
                except OSError as error:
                    if error.errno not in (errno.EPIPE, errno.EIO):
                        raise
                    if fd == exec_stdin:
                        exec_pending.clear()
                        exec_stdin = None
                        if stdin_fd == fd:
                            stdin_fd = None
                        continue
                    pending.clear()
                    stdin_fd = None
                    if stdin_owned is not None:
                        stdin_owned.close()

            for fd in readable:
                if fd == 0:
                    continue
                try:
                    data = os.read(fd, 16384)
                except BlockingIOError:
                    continue
                except OSError as error:
                    if error.errno != errno.EIO or fd != master:
                        raise
                    data = b""
                if data:
                    emit("output", stream=outputs[fd], data=base64.b64encode(data).decode("ascii"))
                else:
                    del outputs[fd]
    except Exception as error:
        emit("error", message=str(error))
        raise SystemExit(1)
    finally:
        if exec_proc is not None:
            try:
                os.killpg(exec_proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                exec_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        if process is not None:
            kill_group(signal.SIGKILL)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        for fd in (upload, root, master):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    main()
