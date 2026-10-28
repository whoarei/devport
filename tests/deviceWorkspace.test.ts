import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile, type WorkspaceRef } from "../src/api";
import { createDeviceWorkspaceStore as createBrowserStore, deviceWorkspaceKey } from "../src/deviceWorkspaceStore";
import { DEVICE_WORKSPACE_DIRECTORIES_KEY, loadDeviceWorkspaceDirectories } from "../src/deviceWorkspaceDirectories";
import { DeviceWorkspacePanel } from "../src/components/DeviceWorkspacePanel";
import { transferApi, type TransferDirectory, type TransferEntry } from "../src/transferApi";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";
import { deviceWorkspaceContextCurrent, deviceWorkspaceFileContext, mutateDeviceWorkspaceFile } from "../src/deviceWorkspaceActions";
import { useTransferStore } from "../src/transferStore";
import { nameOf, parentOf } from "../src/workspaceTree";

const device = (id: string, extra: Partial<DeviceProfile> = {}): DeviceProfile => ({
  id, name: id, revision: "v1", transport: "ssh", workspace_root: "~/workspaces",
  is_default: false, host: "example", port: 22, username: "user", auth: { type: "key", key_path: null }, ...extra,
});
const entry = (name: string, kind = "file"): TransferEntry => ({ name, kind, size: 0, mode: null, modified: "", identity: "" });
const directory = (endpoint: WorkspaceRef, entries: TransferEntry[] = []): TransferDirectory => ({ endpoint, entries, overwrite: false });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

// Each test owns its remembered paths; lifecycle tests can explicitly share a map.
const createDeviceWorkspaceStore = (directories = new Map<string, string>()) => createBrowserStore(directories);

test("device workspace supports SSH and WSL and identifies root/configuration changes", () => {
  const ssh = device("a");
  assert.ok(deviceWorkspaceKey(ssh));
  assert.ok(deviceWorkspaceKey(device("b", { transport: "wsl" })));
  for (const transport of ["serial", "local"] as const) assert.equal(deviceWorkspaceKey(device("a", { transport })), null);
  assert.equal(deviceWorkspaceKey(null), null);
  assert.notEqual(deviceWorkspaceKey(ssh), deviceWorkspaceKey({ ...ssh, workspace_root: "/other" }));
  assert.notEqual(deviceWorkspaceKey(ssh), deviceWorkspaceKey({ ...ssh, revision: "v2" }));
});

test("browser resolves HOME once, lazily expands under the canonical root and leaves the current workspace intact", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ workspace: localWorkspace("C:\\source"), selectedDeviceId: "a" });
  const calls: unknown[] = [];
  const root = deviceWorkspace("a", "/home/user/workspaces");
  t.mock.method(transferApi, "listWithin", async (endpoint, subdir) => {
    calls.push([endpoint, subdir]);
    return directory(root, subdir ? [entry("main.py")] : [entry("z.txt"), entry("project10", "dir"), entry("project2", "dir"), entry("escape", "link"), entry("fifo", "special")]);
  });
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  assert.deepEqual(browser.getState().root, root);
  assert.deepEqual(browser.getState().tree[""].entries.map((e) => e.name), ["project2", "project10", "z.txt"]);
  assert.equal(calls.length, 1);
  await browser.getState().toggle("project2");
  assert.deepEqual(calls[1], [root, "project2"]);
  assert.equal(browser.getState().tree.project2.entries[0].name, "main.py");
  await browser.getState().toggle("project2");
  await browser.getState().toggle("project2");
  assert.equal(calls.length, 2, "reopening a loaded directory reuses its listing");
  await browser.getState().load("escape");
  await browser.getState().load("../escape");
  assert.equal(calls.length, 2, "only listed directories can be traversed");
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("C:\\source"));
  assert.equal(useAppStore.getState().selectedDeviceId, "a");
});

test("switching devices discards a late root response and a late child failure", async (t) => {
  const rootRead = deferred<TransferDirectory>(), childRead = deferred<TransferDirectory>();
  t.mock.method(transferApi, "listWithin", (endpoint, subdir) => {
    if (endpoint.type === "device" && endpoint.device_id === "a") return subdir ? childRead.promise : rootRead.promise;
    return Promise.resolve(directory(endpoint, [entry("b.txt")]));
  });
  const browser = createDeviceWorkspaceStore();
  const a = browser.getState().follow(device("a"));
  await browser.getState().follow(device("b"));
  rootRead.resolve(directory(deviceWorkspace("a", "/a"), [entry("child", "dir")]));
  await a;
  assert.equal(browser.getState().tree[""].entries[0].name, "b.txt");
  await browser.getState().follow(device("a"));
  const child = browser.getState().toggle("child");
  await browser.getState().follow(device("b"));
  childRead.reject(new Error("late disconnect"));
  await child;
  assert.deepEqual(Object.keys(browser.getState().tree), [""]);
  assert.equal(browser.getState().tree[""].error, null);
});

