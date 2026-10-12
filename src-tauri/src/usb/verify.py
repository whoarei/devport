"""Read-only USB visibility/access probe; delivered on stdin, not the command line."""
import glob
import json
import os
import sys

vid, pid = sys.argv[1:3]
nodes = []
for device in glob.glob("/sys/bus/usb/devices/*"):
    try:
        def read(name):
            with open(os.path.join(device, name), encoding="ascii") as source:
                return source.read().strip()
        if read("idVendor").lower() != vid or read("idProduct").lower() != pid:
            continue
        nodes.append("/dev/bus/usb/%03d/%03d" % (int(read("busnum")), int(read("devnum"))))
    except (OSError, ValueError):
        continue
print(json.dumps({"visible": bool(nodes), "accessible": bool(nodes) and all(
    os.access(node, os.R_OK | os.W_OK) for node in nodes), "nodes": nodes}))
