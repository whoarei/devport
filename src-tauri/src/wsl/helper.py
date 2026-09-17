"""Private WSL bridge, launched via python3 -I -u -c; no installed service.

Only this process writes protocol stdout. Workload bytes travel in base64 frames.
The parent pipe is also the lifetime lease: EOF always cleans up the process group.
"""
import base64
import errno
import fcntl
import hashlib
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
# fs_* 文件服务（00029）：编辑器文本上限 1 MiB；暂存下载单文件上限 64 MiB
FS_EDIT_LIMIT = 1024 * 1024
FS_READ_LIMIT = 64 * 1024 * 1024
FS_DELETE_LIMIT = 4096


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


def walk(base, names):
    # 非创建式逐级打开目录；O_NOFOLLOW 拒绝符号链接（含最终组件为目录时）
    fd = os.dup(base)
    try:
        for name in names:
            nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def fs_fail(error):
    if isinstance(error, FileNotFoundError):
        return ("not_found", "文件或目录不存在")
    if isinstance(error, PermissionError):
        return ("permission", "没有文件读写权限")
    if isinstance(error, FileExistsError):
        return ("exists", "同名文件或目录已存在")
    if isinstance(error, OSError) and error.errno == errno.ELOOP:
        return ("path", "不支持链接或重定向路径")
    return ("io", str(error))