test("hiding or selecting an unsupported device invalidates reads without issuing new requests", async (t) => {
  const pending = deferred<TransferDirectory>();
  let calls = 0;
  t.mock.method(transferApi, "listWithin", () => { calls++; return pending.promise; });
  const browser = createDeviceWorkspaceStore();
  const opening = browser.getState().follow(device("a"));
  await browser.getState().follow(null);
  pending.resolve(directory(deviceWorkspace("a", "/a")));
  await opening;
  await browser.getState().refresh();
  for (const transport of ["local", "serial"] as const) await browser.getState().follow(device("a", { transport }));
  assert.equal(calls, 1);
  assert.equal(browser.getState().root, null);
  assert.deepEqual(browser.getState().tree, {});
});

test("failed listings can be retried and collapsing an in-flight child keeps it collapsed", async (t) => {
  const childRead = deferred<TransferDirectory>();
  let fail = true;
  t.mock.method(transferApi, "listWithin", async (endpoint, subdir) => {
    if (fail) throw new Error("offline");
    return subdir ? childRead.promise : directory(endpoint, [entry("child", "dir")]);
  });
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  assert.match(browser.getState().tree[""].error!, /offline/);
  fail = false;
  await browser.getState().load("");
  assert.equal(browser.getState().tree[""].error, null);
  const child = browser.getState().toggle("child");
  await browser.getState().toggle("child");
  childRead.resolve(directory(deviceWorkspace("a", "/a"), [entry("inside.py")]));
  await child;
  assert.equal(browser.getState().tree.child.loaded, true);
  assert.equal(browser.getState().tree.child.expanded, false);
});

test("refresh discards subtree caches and stale reads from the previous generation", async (t) => {
  const childRead = deferred<TransferDirectory>();
  let calls = 0;
  t.mock.method(transferApi, "listWithin", async (endpoint, subdir) => {
    calls++;
    return subdir ? childRead.promise : directory(endpoint, [entry("child", "dir")]);
  });
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  const child = browser.getState().toggle("child");
  await browser.getState().refresh();
  childRead.resolve(directory(deviceWorkspace("a", "/a"), [entry("stale.py")]));
  await child;
  assert.deepEqual(Object.keys(browser.getState().tree), [""]);
  assert.equal(calls, 3);
});

test("directory names matching JavaScript object properties remain browsable", async (t) => {
  t.mock.method(transferApi, "listWithin", async (endpoint, subdir) => directory(endpoint,
    subdir ? [entry("main.py")] : [entry("constructor", "dir"), entry("__proto__", "dir")]));
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  for (const path of ["constructor", "__proto__"]) {
    await browser.getState().toggle(path);
    assert.equal(browser.getState().tree[path].entries[0].name, "main.py");
  }
});

test("the panel follows the run selection and renders nothing for local/serial/missing devices", async (t) => {
  await i18n.changeLanguage("zh");
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const render = () => renderToStaticMarkup(createElement(DeviceWorkspacePanel, { visible: true, collapsed: false, onToggleCollapse: () => {} }));
  useAppStore.setState({ devices: [device("a"), device("b", { transport: "wsl" })], selectedDeviceId: "b" });
  assert.match(render(), /设备工作区/);
  assert.match(render(), /设备工作区当前路径/);
  for (const transport of ["local", "serial"] as const) {
    useAppStore.setState({ devices: [device("b", { transport })] });
    assert.equal(render(), "");
  }
  useAppStore.setState({ devices: [] });
  assert.equal(render(), "");
});

