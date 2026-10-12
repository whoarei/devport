"""Short-lived, unprivileged SSH control helper for Linux USB/IP clients."""
import fcntl
import glob
import ipaddress
import json
import os
import platform
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

LIMIT = 65536
BUS = re.compile(r"[1-9][0-9]{0,4}-[1-9][0-9]{0,4}\Z")
LOCAL_BUS = re.compile(r"[1-9][0-9]*-[1-9][0-9]*(?:\.[1-9][0-9]*)*\Z")


class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, str(message)


def command(argv, timeout=15):
    env = dict(os.environ, LC_ALL="C", LANG="C")
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, start_new_session=True)
    buffers = [bytearray(), bytearray()]
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            for index, stream in enumerate((proc.stdout, proc.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, index)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise Failure("timeout", "remote USB command timed out")
                for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        buffers[key.data].extend(chunk)
                        if len(buffers[key.data]) > LIMIT:
                            raise Failure("output_limit", "remote USB command exceeded 64 KiB")
            try:
                proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as exc:
                raise Failure("timeout", "remote USB command did not exit") from exc
        out, err = (bytes(buf).decode("utf-8", "replace") for buf in buffers)
        if proc.returncode:
            code = "sudo_required" if argv[0].endswith("/sudo") and err.lstrip().startswith("sudo:") else "remote_command_failed"
            raise Failure(code, (out + "\n" + err).strip() or "exit code %s" % proc.returncode)
        return out
    finally:
        # Reap our process group. A sudo child may deny signals to an unprivileged
        # caller; still bound cleanup and report an unconfirmed timeout to the UI.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        proc.stdout.close()
        proc.stderr.close()


def executable(name):
    # Distribution-supplied tools only, never a program in the workspace/PATH.
    for directory in ("/usr/sbin", "/usr/bin", "/sbin", "/bin"):
        path = os.path.join(directory, name)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def privileged(argv):
    if os.geteuid() == 0:
        return command(argv)
    sudo = executable("sudo")
    if not sudo:
        raise Failure("sudo_required", "use root or configure non-interactive sudo for usbip")
    return command([sudo, "-n", "--"] + argv)


def receive(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.recv(length - len(data))
        if not part:
            raise Failure("usbip_protocol", "USB/IP server closed an incomplete response")
        data.extend(part)
    return bytes(data)


def exports(host, port=3240):
    # Linux USB/IP OP_REQ_DEVLIST; packed structs are defined by usbip_network.h.
    try:
        with socket.create_connection((host, port), timeout=5) as stream:
            stream.settimeout(5)
            stream.sendall(struct.pack("!HHI", 0x0111, 0x8005, 0))
            version, operation, status = struct.unpack("!HHI", receive(stream, 8))
            if (version, operation, status) != (0x0111, 0x0005, 0):
                raise Failure("usbip_protocol", "invalid USB/IP export response")
            count, = struct.unpack("!I", receive(stream, 4))
            if count > 256:
                raise Failure("output_limit", "USB/IP server advertised too many devices")
            devices = []
            for _ in range(count):
                data = receive(stream, 312)
                bus = data[256:288].split(b"\0", 1)[0].decode("ascii")
                if not BUS.fullmatch(bus):
                    raise Failure("usbip_protocol", "invalid exported BUSID")
                vid, pid = struct.unpack("!HH", data[300:304])
                receive(stream, data[311] * 4)
                devices.append({"bus_id": bus, "vid": "%04x" % vid, "pid": "%04x" % pid})
            return devices
    except (OSError, UnicodeError) as exc:
        raise Failure("network_unreachable", exc) from exc


def parse_ports(text):
    result, port = [], None
    for line in text.splitlines():
        match = re.match(r"^Port\s+([0-9]+):", line)
        if match:
            port = int(match[1])
            if port > 255:
                raise Failure("invalid_state", "invalid USB/IP client port")
            continue
        match = re.match(r"^\s+(\S+)\s+->\s+usbip://([^\s:]+):([0-9]+)/([^\s]+)\s*$", line)
        if match and port is not None:
            local_bus, host, server_port, bus = match.groups()
            if BUS.fullmatch(bus):
                result.append({"port": port, "local_bus_id": local_bus, "host": host,
                               "server_port": int(server_port), "bus_id": bus})
    return result


def matching_port(ports, host, bus):
    matches = [entry for entry in ports if entry["host"] == host and
               entry["server_port"] == 3240 and entry["bus_id"] == bus]
    if len(matches) != 1:
        raise Failure("remote_not_attached", "no unique import of %s:3240/%s on this Linux client" % (host, bus))
    return matches[0]


def read_attr(directory, name):
    with open(os.path.join(directory, name), encoding="ascii") as source:
        return source.read(256).strip()


def verify_port(entry, vid, pid):
    bus = entry["local_bus_id"]
    if not LOCAL_BUS.fullmatch(bus):
        return {"visible": False, "accessible": False, "nodes": []}
    directory = os.path.join("/sys/bus/usb/devices", bus)
    try:
        if read_attr(directory, "idVendor").lower() != vid or read_attr(directory, "idProduct").lower() != pid:
            raise Failure("device_changed", "imported device VID:PID changed")
        node = "/dev/bus/usb/%03d/%03d" % (int(read_attr(directory, "busnum")), int(read_attr(directory, "devnum")))
        return {"visible": True, "accessible": os.access(node, os.R_OK | os.W_OK), "nodes": [node]}
    except OSError:
        return {"visible": False, "accessible": False, "nodes": []}


def probe(host):
    tools = {name: executable(name) for name in ("usbip", "sudo", "modprobe")}
    reachable, network_error, listed = False, None, []
    try:
        listed = exports(host)
        reachable = True
    except Failure as exc:
        network_error = exc.message
    return {"host_ip": host, "kernel": platform.release(), "usbip_path": tools["usbip"],
            "vhci_loaded": bool(glob.glob("/sys/devices/platform/vhci_hcd*")),
            "can_load_module": bool(tools["modprobe"]),
            "privilege": "root" if os.geteuid() == 0 else "sudo" if tools["sudo"] else "unavailable",
            "reachable": reachable, "network_error": network_error, "exports": listed}


def handle(request):
    if platform.system() != "Linux" or sys.version_info < (3, 8):
        raise Failure("linux_required", "Linux and Python 3.8+ are required")
    action, host = request.get("action"), request.get("host_ip")
    try:
        address = ipaddress.IPv4Address(host)
        if address.is_loopback or int(address) >> 24 == 0 or int(address) >> 24 >= 224:
            raise ValueError("non-loopback Windows IPv4 required")
    except (ValueError, TypeError) as exc:
        raise Failure("invalid_input", exc) from exc
    host = str(address)
    if action == "probe":
        return probe(host)
    if action not in ("connect", "disconnect", "verify"):
        raise Failure("invalid_input", "unsupported remote USB action")
    bus, vid, pid = (request.get(key, "") for key in ("bus_id", "vid", "pid"))
    if not BUS.fullmatch(bus) or not re.fullmatch(r"[0-9a-f]{4}", vid) or not re.fullmatch(r"[0-9a-f]{4}", pid):
        raise Failure("invalid_input", "invalid remote USB identity")
    usbip = executable("usbip")
    if not usbip:
        raise Failure("usbip_missing", "install the distribution's usbip client tools")
    lock_path = "/tmp/.remote-runner-usb-%d.lock" % os.geteuid()
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or not stat.S_ISREG(info.st_mode):
            raise Failure("permission_denied", "invalid remote USB operation lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Failure("busy", "another USB helper is active on this Linux account") from exc
        if action == "connect":
            available = exports(host)
            if not any(entry == {"bus_id": bus, "vid": vid, "pid": pid} for entry in available):
                raise Failure("device_changed", "shared BUSID + VID:PID not found on the Windows host")
            if not glob.glob("/sys/devices/platform/vhci_hcd*"):
                modprobe = executable("modprobe")
                if not modprobe:
                    raise Failure("vhci_missing", "load vhci_hcd on the Linux target")
                privileged([modprobe, "vhci_hcd"])
            ports = parse_ports(privileged([usbip, "port"]))
            if any(entry["host"] == host and entry["bus_id"] == bus and entry["server_port"] == 3240 for entry in ports):
                raise Failure("attached", "the device is already imported on this Linux client")
            privileged([usbip, "attach", "--remote", host, "--busid", bus])
            entry = matching_port(parse_ports(privileged([usbip, "port"])), host, bus)
            return {"port": entry["port"]}
        entry = matching_port(parse_ports(privileged([usbip, "port"])), host, bus)
        if action == "verify":
            return verify_port(entry, vid, pid)
        # Repeat the identity lookup immediately before detaching; never guess or detach all.
        now = matching_port(parse_ports(privileged([usbip, "port"])), host, bus)
        if now != entry:
            raise Failure("device_changed", "Linux imported port changed before detach")
        privileged([usbip, "detach", "--port", str(entry["port"])])
        remaining = parse_ports(privileged([usbip, "port"]))
        if any(item["host"] == host and item["server_port"] == 3240 and item["bus_id"] == bus for item in remaining):
            raise Failure("remote_command_failed", "Linux still reports the device as imported")
        return {"port": entry["port"]}
    finally:
        os.close(fd)


def main(request):
    def interrupted(signum, _frame):
        raise Failure("timeout", "remote USB helper interrupted or timed out")
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
        signal.signal(signum, interrupted)
    signal.alarm(35)
    try:
        result = {"type": "usb_result", "version": 1, "ok": True, "data": handle(request)}
        code = 0
    except Failure as exc:
        result = {"type": "usb_result", "version": 1, "ok": False, "code": exc.code, "message": exc.message}
        code = 1
    except Exception as exc:
        result = {"type": "usb_result", "version": 1, "ok": False, "code": "remote_command_failed", "message": str(exc)}
        code = 1
    print(json.dumps(result), flush=True)
    signal.alarm(0)
    return code


if __name__ == "__main__":
    # The Rust bootstrap supplies a fixed source and a structured request.
    sys.exit(main(payload["request"]))
