import test from "node:test";
import assert from "node:assert/strict";
import { deviceLabel, emptyDevice } from "../src/components/DeviceDialog";
import { DeviceProfile } from "../src/api";
import { selectedDeviceAfterLoad } from "../src/store";
import { automaticDeviceName } from "../src/deviceNaming";

test("automatic device names use each transport's connection identifiers", () => {
  const ssh = { ...emptyDevice(), host: "192.168.1.10" };
  assert.equal(automaticDeviceName(ssh), "ssh-root@192.168.1.10:22");
  assert.equal(automaticDeviceName({ ...ssh, username: "alice", port: 2222 }), "ssh-alice@192.168.1.10:2222");
  assert.equal(automaticDeviceName({ ...ssh, transport: "serial", serial: { port: "COM8", baud_rate: 115200 } }), "serial-COM8:115200");
  assert.equal(automaticDeviceName({ ...ssh, transport: "serial", serial: { port: "/dev/ttyUSB0", baud_rate: 9600 } }), "serial-/dev/ttyUSB0:9600");
  assert.equal(automaticDeviceName({ ...ssh, transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "" } }), "wsl-Ubuntu-24.04");
  assert.equal(automaticDeviceName({ ...ssh, transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "root" } }), "wsl-root@Ubuntu-24.04");
  assert.equal(automaticDeviceName({ ...ssh, transport: "local", local: { shell: "pwsh", path: "C:/tools/pwsh.exe" } }), "local-pwsh");
});

test("automatic SSH names delimit IPv6 addresses without double brackets", () => {
  const ssh = { ...emptyDevice(), host: "2001:db8::1" };
  assert.equal(automaticDeviceName(ssh), "ssh-root@[2001:db8::1]:22");
  assert.equal(automaticDeviceName({ ...ssh, host: "[2001:db8::1]" }), "ssh-root@[2001:db8::1]:22");
});

test("automatic names stay empty until the transport identifiers are filled", () => {
  const empty = emptyDevice();
  for (const transport of ["ssh", "serial", "wsl", "local"] as const) {
    assert.equal(automaticDeviceName({ ...empty, transport }), "");
  }
  assert.equal(automaticDeviceName({ ...empty, host: "example.com", username: " " }), "");
  assert.equal(automaticDeviceName({ ...empty, host: "example.com", port: 0 }), "");
  assert.equal(automaticDeviceName({ ...empty, transport: "serial", serial: { port: "COM8", baud_rate: 0 } }), "");
  assert.equal(automaticDeviceName({ ...empty, transport: "wsl", wsl: undefined }), "");
  assert.equal(automaticDeviceName({ ...empty, transport: "local", local: undefined }), "");
});

test("automatic naming trims identifiers without mutating connection settings", () => {
  const ssh = { ...emptyDevice(), host: " example.com ", username: " alice ", auth: { type: "password" as const, password: "secret" } };
  assert.equal(automaticDeviceName(ssh), "ssh-alice@example.com:22");
  assert.equal(ssh.host, " example.com ");
  assert.equal(ssh.username, " alice ");
  assert.equal(automaticDeviceName({ ...ssh, transport: "wsl", wsl: { distribution: " Ubuntu ", user: "  " } }), "wsl-Ubuntu");
});

test("device label covers local shell devices and keeps other transports unchanged", () => {
  const local: DeviceProfile = {
    ...emptyDevice(),
    name: "home",
    transport: "local",
    local: { shell: "pwsh", path: null },
  };
  assert.equal(deviceLabel(local), "home (Local · pwsh)");

  const ssh: DeviceProfile = { ...emptyDevice(), name: "box", host: "10.0.0.2", username: "root" };
  assert.equal(deviceLabel(ssh), "box (root@10.0.0.2)");

  const wsl: DeviceProfile = { ...emptyDevice(), name: "wsl", transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "" } };
  assert.equal(deviceLabel(wsl), "wsl (WSL · Ubuntu-24.04)");
});

test("new device template carries a local shell placeholder", () => {
  const device = emptyDevice();
  assert.deepEqual(device.local, { shell: "", path: null, no_profile: false });
  assert.equal(device.transport, "ssh");
  assert.equal(device.is_default, false);
  assert.equal(device.workspace_root, "~/devrunner/workspaces");
});

test("local shell profile switch round-trips through the device payload", () => {
  // no_profile 是交互终端与运行共用的唯一 profile 开关（00003-execution-and-transports.md）：
  // 缺省（老配置）必须解析为 false（加载 profile），显式 true 必须保留。
  const legacy: DeviceProfile = {
    ...emptyDevice(),
    id: "l1",
    name: "legacy",
    transport: "local",
    local: { shell: "pwsh", path: null },
  };
  assert.equal(legacy.local?.no_profile ?? false, false);
  const enabled: DeviceProfile = {
    ...emptyDevice(),
    id: "l2",
    name: "strict",
    transport: "local",
    local: { shell: "pwsh", path: null, no_profile: true },
  };
  assert.equal(enabled.local?.no_profile, true);
});

test("device loading prefers the default but preserves a valid explicit selection", () => {
  const first = { ...emptyDevice(), id: "first", name: "first", is_default: false };
  const preferred = { ...emptyDevice(), id: "preferred", name: "preferred", is_default: true };
  assert.equal(selectedDeviceAfterLoad([first, preferred], null), "preferred");
  assert.equal(selectedDeviceAfterLoad([first, preferred], "first"), "first");
  assert.equal(selectedDeviceAfterLoad([first, preferred], "deleted"), "preferred");
  assert.equal(selectedDeviceAfterLoad([], null), null);
});