test("navigation commits only successful paths, refreshes the current directory and resets to the configured root", async (t) => {
  const calls: unknown[] = [];
  t.mock.method(transferApi, "listWithin", async (endpoint, dir) => {
    calls.push([endpoint, dir]);
    if (endpoint.type === "device" && endpoint.path === "/missing") throw new Error("not found");
    return directory(endpoint.type === "device" && endpoint.path.startsWith("~/") ? { ...endpoint, path: "/home/user/workspaces" } : endpoint, [entry("current.py")]);
  });
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  assert.equal(await browser.getState().navigate("/srv/project with spaces"), true);
  assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/srv/project with spaces"));
  const tree = browser.getState().tree;
  assert.equal(await browser.getState().navigate("/missing"), false);
  assert.deepEqual(browser.getState().tree, tree);
  assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/srv/project with spaces"));
  assert.match(browser.getState().error!, /not found/);
  const before = calls.length;
  for (const path of ["relative", "/a/../b", "/a/./b", "/bad\npath", ""]) assert.equal(await browser.getState().navigate(path), false);
  assert.equal(calls.length, before);
  await browser.getState().refresh();
  assert.deepEqual(calls.at(-1), [deviceWorkspace("a", "/srv/project with spaces"), ""]);
  await browser.getState().resetRoot();
  assert.deepEqual(calls.at(-1), [deviceWorkspace("a", "~/workspaces"), ""]);
  assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/home/user/workspaces"));
});

test("a late navigation cannot overwrite a newer path or a hidden browser", async (t) => {
  const slow = deferred<TransferDirectory>();
  t.mock.method(transferApi, "listWithin", async (endpoint) => endpoint.type === "device" && endpoint.path === "/slow" ? slow.promise : directory(endpoint));
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(device("a"));
  const old = browser.getState().navigate("/slow");
  await browser.getState().navigate("/new");
  slow.resolve(directory(deviceWorkspace("a", "/slow")));
  assert.equal(await old, false);
  assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/new"));
  const pending = deferred<TransferDirectory>();
  t.mock.method(transferApi, "listWithin", () => pending.promise);
  const hidden = browser.getState().navigate("/pending");
  await browser.getState().follow(null);
  pending.resolve(directory(deviceWorkspace("a", "/pending")));
  assert.equal(await hidden, false);
  assert.equal(browser.getState().root, null);
});

async function actionFixture(t: test.TestContext, transport: "ssh" | "wsl" = "ssh") {
  const app = useAppStore.getState(), transfer = useTransferStore.getState();
  t.after(() => { useAppStore.setState(app, true); useTransferStore.setState(transfer, true); });
  const host = device("a", { transport, workspace_root: "/srv/root" });
  useAppStore.setState({ devices: [host], selectedDeviceId: "a", workspace: localWorkspace("C:\\source"), openTabs: [], activeFile: null,
    workspaceTree: {}, workspaceError: null, loading: false, saving: false, starting: false, guarding: false, updating: false, workspaceMutating: false, runs: {} });
  useTransferStore.setState({ deviceMutating: false, planning: false, plan: null, tasks: [], registeredIds: [] });
  const files: Record<string, TransferEntry[]> = { "": [entry("folder", "dir"), entry("top.py")], folder: [entry("old.txt")] };
  const list = t.mock.method(transferApi, "listWithin", async (root, dir) => directory(root, files[dir] ?? []));
  const create = t.mock.method(api, "createWorkspaceEntry", async (_root, path, kind) => { files[parentOf(path)].push(entry(nameOf(path), kind)); if (kind === "dir") files[path] = []; });
  const rename = t.mock.method(api, "renameWorkspaceEntry", async (_root, path, target) => { files[parentOf(path)] = files[parentOf(path)].map((e) => e.name === nameOf(path) ? { ...e, name: nameOf(target) } : e); });
  const remove = t.mock.method(api, "deleteWorkspaceEntry", async (_root, path) => { files[parentOf(path)] = files[parentOf(path)].filter((e) => e.name !== nameOf(path)); });
  t.mock.method(api, "listWorkspaceDir", async () => []);
  t.mock.method(api, "renameWorkspaceCommands", async () => {});
  const browser = createDeviceWorkspaceStore();
  await browser.getState().follow(host);
  await browser.getState().toggle("folder");
  return { browser, files, create, rename, remove, list, root: deviceWorkspace("a", "/srv/root") };
}

