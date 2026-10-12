import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "../src/i18n";
import { UsbDialog } from "../src/components/UsbDialog";
import { api, type UsbDevice, type UsbSnapshot } from "../src/api";
import { canUsbAction, usbDeviceState, usbHardwareId, useUsbStore } from "../src/usbStore";

const device: UsbDevice = {
  instance_id: "USB\\VID_1234&PID_ABCD\\test", description: "Test adapter", bus_id: "1-2",
  persisted_guid: null, client_ip_address: null, is_forced: false,
};
const snapshot: UsbSnapshot = {
  supported: true, executable: "C:\\Program Files\\usbipd-win\\usbipd.exe", version: "5.3.0",
  problem: null, wsl_problem: null, distributions: [{ name: "Ubuntu", version: 2 }, { name: "Legacy", version: 1 }], devices: [device],
};
test.before(async () => { await i18n.changeLanguage("zh"); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reset() {
  useUsbStore.getState().close();
  useUsbStore.setState({ open: true, loading: false, busy: null, error: null, completed: null,
    verification: null, snapshot, config: { distribution: "Ubuntu", user: "tester" } });
}

test("USB actions distinguish offline sharing, WSL1, and unknown attached clients", () => {
  assert.equal(usbHardwareId(device), "1234:ABCD");
  assert.equal(usbDeviceState(device), "unshared");
  assert.equal(canUsbAction("connect", device, snapshot, "Ubuntu"), true);
  assert.equal(canUsbAction("connect", device, snapshot, "Legacy"), false);
  const attached = { ...device, client_ip_address: "10.0.0.2" };
  assert.equal(usbDeviceState(attached), "attached");
  assert.equal(canUsbAction("connect", attached, snapshot, "Ubuntu"), false);
  assert.equal(canUsbAction("unshare", attached, snapshot, "Ubuntu"), false);
  const offline = { ...device, bus_id: null, persisted_guid: "record" };
  assert.equal(usbDeviceState(offline), "unplugged");
  assert.equal(canUsbAction("unshare", offline, snapshot, ""), true);
  assert.equal(canUsbAction("connect", offline, snapshot, "Ubuntu"), false);
  assert.equal(canUsbAction("connect", device, { ...snapshot, problem: { code: "service_stopped", message: "" } }, "Ubuntu"), false);
});

test("closing the dialog invalidates an in-flight snapshot", async () => {
  reset();
  const old = api.usbSnapshot;
  const pending = deferred<UsbSnapshot>();
  api.usbSnapshot = () => pending.promise;
  try {
    const refresh = useUsbStore.getState().refresh();
    useUsbStore.getState().close();
    pending.resolve({ ...snapshot, devices: [] });
    await refresh;
    assert.equal(useUsbStore.getState().open, false);
    assert.deepEqual(useUsbStore.getState().snapshot?.devices, [device]);
    assert.equal(useUsbStore.getState().loading, false);
  } finally { api.usbSnapshot = old; }
});

test("USB operation prevents duplicates/closing and refreshes changed sharing identity", async () => {
  reset();
  const oldConnect = api.usbConnect, oldSnapshot = api.usbSnapshot;
  const pending = deferred<void>();
  const connected = { ...device, persisted_guid: "new-guid", client_ip_address: "172.20.0.1" };
  let calls = 0;
  api.usbConnect = async (selector, config) => {
    calls++;
    assert.equal(selector.instance_id, device.instance_id);
    assert.deepEqual(config, { distribution: "Ubuntu", user: "tester" });
    await pending.promise;
  };
  api.usbSnapshot = async () => ({ ...snapshot, devices: [connected] });
  try {
    const operation = useUsbStore.getState().perform("connect", device);
    await useUsbStore.getState().perform("connect", device);
    useUsbStore.getState().close();
    assert.equal(useUsbStore.getState().open, true);
    assert.equal(calls, 1);
    pending.resolve();
    await operation;
    assert.equal(useUsbStore.getState().busy, null);
    assert.equal(useUsbStore.getState().completed, "connect");
    assert.deepEqual(useUsbStore.getState().snapshot?.devices, [connected]);
  } finally { api.usbConnect = oldConnect; api.usbSnapshot = oldSnapshot; }
});

test("a snapshot started before a USB operation cannot overwrite its result", async () => {
  reset();
  const oldConnect = api.usbConnect, oldSnapshot = api.usbSnapshot;
  const stale = deferred<UsbSnapshot>();
  let calls = 0;
  const connected = { ...device, client_ip_address: "172.20.0.1" };
  api.usbSnapshot = () => ++calls === 1 ? stale.promise : Promise.resolve({ ...snapshot, devices: [connected] });
  api.usbConnect = async () => {};
  try {
    const refresh = useUsbStore.getState().refresh();
    await useUsbStore.getState().perform("connect", device);
    stale.resolve(snapshot);
    await refresh;
    assert.deepEqual(useUsbStore.getState().snapshot?.devices, [connected]);
  } finally { api.usbConnect = oldConnect; api.usbSnapshot = oldSnapshot; }
});

test("UAC cancellation clears busy state and refreshes without losing diagnostics", async () => {
  reset();
  const oldConnect = api.usbConnect, oldSnapshot = api.usbSnapshot;
  api.usbConnect = async () => { throw { code: "uac_cancelled", message: "cancelled" }; };
  api.usbSnapshot = async () => snapshot;
  try {
    await useUsbStore.getState().perform("connect", device);
    assert.equal(useUsbStore.getState().busy, null);
    assert.equal(useUsbStore.getState().completed, null);
    assert.deepEqual(useUsbStore.getState().error, { code: "uac_cancelled", message: "cancelled" });
    await useUsbStore.getState().refresh(true);
    assert.equal(useUsbStore.getState().error, null);
  } finally { api.usbConnect = oldConnect; api.usbSnapshot = oldSnapshot; }
});

test("verification expires when the device changes port or the distribution disappears", async () => {
  reset();
  const attached = { ...device, client_ip_address: "172.20.0.1" };
  useUsbStore.setState({ snapshot: { ...snapshot, devices: [attached] } });
  const oldVerify = api.usbVerify, oldSnapshot = api.usbSnapshot;
  api.usbVerify = async () => ({ visible: true, accessible: true, nodes: ["/dev/bus/usb/001/002"] });
  api.usbSnapshot = async () => ({ ...snapshot, devices: [attached] });
  try {
    await useUsbStore.getState().perform("verify", attached);
    assert.equal(useUsbStore.getState().verification?.result.accessible, true);
    api.usbSnapshot = async () => ({ ...snapshot, devices: [{ ...attached, bus_id: "1-3" }] });
    await useUsbStore.getState().refresh();
    assert.equal(useUsbStore.getState().verification, null);
    api.usbSnapshot = async () => ({ ...snapshot, distributions: [{ name: "Other", version: 2 }] });
    await useUsbStore.getState().refresh();
    assert.deepEqual(useUsbStore.getState().config, { distribution: "Other", user: "" });
  } finally { api.usbVerify = oldVerify; api.usbSnapshot = oldSnapshot; }
});

test("USB dialog renders offline records, client addresses, permissions, and the installation guide capability", (t) => {
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  reset();
  useUsbStore.setState({ snapshot: { ...snapshot, devices: [
    { ...device, bus_id: null, persisted_guid: "record", description: "offline-adapter" },
    { ...device, instance_id: "attached", client_ip_address: "10.0.0.2", description: "attached-adapter" },
  ] } });
  const markup = renderToStaticMarkup(createElement(UsbDialog));
  assert.ok(markup.includes("offline-adapter"));
  assert.ok(markup.includes("未插入"));
  assert.ok(markup.includes("10.0.0.2"));
  assert.ok(markup.includes("客户端已连接"));
  assert.ok(markup.includes("验证"));
  assert.ok(markup.includes("所有 WSL2 发行版"));
  useUsbStore.setState({ snapshot: { ...snapshot, problem: { code: "not_installed", message: "missing" } } });
  const missing = renderToStaticMarkup(createElement(UsbDialog));
  assert.ok(missing.includes("官方安装指南"));
  assert.ok(missing.includes("winget install --interactive"));
  const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
  const opener = capability.permissions.find((p: { identifier?: string }) => p.identifier === "opener:allow-open-url");
  assert.ok(opener.allow.some((entry: { url: string }) => entry.url === "https://learn.microsoft.com/en-us/windows/wsl/connect-usb"));
});
