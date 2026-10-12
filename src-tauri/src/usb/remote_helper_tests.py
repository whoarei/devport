"""Hardware-free tests, run on POSIX Python (optionally through local WSL)."""
import contextlib
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


HOST = "192.168.1.5"
PORTS = """Imported USB devices
====================
Port 03: <Port in Use> at High Speed(480Mbps)
       Test device
       5-2 -> usbip://192.168.1.5:3240/1-2
           -> remote bus/dev 001/002
Port 04: <Port in Use> at High Speed(480Mbps)
       Other device
       5-3 -> usbip://192.168.1.6:3240/1-2
           -> remote bus/dev 001/003
"""
REQUEST = {"action": "connect", "host_ip": HOST, "bus_id": "1-2", "vid": "1234", "pid": "abcd"}


class RemoteUsbTests(unittest.TestCase):
    def exchange(self, response):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        requests = []
        def serve():
            try:
                with listener.accept()[0] as stream:
                    requests.append(helper.receive(stream, 8))
                    for offset in range(0, len(response), 3):
                        stream.sendall(response[offset:offset + 3])
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                listener.close()
        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        try:
            return helper.exports("127.0.0.1", port)
        finally:
            worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(requests, [struct.pack("!HHI", 0x0111, 0x8005, 0)])

    def test_export_protocol_handles_fragmentation_and_interface_records(self):
        record = b"/sys/device".ljust(256, b"\0") + b"1-2".ljust(32, b"\0")
        record += struct.pack("!IIIHHHBBBBBB", 1, 2, 3, 0x1234, 0xabcd, 0x100, 0, 0, 0, 1, 1, 1)
        self.assertEqual(len(record), 312)
        response = struct.pack("!HHII", 0x0111, 0x0005, 0, 1) + record + b"\xff\x00\x00\x00"
        self.assertEqual(self.exchange(response), [{"bus_id": "1-2", "vid": "1234", "pid": "abcd"}])

    def test_export_protocol_rejects_truncation_and_oversized_counts(self):
        for response, code in [(b"\x01", "usbip_protocol"), (struct.pack("!HHII", 0x0111, 0x0005, 0, 257), "output_limit")]:
            with self.assertRaises(helper.Failure) as failure:
                self.exchange(response)
            self.assertEqual(failure.exception.code, code)

    def test_client_port_lookup_requires_exact_host_bus_and_unique_record(self):
        entries = helper.parse_ports(PORTS)
        self.assertEqual(helper.matching_port(entries, HOST, "1-2")["port"], 3)
        for records in [entries + [entries[0]], entries[1:]]:
            with self.assertRaises(helper.Failure) as failure:
                helper.matching_port(records, HOST, "1-2")
            self.assertEqual(failure.exception.code, "remote_not_attached")

    @contextlib.contextmanager
    def environment(self):
        with tempfile.TemporaryDirectory(prefix="rr-usb-test-") as directory:
            original_open = os.open
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(helper.os, "open", side_effect=lambda _path, flags, mode: original_open(os.path.join(directory, "operation.lock"), flags, mode)))
                stack.enter_context(patch.object(helper, "executable", side_effect=lambda name: "/usr/sbin/" + name))
                stack.enter_context(patch.object(helper.glob, "glob", return_value=["/sys/devices/platform/vhci_hcd.0"]))
                stack.enter_context(patch.object(helper, "exports", return_value=[{"bus_id": "1-2", "vid": "1234", "pid": "abcd"}]))
                yield

    def test_connect_uses_argv_and_confirms_the_import_port(self):
        with self.environment(), patch.object(helper, "privileged", side_effect=["", "", PORTS]) as run:
            self.assertEqual(helper.handle(REQUEST), {"port": 3})
            self.assertEqual(run.call_args_list[1].args[0], ["/usr/sbin/usbip", "attach", "--remote", HOST, "--busid", "1-2"])

    def test_changed_export_is_rejected_before_any_privileged_command(self):
        with self.environment(), patch.object(helper, "exports", return_value=[{"bus_id": "1-2", "vid": "9999", "pid": "abcd"}]), patch.object(helper, "privileged") as run:
            with self.assertRaises(helper.Failure) as failure:
                helper.handle(REQUEST)
            self.assertEqual(failure.exception.code, "device_changed")
            run.assert_not_called()

    def test_detach_targets_only_its_exact_port_and_leaves_other_clients(self):
        other = PORTS[PORTS.index("Port 04:"):]
        with self.environment(), patch.object(helper, "privileged", side_effect=[PORTS, PORTS, "", other]) as run:
            result = helper.handle(dict(REQUEST, action="disconnect"))
            self.assertEqual(result, {"port": 3})
            self.assertEqual(run.call_args_list[2].args[0], ["/usr/sbin/usbip", "detach", "--port", "3"])

    def test_detach_rejects_port_reuse_before_mutation(self):
        changed = PORTS.replace("Port 03:", "Port 07:")
        with self.environment(), patch.object(helper, "privileged", side_effect=[PORTS, changed]) as run:
            with self.assertRaises(helper.Failure) as failure:
                helper.handle(dict(REQUEST, action="disconnect"))
            self.assertEqual(failure.exception.code, "device_changed")
            self.assertEqual(run.call_count, 2)

    def test_verify_reads_only_the_matching_local_bus_and_user_permissions(self):
        attrs = {"idVendor": "1234", "idProduct": "abcd", "busnum": "005", "devnum": "002"}
        def read(directory, name):
            self.assertEqual(directory, "/sys/bus/usb/devices/5-2")
            return attrs[name]
        with self.environment(), patch.object(helper, "privileged", return_value=PORTS), patch.object(helper, "read_attr", side_effect=read), patch.object(helper.os, "access", return_value=False):
            self.assertEqual(helper.handle(dict(REQUEST, action="verify")), {"visible": True, "accessible": False, "nodes": ["/dev/bus/usb/005/002"]})

    def test_non_root_uses_noninteractive_sudo_with_structured_arguments(self):
        with patch.object(helper.os, "geteuid", return_value=1000), patch.object(helper, "executable", return_value="/usr/bin/sudo"), patch.object(helper, "command", return_value="ok") as run:
            helper.privileged(["/usr/sbin/usbip", "port"])
            run.assert_called_once_with(["/usr/bin/sudo", "-n", "--", "/usr/sbin/usbip", "port"])

    def test_invalid_request_cannot_reach_privileged_operations(self):
        for request in [dict(REQUEST, host_ip="127.0.0.1"), dict(REQUEST, bus_id="1-2;id"), dict(REQUEST, action="detach_all")]:
            with patch.object(helper, "privileged") as run:
                with self.assertRaises(helper.Failure) as failure:
                    helper.handle(request)
                self.assertEqual(failure.exception.code, "invalid_input")
                run.assert_not_called()

    def test_real_command_capture_has_size_and_time_limits(self):
        for script, timeout, code in [("import time;time.sleep(10)", 0.1, "timeout"), ("import os,time;os.close(1);os.close(2);time.sleep(10)", 0.1, "timeout"), ("import sys;sys.stdout.buffer.write(b'x'*65537)", 5, "output_limit")]:
            with self.assertRaises(helper.Failure) as failure:
                helper.command([sys.executable, "-I", "-c", script], timeout=timeout)
            self.assertEqual(failure.exception.code, code)


suite = unittest.defaultTestLoader.loadTestsFromTestCase(RemoteUsbTests)
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