for (const transport of ["ssh", "wsl"] as const) {
  test(`${transport} sidebar mutations stay anchored to the listed root and refresh the affected branch`, async (t) => {
    const { browser, root, create, rename, remove } = await actionFixture(t, transport);
    const context = () => deviceWorkspaceFileContext(browser, "folder")!;
    assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "create", name: "新文件.txt", kind: "file" }), true);
    assert.deepEqual(create.mock.calls.at(-1)!.arguments, [root, "folder/新文件.txt", "file"]);
    assert.equal(browser.getState().tree.folder.expanded, true);
    assert.ok(browser.getState().tree.folder.entries.some((e) => e.name === "新文件.txt"));
    assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "create", name: "new dir", kind: "dir" }), true);
    assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "rename", name: "old.txt", newName: "renamed.txt" }), true);
    assert.deepEqual(rename.mock.calls[0].arguments, [root, "folder/old.txt", "folder/renamed.txt"]);
    assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "delete", name: "renamed.txt" }), true);
    assert.deepEqual(remove.mock.calls[0].arguments, [root, "folder/renamed.txt"]);
    assert.ok(!browser.getState().tree.folder.entries.some((e) => e.name === "renamed.txt"));
    assert.deepEqual(useAppStore.getState().workspace, localWorkspace("C:\\source"));
    assert.equal(useTransferStore.getState().deviceMutating, false);
    assert.equal(useAppStore.getState().workspaceMutating, false);
  });
}

test("stale sidebar dialogs, invalid names and open workspace ancestors cannot reach mutation APIs", async (t) => {
  const { browser, root, create, rename, remove } = await actionFixture(t);
  const context = deviceWorkspaceFileContext(browser, "")!;
  for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "a\0b"]) assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "create", name, kind: "file" }), false);
  useAppStore.setState({ workspace: deviceWorkspace("a", "/srv/root/folder/project") });
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "rename", name: "folder", newName: "other" }), false);
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "delete", name: "folder" }), false);
  assert.match(browser.getState().error!, /先关闭工作区/);
  assert.equal(deviceWorkspaceContextCurrent(browser, context), true, "preflight failures do not invalidate the directory");
  useAppStore.setState({ selectedDeviceId: null });
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "create", name: "safe", kind: "file" }), false);
  useAppStore.setState({ selectedDeviceId: "a", devices: [device("a", { revision: "changed", workspace_root: "/srv/root" })] });
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "create", name: "safe", kind: "file" }), false);
  useAppStore.setState({ devices: [device("a", { workspace_root: "/srv/root" })] });
  await browser.getState().refresh();
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "create", name: "safe", kind: "file" }), false);
  assert.deepEqual(browser.getState().root, root);
  assert.equal(create.mock.callCount() + rename.mock.callCount() + remove.mock.callCount(), 0);
});

test("sidebar rename follows dirty editor tabs and deletion honors cancel then removes the confirmed tab", async (t) => {
  const { browser, root, remove } = await actionFixture(t);
  useAppStore.setState({ workspace: root, openTabs: [{ name: "folder/old.txt", fileContent: "dirty", savedContent: "saved", revision: "r", eol: "lf", bom: false, language: "text", generation: 1, conflict: false }], activeFile: "folder/old.txt" });
  const context = () => deviceWorkspaceFileContext(browser, "folder")!;
  assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "rename", name: "old.txt", newName: "new.txt" }), true);
  assert.equal(useAppStore.getState().activeFile, "folder/new.txt");
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "dirty");
  let answer = false;
  t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => answer);
  assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "delete", name: "new.txt" }), false);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs.length, 1);
  answer = true;
  assert.equal(await mutateDeviceWorkspaceFile(browser, context(), { type: "delete", name: "new.txt" }), true);
  assert.equal(useAppStore.getState().openTabs.length, 0);
  assert.deepEqual(remove.mock.calls[0].arguments, [root, "folder/new.txt"]);
});

test("switching devices during the unsaved-delete prompt prevents the pending delete", async (t) => {
  const { browser, root, remove } = await actionFixture(t);
  useAppStore.setState({ workspace: root, openTabs: [{ name: "folder/old.txt", fileContent: "dirty", savedContent: "saved", revision: "r", eol: "lf", bom: false, language: "text", generation: 1, conflict: false }] });
  const prompt = deferred<boolean>();
  t.mock.method(useAppStore.getState(), "confirmUnsaved", () => prompt.promise);
  const pending = mutateDeviceWorkspaceFile(browser, deviceWorkspaceFileContext(browser, "folder")!, { type: "delete", name: "old.txt" });
  useAppStore.setState({ selectedDeviceId: null });
  await browser.getState().follow(null);
  prompt.resolve(true);
  assert.equal(await pending, false);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(browser.getState().root, null);
  assert.equal(useTransferStore.getState().deviceMutating, false);
});