def fs_hash(handle, st):
    # revision = 内容 + 大小 + mtime 的哈希；任何写入或替换都会改变它
    digest = hashlib.sha256()
    while True:
        chunk = os.read(handle, 65536)
        if not chunk:
            break
        digest.update(chunk)
    digest.update(st.st_size.to_bytes(8, "little"))
    digest.update(st.st_mtime_ns.to_bytes(8, "little", signed=True))
    return digest.hexdigest()


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
    # fs_* 文件服务状态（00029）：与 run/exec 流程互斥
    fs_root = None
    fs_upload = None

    def fs_open(path):
        nonlocal fs_root
        if not path.startswith("/"):
            raise ValueError("workspace must be absolute")
        anchor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            fd = walk(anchor, parts(path[1:]))
        finally:
            os.close(anchor)
        if fs_root is not None:
            os.close(fs_root)
        fs_root = fd
        emit("ack")

    def fs_list(path):
        names = parts(path) if path else []
        fd = walk(fs_root, names)
        try:
            for name in sorted(os.listdir(fd)):
                try:
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except OSError:
                    continue
                mode = st.st_mode
                if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                    continue
                emit("fs_entry", name=name, dir=stat.S_ISDIR(mode), link=stat.S_ISLNK(mode))
            emit("fs_done")
        finally:
            os.close(fd)

    def fs_read(path, limit):
        limit = min(max(int(limit), 1), FS_READ_LIMIT)
        names = parts(path)
        parent = walk(fs_root, names[:-1])
        try:
            st = os.stat(names[-1], dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode):
                raise ValueError("not a regular file")
            if st.st_size > limit:
                emit("fs_error", code="too_large", message="文件超过大小上限")
                return
            fd = os.open(names[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                revision = fs_hash(fd, st)
                # 哈希与发送之间复查，避免读到一半被改写
                again = os.stat(names[-1], dir_fd=parent, follow_symlinks=False)
                if (again.st_size, again.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
                    emit("fs_error", code="io", message="文件读取期间被修改，请重试")
                    return
                emit("fs_file", size=st.st_size, revision=revision)
                os.lseek(fd, 0, os.SEEK_SET)
                sent = 0
                while True:
                    chunk = os.read(fd, 49152)
                    if not chunk:
                        break
                    sent += len(chunk)
                    if sent > limit:
                        emit("fs_error", code="too_large", message="文件超过大小上限")
                        return
                    emit("fs_chunk", data=base64.b64encode(chunk).decode("ascii"))
                emit("fs_done")
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def fs_write_begin(path, expected):
        nonlocal fs_upload
        if fs_upload is not None:
            raise ValueError("upload already in progress")
        names = parts(path)
        parent = walk(fs_root, names[:-1])
        try:
            st = os.stat(names[-1], dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode):
                raise ValueError("not a regular file")
            fd = os.open(names[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                revision = fs_hash(fd, st) if st.st_size <= FS_EDIT_LIMIT + 16 else ""
            finally:
                os.close(fd)
            if not revision or revision != expected:
                emit("fs_error", code="conflict",
                     message="文件已被其他程序修改。请复制需要保留的内容后重新加载，或取消保存")
                return
            temp = ".rr-edit-%s.tmp" % os.urandom(16).hex()
            upload = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent)
            fs_upload = {"parent": os.dup(parent), "temp": temp, "target": names[-1],
                         "fd": upload, "size": 0, "mode": stat.S_IMODE(st.st_mode),
                         "expected": expected}
            emit("ack")
        finally:
            os.close(parent)

    def fs_write_chunk(data):
        if fs_upload is None:
            raise ValueError("no open upload")
        fs_upload["size"] += len(data)
        if fs_upload["size"] > FS_EDIT_LIMIT + 16:
            raise ValueError("workspace edit limit exceeded")
        view = memoryview(data)
        while view:
            view = view[os.write(fs_upload["fd"], view):]
        emit("ack")

    def fs_write_done():
        nonlocal fs_upload
        if fs_upload is None:
            raise ValueError("no open upload")
        state = fs_upload
        fs_upload = None
        parent = state["parent"]
        try:
            os.fchmod(state["fd"], state["mode"])
            os.fsync(state["fd"])
            os.close(state["fd"])
            state["fd"] = None
            # 覆盖前复查原文件未被并发修改
            st = os.stat(state["target"], dir_fd=parent, follow_symlinks=False)
            fd = os.open(state["target"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                revision = fs_hash(fd, st) if st.st_size <= FS_EDIT_LIMIT + 16 else ""
            finally:
                os.close(fd)
            if not revision or revision != state["expected"]:
                os.unlink(state["temp"], dir_fd=parent)
                emit("fs_error", code="conflict",
                     message="文件已被其他程序修改。请复制需要保留的内容后重新加载，或取消保存")
                return
            os.rename(state["temp"], state["target"], src_dir_fd=parent, dst_dir_fd=parent)
            st = os.stat(state["target"], dir_fd=parent, follow_symlinks=False)
            fd = os.open(state["target"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                saved = fs_hash(fd, st)
            finally:
                os.close(fd)
            emit("fs_saved", revision=saved)
        finally:
            if state["fd"] is not None:
                os.close(state["fd"])
            try:
                os.unlink(state["temp"], dir_fd=parent)
            except OSError:
                pass
            os.close(parent)

    def fs_create(path, kind, data):
        names = parts(path)
        parent = walk(fs_root, names[:-1])
        try:
            try:
                os.stat(names[-1], dir_fd=parent, follow_symlinks=False)
                emit("fs_error", code="exists", message="同名文件或目录已存在")
                return
            except FileNotFoundError:
                pass
            if kind == "dir":
                os.mkdir(names[-1], 0o700, dir_fd=parent)
            elif kind == "file":
                fd = os.open(names[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent)
                try:
                    if data:
                        view = memoryview(data)
                        while view:
                            view = view[os.write(fd, view):]
                        os.fsync(fd)
                finally:
                    os.close(fd)
            else:
                raise ValueError("invalid entry kind")
            emit("ack")
        finally:
            os.close(parent)

    def fs_rename(old, new):
        old_names = parts(old)
        new_names = parts(new)
        if old_names == new_names:
            emit("ack")
            return
        if len(new_names) > len(old_names) and new_names[:len(old_names)] == old_names:
            raise ValueError("不能把目录重命名到自身内部")
        old_parent = walk(fs_root, old_names[:-1])
        try:
            os.stat(old_names[-1], dir_fd=old_parent, follow_symlinks=False)
            new_parent = walk(fs_root, new_names[:-1])
            try:
                try:
                    os.stat(new_names[-1], dir_fd=new_parent, follow_symlinks=False)
                    emit("fs_error", code="exists", message="目标已存在")
                    return
                except FileNotFoundError:
                    pass
                os.rename(old_names[-1], new_names[-1],
                          src_dir_fd=old_parent, dst_dir_fd=new_parent)
                emit("ack")
            finally:
                os.close(new_parent)
        finally:
            os.close(old_parent)

    def fs_rmtree(fd, budget):
        for name in os.listdir(fd):
            budget[0] -= 1
            if budget[0] <= 0:
                raise ValueError("delete entry limit exceeded")
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    fs_rmtree(child, budget)
                finally:
                    os.close(child)
                os.rmdir(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)

    def fs_delete(path):
        names = parts(path)
        parent = walk(fs_root, names[:-1])
        try:
            st = os.stat(names[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
                fd = os.open(names[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=parent)
                try:
                    fs_rmtree(fd, [FS_DELETE_LIMIT])
                finally:
                    os.close(fd)
                os.rmdir(names[-1], dir_fd=parent)
            else:
                os.unlink(names[-1], dir_fd=parent)
            emit("ack")
        finally:
            os.close(parent)

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
                        cwd = request.get("cwd")
                        if cwd is not None and (not request.get("terminal") or not isinstance(cwd, str)
                                                or not cwd.startswith("/") or "\0" in cwd):
                            raise ValueError("invalid terminal cwd")
                        initialized = True
                        remote = request.get("remote")
                        if remote is not None:
                            if not remote.startswith("/"):
                                raise ValueError("workspace must be absolute")
                            names = parts(remote[1:])
                            anchor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
                            try:
                                if request.get("in_place"):
                                    # 原地运行（00029）：直接打开已存在的工作区目录
                                    root = walk(anchor, names)
                                else:
                                    parent = directory(anchor, names[:-1])
                                    try:
                                        # Never reuse an existing run directory, even an empty one.
                                        os.mkdir(names[-1], 0o700, dir_fd=parent)
                                        root = os.open(names[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                                    finally:
                                        os.close(parent)
                            finally:
                                os.close(anchor)
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
                        elif request.get("cwd"):
                            # 工作区终端（00029）：交互 shell 进入设备上的工作区目录
                            os.chdir(request["cwd"])
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
                    elif kind == "fs_open" and process is None and exec_proc is None:
                        try:
                            fs_open(message["path"])
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_list" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_list(message.get("path") or "")
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_read" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_read(message["path"], message.get("limit", FS_EDIT_LIMIT))
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_write" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_write_begin(message["path"], message["expected"])
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_wchunk" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_write_chunk(base64.b64decode(message["data"], validate=True))
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_wdone" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_write_done()
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_create" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            data = message.get("data")
                            fs_create(message["path"], message["kind"],
                                      base64.b64decode(data, validate=True) if data else None)
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_rename" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_rename(message["from"], message["to"])
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
                    elif kind == "fs_delete" and fs_root is not None and process is None and exec_proc is None:
                        try:
                            fs_delete(message["path"])
                        except Exception as error:
                            code, text = fs_fail(error)
                            emit("fs_error", code=code, message=text)
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
        if fs_upload is not None:
            try:
                os.close(fs_upload["fd"])
                os.unlink(fs_upload["temp"], dir_fd=fs_upload["parent"])
            except OSError:
                pass
            try:
                os.close(fs_upload["parent"])
            except OSError:
                pass
        if fs_root is not None:
            os.close(fs_root)
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
