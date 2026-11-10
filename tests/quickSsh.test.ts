import test from "node:test";
import assert from "node:assert/strict";
import { api, deviceWorkspace, localWorkspace } from "../src/api";
import { emptyDevice } from "../src/components/DeviceEditor";
import { activateQuickSsh, connectQuickSsh, recentSshAddresses, rememberSshAddress, useQuickSshStore } from "../src/quickSsh";
import { useAppStore } from "../src/store";
import { useTerminalStore } from "../src/terminalStore";
import { saveTemporaryDevice } from "../src/deviceActions";
import { emptyEnvironment, persistentEnvironment } from "../src/environmentState";
import { editorFileKey } from "../src/editorSources";

const temporary = () => ({ ...emptyDevice(), id: "temp-ssh-one", name: "ssh-alice@server:2222", host: "server", port: 2222,
  username: "alice", temporary: true, revision: "before", auth: { type: "password" as const, password: "do-not-write" } });
const change = { code: "ssh_host_key_changed", addr: "server:2222", saved_fingerprint: "old", received_fingerprint: "new" };
function reset(t: test.TestContext) {
  const app = useAppStore.getState(), terminals = useTerminalStore.getState(), quick = useQuickSshStore.getState();
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) } });
  t.after(() => {
    useAppStore.setState(app, true); useTerminalStore.setState(terminals, true); useQuickSshStore.setState(quick, true);
    if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  useAppStore.setState({ devices: [], selectedDeviceId: null, openTabs: [], recentWorkspaces: [], workspace: null });
  return storage;
}

test("quick SSH retries only explicitly approved host keys and cancellation creates no device", async (t) => {
  reset(t);
  const device = temporary();
  let calls = 0;
  t.mock.method(api, "quickConnectSsh", async (request, confirmation) => {
    assert.equal(request.address, "alice@server:2222");
    if (++calls === 1) throw change;
    assert.deepEqual(confirmation, { addr: change.addr, saved_fingerprint: "old", received_fingerprint: "new" });
    return device;
  });
  assert.equal(await connectQuickSsh("alice@server:2222", device.auth, async () => false), null);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await connectQuickSsh("alice@server:2222", device.auth, async () => true), device);
  assert.equal(calls, 2);
  assert.equal(useAppStore.getState().devices.length, 0);
});

test("authentication errors leave history and devices untouched", async (t) => {
  const storage = reset(t);
  t.mock.method(api, "quickConnectSsh", async () => { throw { code: "ssh_auth_failed" }; });
  await assert.rejects(connectQuickSsh("alice@server", temporary().auth, async () => true));
  assert.equal(storage.size, 0);
  assert.equal(useAppStore.getState().devices.length, 0);
});

test("activation selects a temporary device, opens both panels and terminal, and stores addresses only", (t) => {
  const storage = reset(t);
  const open = t.mock.method(useTerminalStore.getState(), "open", async () => {});
  useAppStore.setState((s) => ({ layout: { ...s.layout, sidebarVisible: false,
    panelVisible: { ...s.layout.panelVisible, console: false, deviceWorkspace: false },
    panelCollapsed: { ...s.layout.panelCollapsed, console: true, deviceWorkspace: true } } }));
  activateQuickSsh(temporary());
  const app = useAppStore.getState();
  assert.equal(app.selectedDeviceId, "temp-ssh-one"); assert.equal(app.devices[0].temporary, true);
  assert.equal(app.devices[0].is_default, false); assert.equal(app.layout.panelVisible.console, true);
  assert.equal(app.layout.panelVisible.deviceWorkspace, true); assert.equal(app.layout.panelCollapsed.deviceWorkspace, false);
  assert.equal(app.layout.sidebarVisible, true); assert.equal(open.mock.callCount(), 1);
  assert.deepEqual(recentSshAddresses(), ["alice@server:2222"]);
  assert.ok(!JSON.stringify([...storage]).includes("do-not-write"));
  rememberSshAddress({ ...temporary(), username: "alice:password" });
  assert.deepEqual(recentSshAddresses(), ["alice@server:2222"]);
});

test("saving a temporary device keeps its identity and live editor source valid", async (t) => {
  reset(t);
  const device = temporary(), saved = { ...device, temporary: false, is_default: true, revision: "saved" };
  const source = { workspace: deviceWorkspace(device.id, "/home/alice"), path: "a.py", device_revision: device.revision };
  useAppStore.setState({ devices: [device], selectedDeviceId: device.id,
    openTabs: [{ name: editorFileKey(source), source, language: "python", fileContent: "dirty", savedContent: "base", revision: "file", eol: "lf", bom: false, conflict: false, generation: 1 }] });
  t.mock.method(api, "saveTemporaryDevice", async (id) => { assert.equal(id, device.id); return saved; });
  t.mock.method(api, "listDevices", async () => [saved]);
  await saveTemporaryDevice(device.id);
  const app = useAppStore.getState();
  assert.equal(app.devices[0].temporary, false); assert.equal(app.selectedDeviceId, device.id);
  assert.equal(app.openTabs[0].source?.device_revision, "saved"); assert.equal(app.openTabs[0].fileContent, "dirty");
  assert.equal(app.openTabs[0].name, editorFileKey(source));
});

test("temporary workspace, drafts, terminal and transfer selection stay out of restart snapshots until saved", () => {
  const device = temporary(), workspace = deviceWorkspace(device.id, "/home/alice");
  const environment = { ...emptyEnvironment(), current: workspace,
    workspaces: [{ workspace, files: [], active_file: null, expanded: [], tree_scroll: 0 }],
    device_files: [{ name: "remote.py", language: "python" as const, source: { workspace, path: "remote.py" } }], active_device_file: "remote.py",
    terminals: [{ id: "temp", device_id: device.id }, { id: "saved", device_id: "saved", workspace: { workspace: localWorkspace("/work"), subdir: "" } }],
    active_terminal: "temp", transfer: { device_id: device.id, hidden: true, exclude: true } };
  const snapshot = persistentEnvironment(environment, [device]);
  assert.equal(snapshot.current, null); assert.deepEqual(snapshot.workspaces, []); assert.deepEqual(snapshot.device_files, []);
  assert.deepEqual(snapshot.terminals.map((tab) => tab.id), ["saved"]); assert.equal(snapshot.active_terminal, null);
  assert.equal(snapshot.transfer.device_id, null);
  assert.equal(persistentEnvironment(environment, [{ ...device, temporary: false }]).current, workspace);
  assert.equal(environment.terminals.length, 2);
});

test("temporary workspaces do not pollute recent workspaces", async (t) => {
  reset(t);
  const device = temporary();
  useAppStore.setState({ devices: [device], saving: false, starting: false, guarding: false });
  t.mock.method(api, "listWorkspaceDir", async () => []);
  await useAppStore.getState().setWorkspace(deviceWorkspace(device.id, "/home/alice"));
  assert.deepEqual(useAppStore.getState().recentWorkspaces, []);
});