test("a pending sidebar mutation blocks duplicate mutations and navigation and releases its guards on error", async (t) => {
  const { browser, root } = await actionFixture(t);
  const pending = deferred<void>();
  t.mock.method(api, "createWorkspaceEntry", () => pending.promise);
  const context = deviceWorkspaceFileContext(browser, "folder")!;
  const operation = mutateDeviceWorkspaceFile(browser, context, { type: "create", name: "new.txt", kind: "file" });
  assert.equal(useTransferStore.getState().deviceMutating, true);
  assert.equal(useAppStore.getState().workspaceMutating, true);
  assert.equal(await browser.getState().navigate("/other"), false);
  assert.equal(await mutateDeviceWorkspaceFile(browser, context, { type: "create", name: "second.txt", kind: "file" }), false);
  pending.reject(new Error("permission denied"));
  assert.equal(await operation, false);
  assert.deepEqual(browser.getState().root, root);
  assert.match(browser.getState().error!, /permission denied/);
  assert.equal(browser.getState().mutating, false);
  assert.equal(useTransferStore.getState().deviceMutating, false);
  assert.equal(useAppStore.getState().workspaceMutating, false);
});

test("failed recursive deletion refreshes partial results while retaining its error", async (t) => {
  const { browser, files } = await actionFixture(t);
  t.mock.method(api, "deleteWorkspaceEntry", async () => { files[""].pop(); throw new Error("partially deleted"); });
  const before = browser.getState().generation;
  assert.equal(await mutateDeviceWorkspaceFile(browser, deviceWorkspaceFileContext(browser, "")!, { type: "delete", name: "folder" }), false);
  assert.ok(browser.getState().generation > before);
  assert.equal(browser.getState().tree[""].entries.length, 1);
  assert.match(browser.getState().error!, /partially deleted/);
});

for (const transport of ["ssh", "wsl"] as const) {
  test(`${transport} sidebar restores each device's last successful path while root reset uses its configuration`, async (t) => {
    const calls: WorkspaceRef[] = [];
    t.mock.method(transferApi, "listWithin", async (endpoint) => { calls.push(endpoint); return directory(endpoint); });
    const directories = new Map<string, string>();
    const browser = createDeviceWorkspaceStore(directories);
    const a = device("a", { transport, workspace_root: "/configured/a" });
    const b = device("b", { transport, workspace_root: "/configured/b" });
    await browser.getState().follow(a);
    await browser.getState().navigate("/projects/a");
    await browser.getState().follow(b);
    await browser.getState().navigate("/logs/b");
    await browser.getState().follow(a);
    assert.deepEqual(calls.at(-1), deviceWorkspace("a", "/projects/a"));
    await browser.getState().resetRoot();
    assert.deepEqual(calls.at(-1), deviceWorkspace("a", "/configured/a"));
    await browser.getState().follow(b);
    assert.deepEqual(calls.at(-1), deviceWorkspace("b", "/logs/b"));
    await browser.getState().follow({ ...a, revision: "new", workspace_root: "/new/root" });
    assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/configured/a"));
    await browser.getState().resetRoot();
    assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/new/root"));
    assert.deepEqual([...directories], [["a", "/new/root"], ["b", "/logs/b"]]);
  });
}

test("remembered paths survive hiding, unsupported targets and a fresh sidebar instance", async (t) => {
  t.mock.method(transferApi, "listWithin", async (endpoint) => directory(endpoint));
  const directories = new Map<string, string>();
  const first = createDeviceWorkspaceStore(directories);
  await first.getState().follow(device("a"));
  await first.getState().navigate("/my/project");
  await first.getState().follow(null);
  await first.getState().follow(device("local", { transport: "local" }));
  const second = createDeviceWorkspaceStore(directories);
  await second.getState().follow(device("a"));
  assert.deepEqual(second.getState().root, deviceWorkspace("a", "/my/project"));
  assert.equal(directories.has("local"), false);
});

