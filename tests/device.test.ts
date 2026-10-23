import test from "node:test";
import assert from "node:assert/strict";
import { deviceLabel, emptyDevice } from "../src/components/DeviceEditor";
import { api, DeviceProfile } from "../src/api";
import { selectedDeviceAfterLoad, useAppStore } from "../src/store";
import { automaticDeviceName } from "../src/deviceNaming";
import { deleteDevice, loadDeletedDeviceEvents, reorderDevices, saveDevice } from "../src/deviceActions";
import { eventText, useEventStore } from "../src/eventStore";
import i18n from "../src/i18n";

function resetDeviceActions(t: test.TestContext) {
  const app = useAppStore.getState();
  const events = useEventStore.getState();
  t.after(() => { useAppStore.setState(app, true); useEventStore.setState(events, true); });
  useEventStore.setState({ events: [], running: [] });
  const first = { ...emptyDevice(), id: "first", name: "first", host: "example.com", is_default: true };
  const second = { ...emptyDevice(), id: "second", name: "second", host: "second.example.com" };
  useAppStore.setState({ devices: [first, second], selectedDeviceId: first.id, deviceManagerOpen: true });
  return { first, second };
}

test("device deletion skips confirmation and its event can restore the original identity", async (t) => {
  const { first, second } = resetDeviceActions(t);
  const deleted_at = "2026-10-21T07:00:00Z";
  const deletion = t.mock.method(api, "deleteDevice", async (id: string) => ({ id, name: first.name, deleted_at }));
  let active = [second];
  t.mock.method(api, "listDevices", async () => active);
  t.mock.method(api, "restoreDevice", async (id: string) => { assert.equal(id, first.id); active = [first, second]; return first; });
  assert.equal(await deleteDevice(first), true);
  assert.equal(deletion.mock.callCount(), 1);
  assert.equal(useAppStore.getState().deviceManagerOpen, true);
  assert.equal(useAppStore.getState().selectedDeviceId, second.id);
  const event = useEventStore.getState().events[0];
  assert.equal(event.timestamp, Date.parse(deleted_at));
  assert.equal(event.dismissible, false);
  await useEventStore.getState().runAction(event.id);
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [first.id, second.id]);
  assert.equal(useAppStore.getState().selectedDeviceId, second.id);
  assert.equal(useEventStore.getState().events.length, 0);
});

test("deleted device events are rebuilt without duplicates and remain translatable", async (t) => {
  resetDeviceActions(t);
  const originalLanguage = i18n.language;
  t.after(() => { void i18n.changeLanguage(originalLanguage); });
  t.mock.method(api, "listDeletedDevices", async () => [{ id: "old", name: "old box", deleted_at: "2026-10-20T02:00:00Z" }]);
  await loadDeletedDeviceEvents();
  await loadDeletedDeviceEvents();
  assert.equal(useEventStore.getState().events.length, 1);
  const event = useEventStore.getState().events[0];
  assert.equal(event.timestamp, Date.parse("2026-10-20T02:00:00Z"));
  await i18n.changeLanguage("zh");
  assert.equal(eventText(event.action!.label), "撤销");
  await i18n.changeLanguage("en");
  assert.equal(eventText(event.action!.label), "Undo");
});

test("deletion failure keeps the device and reports an event; restoration failure remains retryable", async (t) => {
  const { first, second } = resetDeviceActions(t);
  const deletion = t.mock.method(api, "deleteDevice", async () => { throw new Error("disk full"); });
  assert.equal(await deleteDevice(first), false);
  assert.deepEqual(useAppStore.getState().devices, [first, second]);
  assert.equal(useEventStore.getState().events[0].level, "error");
  deletion.mock.mockImplementation(async () => ({ id: first.id, name: first.name, deleted_at: new Date().toISOString() }));
  t.mock.method(api, "listDevices", async () => [second]);
  const restoration = t.mock.method(api, "restoreDevice", async () => { throw new Error("restore failed"); });
  await deleteDevice(first);
  const event = useEventStore.getState().events.find((event) => event.action)!;
  await useEventStore.getState().runAction(event.id);
  assert.equal(useEventStore.getState().events.find((item) => item.id === event.id)?.actionError, "restore failed");
  assert.deepEqual(useAppStore.getState().devices, [second]);
  restoration.mock.mockImplementation(async () => first);
  t.mock.method(api, "listDevices", async () => [first, second]);
  await useEventStore.getState().runAction(event.id);
  assert.ok(useAppStore.getState().devices.some((device) => device.id === first.id));
  assert.ok(!useEventStore.getState().events.some((item) => item.id === event.id));
});

test("a device-list refresh failure never removes the undo action after a successful deletion", async (t) => {
  const { first, second } = resetDeviceActions(t);
  t.mock.method(api, "deleteDevice", async () => ({ id: first.id, name: first.name, deleted_at: new Date().toISOString() }));
  t.mock.method(api, "listDevices", async () => { throw new Error("refresh unavailable"); });
  assert.equal(await deleteDevice(first), true);
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [second.id]);
  assert.equal(useAppStore.getState().devices[0].is_default, true);
  assert.ok(useEventStore.getState().events.some((event) => event.action));
  assert.ok(useEventStore.getState().events.some((event) => event.level === "error"));
});

