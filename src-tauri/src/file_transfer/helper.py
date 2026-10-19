"""Private bounded binary transfer service, prepended to the WSL helper."""
import base64
import os
import stat
import subprocess

TF_FILE_LIMIT = 2 * 1024 * 1024 * 1024
TF_CHUNK = 32768


def transfer_attrs(st):
    return dict(kind="link" if stat.S_ISLNK(st.st_mode) else
                "dir" if stat.S_ISDIR(st.st_mode) else
                "file" if stat.S_ISREG(st.st_mode) else "special",
                size=st.st_size, modified=str(st.st_mtime_ns),
                mode=stat.S_IMODE(st.st_mode) & 0o777,
                identity="%s:%s" % (st.st_dev, st.st_ino))


class TransferService:
    def __init__(self):
        self.root = None
        self.handles = {}
        self.temps = {}  # exact owned names + pinned parent descriptors
        self.next_handle = 0

    def parent(self, path):
        names = parts(path)
        return walk(self.root, names[:-1]), names[-1]

    def close(self):
        for fd, _ in self.handles.values():
            os.close(fd)
        self.handles.clear()
        for parent, name in self.temps.values():
            try:
                os.unlink(name, dir_fd=parent)
            except OSError:
                pass
            os.close(parent)
        self.temps.clear()
        if self.root is not None:
            os.close(self.root)
            self.root = None

    def handle(self, message):
        kind = message["type"]
        path = message.get("path", "")
        if kind == "tf_open":
            if not path.startswith("/") or any(p in (".", "..") for p in path.split("/")):
                raise ValueError("absolute root without dot components required")
            path = path.rstrip("/") or "/"
            self.close()
            anchor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
            try:
                names = parts(path[1:]) if path != "/" else []
                self.root = directory(anchor, names) if message.get("create") else walk(anchor, names)
            finally:
                os.close(anchor)
            root_path = os.path.realpath("/proc/self/fd/%s" % self.root)
            windows_path = None
            try:
                converted = subprocess.run(["wslpath", "-w", root_path],
                                           capture_output=True, timeout=5, check=True)
                windows_path = converted.stdout.decode("utf-8").strip()
            except (OSError, subprocess.SubprocessError, UnicodeError):
                pass
            return dict(root=root_path, windows_path=windows_path)
        if self.root is None:
            raise ValueError("transfer root is not open")
        if kind == "tf_stat":
            if not path:
                return transfer_attrs(os.fstat(self.root))
            parent, name = self.parent(path)
            try:
                try:
                    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return None
                return transfer_attrs(st)
            finally:
                os.close(parent)
        if kind == "tf_list":
            fd = walk(self.root, parts(path) if path else [])
            try:
                count = 0
                with os.scandir(fd) as entries:
                    for entry in entries:
                        count += 1
                        if count > 10000:
                            raise ValueError("directory exceeds 10000 entries")
                        result = transfer_attrs(entry.stat(follow_symlinks=False))
                        result["name"] = entry.name
                        emit("tf_reply", result=result)
                return None
            finally:
                os.close(fd)
        if kind == "tf_mkdir":
            parent, name = self.parent(path)
            try:
                try:
                    os.mkdir(name, 0o700, dir_fd=parent)
                except FileExistsError:
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(fd)
                return None
            finally:
                os.close(parent)
        if kind in ("tf_hash", "tf_chmod", "tf_unlink", "tf_rmdir"):
            parent, name = self.parent(path)
            fd = None
            try:
                if kind == "tf_rmdir":
                    os.rmdir(name, dir_fd=parent)  # empty directories only
                    return None
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError("expected a regular managed file")
                if kind == "tf_hash":
                    limit = int(message["limit"])
                    if limit < 0 or limit > 64 * 1024 * 1024 or before.st_size > limit:
                        raise ValueError("managed file exceeds hash limit")
                    digest = hashlib.sha256()
                    total = 0
                    while True:
                        data = os.read(fd, TF_CHUNK)
                        if not data:
                            break
                        total += len(data)
                        if total > limit:
                            raise ValueError("managed file grew beyond hash limit")
                        digest.update(data)
                    if transfer_attrs(os.fstat(fd)) != transfer_attrs(before):
                        raise ValueError("managed file changed while hashing")
                    return digest.hexdigest()
                current = transfer_attrs(os.stat(name, dir_fd=parent, follow_symlinks=False))
                if current != message["expected"] or current != transfer_attrs(before):
                    emit("fs_error", code="conflict", message="Managed file changed")
                    return "__reported_error__"
                if kind == "tf_chmod":
                    os.fchmod(fd, int(message["mode"]) & 0o777)
                else:
                    os.unlink(name, dir_fd=parent)
                return None
            finally:
                if fd is not None:
                    os.close(fd)
                os.close(parent)
        if kind == "tf_file":
            if len(self.handles) >= 2:
                raise ValueError("too many transfer handles")
            parent, name = self.parent(path)
            fd = None
            try:
                create = bool(message.get("create"))
                if create and not (name.startswith(".rr-transfer-") and name.endswith(".part")):
                    raise ValueError("invalid temporary filename")
                flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL) if create else os.O_RDONLY
                fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_size > TF_FILE_LIMIT:
                    raise ValueError("not a regular file within transfer limit")
                self.next_handle += 1
                handle = str(self.next_handle)
                self.handles[handle] = (fd, create)
                fd = None
                if create:
                    self.temps[path] = (os.dup(parent), name)
                return dict(handle=handle, attrs=transfer_attrs(st))
            finally:
                if fd is not None:
                    os.close(fd)
                os.close(parent)
        if kind in ("tf_read", "tf_write", "tf_close"):
            handle = message["handle"]
            fd, create = self.handles[handle]
            if kind == "tf_close":
                self.handles.pop(handle)
                try:
                    if create:
                        mode = message.get("mode")
                        if mode is not None:
                            os.fchmod(fd, int(mode) & 0o777)
                        os.fsync(fd)
                    return transfer_attrs(os.fstat(fd))
                finally:
                    os.close(fd)
            offset = int(message["offset"])
            if offset < 0 or offset > TF_FILE_LIMIT:
                raise ValueError("offset exceeds transfer limit")
            if kind == "tf_read":
                if create:
                    raise ValueError("not a reading handle")
                return base64.b64encode(os.pread(fd, TF_CHUNK, offset)).decode("ascii")
            if not create:
                raise ValueError("not a writing handle")
            data = base64.b64decode(message["data"], validate=True)
            if len(data) > TF_CHUNK or offset + len(data) > TF_FILE_LIMIT:
                raise ValueError("chunk exceeds transfer limit")
            while data:
                written = os.pwrite(fd, data, offset)
                if written <= 0:
                    raise OSError("short write")
                data, offset = data[written:], offset + written
            return None
        if kind == "tf_commit":
            temp = message["temp"]
            parent, name = self.parent(path)
            temp_parent, temp_name = self.temps[temp]
            try:
                # Commit in the same pinned parent; never publish across directories.
                a, b = os.fstat(parent), os.fstat(temp_parent)
                if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                    raise ValueError("temporary parent changed")
                try:
                    current = transfer_attrs(os.stat(name, dir_fd=parent, follow_symlinks=False))
                except FileNotFoundError:
                    current = None
                if current != message.get("expected"):
                    emit("fs_error", code="conflict", message="Target changed after preflight")
                    return "__reported_error__"
                if current is not None and current["kind"] != "file":
                    raise ValueError("not a regular target")
                if message.get("overwrite") and current is not None:
                    os.replace(temp_name, name, src_dir_fd=temp_parent, dst_dir_fd=parent)
                    self.temps.pop(temp)
                    os.close(temp_parent)
                else:
                    os.link(temp_name, name, src_dir_fd=temp_parent, dst_dir_fd=parent,
                            follow_symlinks=False)
                return None
            finally:
                os.close(parent)
        if kind == "tf_remove":
            owned = path in self.temps
            if owned:
                parent, name = self.temps[path]
            else:
                parent, name = self.parent(path)
                if not (name.startswith(".rr-transfer-") and name.endswith(".part")):
                    os.close(parent)
                    raise ValueError("invalid cleanup filename")
            try:
                os.unlink(name, dir_fd=parent)
            except FileNotFoundError:
                pass
            if owned:
                self.temps.pop(path)
            os.close(parent)
            return None
        raise ValueError("unknown transfer request")