test("only successful canonical roots are remembered, excluding expansion and failed paths", async (t) => {
  let offline = false;
  t.mock.method(transferApi, "listWithin", async (endpoint, dir) => {
    if (offline || endpoint.type === "device" && endpoint.path === "/missing") throw new Error("not found");
    return directory(endpoint.type === "device" && endpoint.path.startsWith("~/") ? { ...endpoint, path: "/real/home/workspaces" } : endpoint, dir ? [] : [entry("child", "dir")]);
  });
  const directories = new Map<string, string>();
  const browser = createDeviceWorkspaceStore(directories);
  await browser.getState().follow(device("a"));
  assert.equal(directories.get("a"), "/real/home/workspaces");
  await browser.getState().toggle("child");
  assert.equal(directories.get("a"), "/real/home/workspaces");
  await browser.getState().navigate("/missing");
  await browser.getState().navigate("/bad/../path");
  assert.equal(directories.get("a"), "/real/home/workspaces");
  offline = true;
  await browser.getState().follow(device("a"));
  assert.deepEqual(browser.getState().root, deviceWorkspace("a", "/real/home/workspaces"));
  assert.match(browser.getState().tree[""].error!, /not found/);
  assert.equal(directories.get("a"), "/real/home/workspaces", "failed restoration retains the last known path for retry");
});

test("late root and navigation responses cannot overwrite remembered device paths", async (t) => {
  const slowRoot = deferred<TransferDirectory>(), slowNavigation = deferred<TransferDirectory>();
  t.mock.method(transferApi, "listWithin", async (endpoint) => {
    if (endpoint.type === "device" && endpoint.path === "/slow-root") return slowRoot.promise;
    if (endpoint.type === "device" && endpoint.path === "/slow-navigation") return slowNavigation.promise;
    return directory(endpoint);
  });
  const directories = new Map<string, string>();
  const browser = createDeviceWorkspaceStore(directories);
  const old = browser.getState().follow(device("a", { workspace_root: "/slow-root" }));
  await browser.getState().follow(device("b", { workspace_root: "/b" }));
  slowRoot.resolve(directory(deviceWorkspace("a", "/old-root")));
  await old;
  assert.equal(directories.has("a"), false);
  const stale = browser.getState().navigate("/slow-navigation");
  await browser.getState().navigate("/latest");
  slowNavigation.resolve(directory(deviceWorkspace("b", "/stale")));
  assert.equal(await stale, false);
  assert.deepEqual([...directories], [["b", "/latest"]]);
});

function directoryStorage(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return data;
}

test("path memory persists across reloads independently of transfer-browser preferences", async (t) => {
  const data = directoryStorage(t);
  data.set("remote-runner.transfer-directories.v1", "unchanged transfer preferences");
  t.mock.method(transferApi, "listWithin", async (endpoint) => directory(endpoint));
  const browser = createDeviceWorkspaceStore(loadDeviceWorkspaceDirectories());
  await browser.getState().follow(device("a"));
  await browser.getState().navigate("/saved project/中文");
  const restored = createDeviceWorkspaceStore(loadDeviceWorkspaceDirectories());
  await restored.getState().follow(device("a"));
  assert.deepEqual(restored.getState().root, deviceWorkspace("a", "/saved project/中文"));
  assert.deepEqual(JSON.parse(data.get(DEVICE_WORKSPACE_DIRECTORIES_KEY)!), { a: "/saved project/中文" });
  assert.equal(data.get("remote-runner.transfer-directories.v1"), "unchanged transfer preferences");
});

test("corrupt persisted paths are ignored and unavailable storage still permits session restoration", async (t) => {
  const data = directoryStorage(t);
  for (const value of ["bad JSON", "null", "[]", '"text"']) {
    data.set(DEVICE_WORKSPACE_DIRECTORIES_KEY, value);
    assert.equal(loadDeviceWorkspaceDirectories().size, 0);
  }
  data.set(DEVICE_WORKSPACE_DIRECTORIES_KEY, JSON.stringify({ valid: "/saved", "": "/empty-id", relative: "relative", home: "~/pending", traversal: "/a/../b", newline: "/a\nb", nul: "/a\0b", object: {} }));
  assert.deepEqual([...loadDeviceWorkspaceDirectories()], [["valid", "/saved"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); },
  } });
  const directories = loadDeviceWorkspaceDirectories();
  t.mock.method(transferApi, "listWithin", async (endpoint) => directory(endpoint));
  const browser = createDeviceWorkspaceStore(directories);
  await browser.getState().follow(device("a"));
  await browser.getState().navigate("/session/path");
  await browser.getState().follow(null);
  const fresh = createDeviceWorkspaceStore(directories);
  await fresh.getState().follow(device("a"));
  assert.deepEqual(fresh.getState().root, deviceWorkspace("a", "/session/path"));
});