test("an old event action cannot dismiss a replacement event with the same ID", async (t) => {
  resetDeviceActions(t);
  let finish!: () => void;
  let calls = 0;
  useEventStore.getState().add({ id: "event", timestamp: 1, title: "first", action: { label: "run", run: () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); } } });
  const pending = useEventStore.getState().runAction("event");
  await useEventStore.getState().runAction("event");
  assert.equal(calls, 1);
  useEventStore.getState().add({ id: "event", timestamp: 2, title: "replacement" });
  finish();
  await pending;
  assert.equal(useEventStore.getState().events[0].title, "replacement");
});

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

test("reordering uses confirmed snapshots and preserves the selected and default device", async (t) => {
  const { first, second } = resetDeviceActions(t);
  let finish!: (devices: DeviceProfile[]) => void;
  const reorder = t.mock.method(api, "reorderDevices", () => new Promise<DeviceProfile[]>((resolve) => { finish = resolve; }));
  const pending = reorderDevices([second.id, first.id]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [first.id, second.id]);
  finish([second, first]);
  await pending;
  assert.deepEqual(reorder.mock.calls[0].arguments, [[second.id, first.id]]);
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [second.id, first.id]);
  assert.equal(useAppStore.getState().selectedDeviceId, first.id);
  assert.equal(useAppStore.getState().devices.find((device) => device.is_default)?.id, first.id);
});

test("a failed reorder refreshes the roster and does not revive a concurrently deleted device", async (t) => {
  const { first, second } = resetDeviceActions(t);
  t.mock.method(api, "reorderDevices", async () => { throw new Error("device list changed"); });
  t.mock.method(api, "listDevices", async () => [{ ...second, is_default: true }]);
  await assert.rejects(reorderDevices([second.id, first.id]), /device list changed/);
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [second.id]);
  assert.equal(useAppStore.getState().selectedDeviceId, second.id);
});

test("a failed reorder and failed refresh keep the saved list intact", async (t) => {
  const { first, second } = resetDeviceActions(t);
  t.mock.method(api, "reorderDevices", async () => { throw new Error("disk full"); });
  t.mock.method(api, "listDevices", async () => { throw new Error("unavailable"); });
  await assert.rejects(reorderDevices([second.id, first.id]), /disk full/);
  assert.deepEqual(useAppStore.getState().devices, [first, second]);
  assert.equal(useAppStore.getState().selectedDeviceId, first.id);
});

test("old list responses cannot overwrite a confirmed reorder", async (t) => {
  const { first, second } = resetDeviceActions(t);
  let finish!: (devices: DeviceProfile[]) => void;
  t.mock.method(api, "listDevices", () => new Promise<DeviceProfile[]>((resolve) => { finish = resolve; }));
  const oldLoad = useAppStore.getState().loadDevices();
  t.mock.method(api, "reorderDevices", async () => [second, first]);
  await reorderDevices([second.id, first.id]);
  finish([first, second]);
  await oldLoad;
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [second.id, first.id]);
});

test("a confirmed new device stays saved if refreshing fails", async (t) => {
  const { first, second } = resetDeviceActions(t);
  const saved = { ...emptyDevice(), id: "new", name: "new device", host: "new.example.com", revision: "confirmed" };
  t.mock.method(api, "saveDevice", async () => saved);
  t.mock.method(api, "listDevices", async () => { throw new Error("refresh failed"); });
  assert.equal((await saveDevice({ ...saved, id: "" })).id, saved.id);
  assert.deepEqual(useAppStore.getState().devices.map((device) => device.id), [first.id, second.id, saved.id]);
  assert.equal(useAppStore.getState().devices[2].revision, "confirmed");
  assert.ok(useEventStore.getState().events.some((event) => event.level === "error"));
});

test("device save, reorder and deletion serialize and recover after a failed operation", async (t) => {
  const { first, second } = resetDeviceActions(t);
  const calls: string[] = [];
  let release!: (device: DeviceProfile) => void;
  let active = [first, second];
  t.mock.method(api, "saveDevice", () => { calls.push("save"); return new Promise<DeviceProfile[]>((resolve) => {
    release = (device) => { active = [device, second]; resolve(active); };
  }).then((devices) => devices[0]); });
  t.mock.method(api, "listDevices", async () => active);
  t.mock.method(api, "reorderDevices", async () => { calls.push("order"); throw new Error("write failed"); });
  t.mock.method(api, "deleteDevice", async () => { calls.push("delete"); active = [active[0]]; return { id: second.id, name: second.name, deleted_at: new Date().toISOString() }; });
  const edited = { ...first, name: "updated", revision: "new revision" };
  const saving = saveDevice(edited);
  const ordering = reorderDevices([second.id, first.id]);
  const rejection = assert.rejects(ordering, /write failed/);
  const deleting = deleteDevice(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["save"]);
  release(edited);
  assert.equal((await saving).revision, edited.revision);
  await rejection;
  await deleting;
  assert.deepEqual(calls, ["save", "order", "delete"]);
  assert.equal(useAppStore.getState().devices[0].name, "updated");
});
