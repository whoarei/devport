import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "../src/i18n";
import { api, type WorkspaceRef } from "../src/api";
import { useAppStore } from "../src/store";
import { useTransferStore } from "../src/transferStore";
import { appendEndpoint, sameTransferFilename, transferActive, transferApi, transferBytes, workspaceTransferPath, type TransferDirectory, type TransferPlan, type TransferSummary } from "../src/transferApi";
import { FileTransferPanel } from "../src/components/FileTransferPanel";
import { TransferDetailsDialog, TransferQueue } from "../src/components/TransferQueue";
import { canRetryTransfer, splitTransferQueue, transferPercent, transferQueueState, transferTaskName } from "../src/transferQueue";
import { loadTransferDirectories, rememberedDeviceDirectory, TRANSFER_DIRECTORIES_KEY } from "../src/transferDirectories";
import { emptyDevice } from "../src/components/DeviceEditor";
import { workspaceTransferMenuEntry } from "../src/components/WorkspacePanel";
import { deviceFileContext, mutateDeviceFile } from "../src/transferFileActions";
import { TransferFileDialog } from "../src/components/TransferFileDialog";

const local: WorkspaceRef = { type: "local", dir: "C:\\data" };
const device: WorkspaceRef = { type: "device", device_id: "ssh", path: "/data" };
const attrs = { kind: "file", size: 4, modified: "0", identity: "test", mode: null };
const directory = (endpoint: WorkspaceRef): TransferDirectory => ({ endpoint, entries: [{ name: "a.bin", ...attrs }, { name: ".env", ...attrs }, { name: "link", ...attrs, kind: "link" }], overwrite: true });
const initial = useTransferStore.getState();
function reset(t: test.TestContext) {
  const app = useAppStore.getState();
  useTransferStore.setState({ ...initial });
  useAppStore.setState({ workspace: null, openTabs: [], workspaceTree: {} });
  t.after(() => { useTransferStore.setState(initial); useAppStore.setState(app); });
}
const plan: TransferPlan = { id: "plan", request: { source: local, target: device, paths: ["a.bin"], exclude_project_files: false, protected_paths: [] }, items: [{ path: "a.bin", attrs, target_attrs: null, state: "pending", target_path: null, error: null }], total_bytes: 4, conflicts: 0, warnings: [], overwrite: true, keep_both: true };
const task = (state: string): TransferSummary => ({ id: "task", source: local, target: device, state, sequence: 1, first_path: "a.bin", selection_count: 1, total_bytes: 4, transferred_bytes: 0, current_path: "a.bin", error: null, item_count: 1, completed: 0, skipped: 0, failed: 0, pending_count: 0, unknown_count: 0, residual_count: 0, warning_count: 0 });
test.before(async () => { await i18n.changeLanguage("zh"); });

async function fileBrowser(t: test.TestContext, transport: "ssh" | "wsl" = "ssh") {
  reset(t);
  memoryStorage(t);
  const endpoint = { ...device, device_id: transport };
  useAppStore.setState({ devices: [{ ...emptyDevice(), id: transport, transport, revision: "connection-1" }],
    saving: false, starting: false, guarding: false, updating: false, workspaceMutating: false, runs: {} });
  t.mock.method(transferApi, "list", async (endpoint) => ({ ...directory(endpoint), entries: [
    ...directory(endpoint).entries, { name: "folder", ...attrs, kind: "dir" }, { name: "workspace", ...attrs, kind: "dir" },
  ] }));
  await useTransferStore.getState().browse("device", endpoint);
  return { endpoint, context: deviceFileContext()! };
}

for (const transport of ["ssh", "wsl"] as const) {
  test(`${transport} device file operations use the listed endpoint and refresh after success`, async (t) => {
    const { endpoint } = await fileBrowser(t, transport);
    const create = t.mock.method(api, "createWorkspaceEntry", async () => {});
    const rename = t.mock.method(api, "renameWorkspaceEntry", async () => {});
    const remove = t.mock.method(api, "deleteWorkspaceEntry", async () => {});
    for (const kind of ["file", "dir"] as const) {
      assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "create", name: kind === "file" ? "new.bin" : "folder", kind }), true);
      assert.deepEqual(create.mock.calls.at(-1)?.arguments, [endpoint, kind === "file" ? "new.bin" : "folder", kind]);
    }
    assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "rename", name: "a.bin", newName: "renamed.bin" }), true);
    assert.deepEqual(rename.mock.calls[0].arguments, [endpoint, "a.bin", "renamed.bin"]);
    for (const name of ["a.bin", "folder"]) {
      assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "delete", name }), true);
      assert.deepEqual(remove.mock.calls.at(-1)?.arguments, [endpoint, name]);
    }
    assert.equal(useTransferStore.getState().deviceMutating, false);
    assert.equal(useTransferStore.getState().device.error, null);
  });
}

test("device file operations reject stale directories, stale connections and invalid names", async (t) => {
  const { context, endpoint } = await fileBrowser(t);
  const create = t.mock.method(api, "createWorkspaceEntry", async () => {});
  for (const name of ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "a\0b"]) {
    assert.equal(await mutateDeviceFile(context, { type: "create", name, kind: "file" }), false);
  }
  await useTransferStore.getState().browse("device", { ...endpoint, path: "/elsewhere" });
  assert.equal(await mutateDeviceFile(context, { type: "create", name: "safe", kind: "file" }), false);
  const changedConnection = deviceFileContext()!;
  useAppStore.setState((s) => ({ devices: s.devices.map((d) => ({ ...d, revision: "connection-2" })) }));
  assert.equal(await mutateDeviceFile(changedConnection, { type: "create", name: "safe", kind: "file" }), false);
  assert.equal(create.mock.callCount(), 0);
});

test("a directory response from an obsolete connection cannot enable device file operations", async (t) => {
  const { endpoint } = await fileBrowser(t);
  let finish!: (result: TransferDirectory) => void;
  t.mock.method(transferApi, "list", () => new Promise<TransferDirectory>((resolve) => { finish = resolve; }));
  const pending = useTransferStore.getState().browse("device", endpoint);
  useAppStore.setState((s) => ({ devices: s.devices.map((d) => ({ ...d, revision: "connection-2" })) }));
  finish(directory(endpoint)); await pending;
  assert.equal(deviceFileContext(), null);
  assert.equal(useTransferStore.getState().device.loading, false);
  assert.match(useTransferStore.getState().device.error!, /设备或目录已变化/);
});

test("file mutations are blocked by device transfers and prevent duplicate mutation or planning", async (t) => {
  const { context } = await fileBrowser(t);
  const create = t.mock.method(api, "createWorkspaceEntry", async () => {});
  useTransferStore.setState({ tasks: [task("transferring")] });
  assert.equal(await mutateDeviceFile(context, { type: "create", name: "safe", kind: "file" }), false);
  assert.equal(create.mock.callCount(), 0);
  useTransferStore.setState({ tasks: [], registeredIds: ["awaiting-first-snapshot"] });
  assert.equal(await mutateDeviceFile(context, { type: "create", name: "safe", kind: "file" }), false);
  assert.equal(create.mock.callCount(), 0);
  useTransferStore.setState({ registeredIds: [], plan });
  assert.equal(await mutateDeviceFile(context, { type: "create", name: "safe", kind: "file" }), false);
  useTransferStore.setState({ plan: null });
  let finish!: () => void;
  t.mock.method(api, "createWorkspaceEntry", () => new Promise<void>((resolve) => { finish = resolve; }));
  await useTransferStore.getState().browse("local", local, ["a.bin"]);
  const scan = t.mock.method(transferApi, "plan", async () => plan);
  const retry = t.mock.method(transferApi, "retry", async () => plan);
  const pending = mutateDeviceFile(context, { type: "create", name: "safe", kind: "file" });
  assert.equal(useTransferStore.getState().deviceMutating, true);
  assert.equal(await mutateDeviceFile(context, { type: "create", name: "second", kind: "file" }), false);
  await useTransferStore.getState().prepare("local", false);
  await useTransferStore.getState().retry("task");
  assert.equal(scan.mock.callCount(), 0); assert.equal(retry.mock.callCount(), 0);
  finish(); await pending;
  assert.equal(useTransferStore.getState().deviceMutating, false);
});

test("backend file-operation errors remain visible and do not discard the directory", async (t) => {
  const { context } = await fileBrowser(t);
  t.mock.method(api, "renameWorkspaceEntry", async () => { throw { code: "exists", message: "目标已存在" }; });
  assert.equal(await mutateDeviceFile(context, { type: "rename", name: "a.bin", newName: ".env" }), false);
  assert.match(useTransferStore.getState().error!, /目标已存在/);
  assert.equal(useTransferStore.getState().deviceMutating, false);
  assert.ok(deviceFileContext());
  t.mock.method(api, "deleteWorkspaceEntry", async () => { throw new Error("permission denied"); });
  const before = useTransferStore.getState().device.generation;
  assert.equal(await mutateDeviceFile(context, { type: "delete", name: "folder" }), false);
  assert.ok(useTransferStore.getState().device.generation > before, "refresh partially deleted directories");
  assert.match(useTransferStore.getState().error!, /permission denied/);
});

test("device mutations inside a workspace keep open tabs, drafts and directories in sync", async (t) => {
  const { endpoint } = await fileBrowser(t);
  const workspace = { ...endpoint, path: "/data" };
  const tab = { name: "a.bin", fileContent: "dirty", savedContent: "saved", revision: "r", generation: 1, language: "text" as const, eol: "lf" as const, bom: false, conflict: false };
  useAppStore.setState({ workspace, openTabs: [tab], activeFile: "a.bin", runDraft: { ...useAppStore.getState().runDraft, entry: "a.bin" },
    workspaceTree: { "": { entries: [], loaded: true, expanded: true } } });
  t.mock.method(api, "listWorkspaceDir", async () => []);
  t.mock.method(api, "createWorkspaceEntry", async () => {});
  t.mock.method(api, "renameWorkspaceEntry", async () => {});
  t.mock.method(api, "renameWorkspaceCommands", async () => {});
  const remove = t.mock.method(api, "deleteWorkspaceEntry", async () => {});
  assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "create", name: "created", kind: "dir" }), true);
  assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "rename", name: "a.bin", newName: "renamed.bin" }), true);
  assert.equal(useAppStore.getState().openTabs[0].name, "renamed.bin");
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "dirty");
  assert.equal(useAppStore.getState().activeFile, "renamed.bin");
  assert.equal(useAppStore.getState().runDraft.entry, "renamed.bin");
  // Simulate a fresh listing containing the renamed file.
  t.mock.method(transferApi, "list", async (endpoint) => ({ ...directory(endpoint), entries: [{ name: "renamed.bin", ...attrs }] }));
  await useTransferStore.getState().browse("device", endpoint);
  const guard = t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => false);
  assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "delete", name: "renamed.bin" }), false);
  assert.equal(guard.mock.callCount(), 1); assert.equal(remove.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs.length, 1);
  t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => true);
  assert.equal(await mutateDeviceFile(deviceFileContext()!, { type: "delete", name: "renamed.bin" }), true);
  assert.equal(useAppStore.getState().openTabs.length, 0);
  assert.equal(useAppStore.getState().runDraft.entry, "");
});

test("changing device directories during an unsaved-file prompt cancels deletion", async (t) => {
  const { context, endpoint } = await fileBrowser(t);
  useAppStore.setState({ workspace: endpoint, openTabs: [{ name: "a.bin", fileContent: "dirty", savedContent: "saved", revision: "r", generation: 1, language: "text", eol: "lf", bom: false, conflict: false }] });
  let confirm!: (answer: boolean) => void;
  t.mock.method(useAppStore.getState(), "confirmUnsaved", () => new Promise<boolean>((resolve) => { confirm = resolve; }));
  const remove = t.mock.method(api, "deleteWorkspaceEntry", async () => {});
  const pending = mutateDeviceFile(context, { type: "delete", name: "a.bin" });
  await useTransferStore.getState().browse("device", { ...endpoint, path: "/other" });
  confirm(true);
  assert.equal(await pending, false);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(useTransferStore.getState().device.endpoint?.type === "device" && useTransferStore.getState().device.endpoint.path, "/other");
});

test("workspace roots and their ancestors cannot be renamed or deleted from the device browser", async (t) => {
  const { context, endpoint } = await fileBrowser(t);
  const rename = t.mock.method(api, "renameWorkspaceEntry", async () => {});
  const remove = t.mock.method(api, "deleteWorkspaceEntry", async () => {});
  for (const path of ["/data/workspace", "/data/workspace/nested"]) {
    useAppStore.setState({ workspace: { ...endpoint, path } });
    assert.equal(await mutateDeviceFile(context, { type: "rename", name: "workspace", newName: "other" }), false);
    assert.equal(await mutateDeviceFile(context, { type: "delete", name: "workspace" }), false);
  }
  assert.equal(rename.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0);
  assert.match(useTransferStore.getState().error!, /先关闭工作区/);
});

test("device file controls and recursive-delete confirmation are translated", async (t) => {
  const { context } = await fileBrowser(t);
  const panel = renderToStaticMarkup(React.createElement(FileTransferPanel, { visible: true, collapsed: false, onToggleCollapse() {} }));
  assert.match(panel, /设备文件管理/); assert.match(panel, /新建文件夹/); assert.match(panel, /重命名/);
  for (const [language, expected] of [["zh", "将永久删除此目录及其中的所有内容"], ["en", "Permanently delete this directory and all its contents"]]) {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(React.createElement(TransferFileDialog, { request: { context, type: "delete", name: "folder", directory: true }, onClose() {} }));
    assert.ok(html.includes(expected)); assert.ok(html.includes("/data/folder"));
  }
  await i18n.changeLanguage("zh");
});

for (const source of [local, { type: "local", dir: "/home/user/project" } as WorkspaceRef, device, { ...device, device_id: "wsl" }]) {
  for (const path of [undefined, "a.bin", "nested/a.bin", "nested/folder"]) {
    test(`File Transfer menu opens ${JSON.stringify(source)} at ${path ?? "workspace root"} without starting a transfer`, async (t) => {
      reset(t);
      const side = source.type === "local" ? "local" : "device";
      const otherSide = side === "local" ? "device" : "local";
      const otherEndpoint = side === "local" ? device : local;
      const devices = [
        { ...emptyDevice(), id: "ssh", workspace_root: "/default" },
        { ...emptyDevice(), id: "wsl", transport: "wsl" as const, workspace_root: "/default" },
      ];
      const layout = useAppStore.getState().layout;
      useAppStore.setState({ workspace: source, devices, selectedDeviceId: "ssh", layout: {
        ...layout, panelVisible: { ...layout.panelVisible, transfer: false }, panelCollapsed: { ...layout.panelCollapsed, transfer: true },
      } });
      t.mock.method(transferApi, "list", async (endpoint: WorkspaceRef) => ({
        ...directory(endpoint), entries: [...directory(endpoint).entries, { name: "folder", ...attrs, kind: "dir" }],
      }));
      const planCall = t.mock.method(transferApi, "plan");
      const startCall = t.mock.method(transferApi, "start");
      await useTransferStore.getState().browse(otherSide, otherEndpoint, ["a.bin"]);
      const otherBrowser = useTransferStore.getState()[otherSide];

      for (const [language, label] of [["zh", "文件传输"], ["en", "File Transfer"]]) {
        const entry = workspaceTransferMenuEntry((key) => i18n.t(key, { lng: language }), source, path);
        assert.ok(entry !== "separator" && entry.onSelect);
        assert.equal(entry.label, label);
        entry.onSelect();
        await Promise.resolve();

        const browser = useTransferStore.getState()[side];
        const expectedEndpoint = path?.includes("/")
          ? source.type === "local" ? { ...source, dir: `${source.dir}/nested` } : { ...source, path: `${source.path}/nested` }
          : source;
        assert.deepEqual(browser.endpoint, expectedEndpoint);
        assert.deepEqual(browser.selected, path ? [path.split("/").at(-1)] : []);
        assert.equal(browser.error, null);
        assert.equal(useTransferStore.getState()[otherSide], otherBrowser, "keep the destination directory and selection");
        assert.equal(useAppStore.getState().layout.panelVisible.transfer, true);
        assert.equal(useAppStore.getState().layout.panelCollapsed.transfer, false);
      }
      assert.equal(planCall.mock.callCount(), 0);
      assert.equal(startCall.mock.callCount(), 0);
    });
  }
}

test("File Transfer menu reports a disconnected workspace host without switching to another device", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: device, devices: [{ ...emptyDevice(), id: "other", workspace_root: "/other" }], selectedDeviceId: "other" });
  t.mock.method(transferApi, "list", async () => { throw new Error("Device disconnected"); });
  const entry = workspaceTransferMenuEntry((key) => i18n.t(key), device, "nested/a.bin");
  assert.ok(entry !== "separator" && entry.onSelect && !entry.disabled);
  entry.onSelect();
  await Promise.resolve();
  assert.deepEqual(useTransferStore.getState().device.endpoint, { ...device, path: "/data/nested" });
  assert.equal(useTransferStore.getState().device.error, "Device disconnected");
  assert.equal(useTransferStore.getState().device.loading, false);
  assert.equal(useAppStore.getState().layout.panelVisible.transfer, true);
});

test("endpoint mapping respects hosts, directory boundaries and Windows case", () => {
  assert.deepEqual(appendEndpoint({ type: "device", device_id: "s", path: "/" }, "data"), { type: "device", device_id: "s", path: "/data" });
  assert.deepEqual(appendEndpoint(local, "子目录"), { type: "local", dir: "C:\\data\\子目录" });
  assert.equal(workspaceTransferPath({ type: "local", dir: "c:\\DATA\\project" }, "a.bin", local), "project/a.bin");
  assert.equal(workspaceTransferPath({ ...device, path: "/database" }, "a.bin", device), null);
  assert.equal(workspaceTransferPath({ ...device, device_id: "other" }, "a.bin", device), null);
  assert.equal(workspaceTransferPath(local, "a.bin", device), null);
  assert.ok(sameTransferFilename("A.bin", "a.bin", local));
  assert.ok(!sameTransferFilename("A.bin", "a.bin", device));
  assert.equal(transferBytes(2 ** 31), "2.0 GiB");
  assert.ok(transferActive("committing")); assert.ok(!transferActive("unknown"));
});

test("late browser responses cannot replace a newer directory or selection", async (t) => {
  reset(t);
  let finish!: (directory: TransferDirectory) => void;
  t.mock.method(transferApi, "list", (endpoint: WorkspaceRef) => endpoint.type === "local" && endpoint.dir === local.dir ? new Promise<TransferDirectory>((resolve) => { finish = resolve; }) : Promise.resolve(directory(endpoint)));
  const old = useTransferStore.getState().browse("local", local);
  const newer: WorkspaceRef = { type: "local", dir: "C:\\other" };
  await useTransferStore.getState().browse("local", newer, ["a.bin"]);
  finish(directory(local)); await old;
  assert.deepEqual(useTransferStore.getState().local.endpoint, newer);
  assert.deepEqual(useTransferStore.getState().local.selected, ["a.bin"]);
  assert.equal(useTransferStore.getState().directories.local, "C:\\other");
});

function memoryStorage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return data;
}

test("transfer directories persist independently for local, SSH and WSL and restore after restart", async (t) => {
  reset(t);
  memoryStorage(t);
  const ssh = { ...emptyDevice(), id: "ssh", name: "box", workspace_root: "/default" };
  const wsl = { ...ssh, id: "wsl", transport: "wsl" as const };
  useAppStore.setState({ devices: [ssh, wsl], selectedDeviceId: "ssh", workspace: { type: "local", dir: "C:\\workspace" } });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local);
  await useTransferStore.getState().browse("device", device);
  await useTransferStore.getState().browse("device", { type: "device", device_id: "wsl", path: "/home/用户/files" });
  // Simulate fresh browser state and load only the persisted preferences.
  useTransferStore.setState({ ...initial, directories: loadTransferDirectories() });
  useTransferStore.getState().restore();
  await Promise.resolve();
  assert.deepEqual(useTransferStore.getState().local.endpoint, local);
  assert.deepEqual(useTransferStore.getState().device.endpoint, device);
  await useTransferStore.getState().openDevice("wsl");
  assert.deepEqual(useTransferStore.getState().device.endpoint, { type: "device", device_id: "wsl", path: "/home/用户/files" });
  useAppStore.setState({ devices: [{ ...ssh, name: "renamed" }, wsl] });
  await useTransferStore.getState().openDevice("ssh");
  assert.deepEqual(useTransferStore.getState().device.endpoint, device);
  assert.deepEqual(loadTransferDirectories(), { local: local.dir, devices: { ssh: "/data", wsl: "/home/用户/files" } });
});

test("only successful current responses save the normalized directory", async (t) => {
  reset(t);
  memoryStorage(t);
  let finish!: (value: TransferDirectory) => void;
  t.mock.method(transferApi, "list", async (endpoint) => {
    if (endpoint.type === "device" && endpoint.path === "/slow") return new Promise<TransferDirectory>((resolve) => { finish = resolve; });
    if (endpoint.type === "device" && endpoint.path === "/missing") throw new Error("not found");
    return directory(endpoint.type === "local" ? { type: "local", dir: "C:\\canonical" } : endpoint);
  });
  const old = useTransferStore.getState().browse("device", { ...device, path: "/slow" });
  await useTransferStore.getState().browse("device", { ...device, device_id: "wsl", path: "/files" });
  finish(directory({ ...device, path: "/slow" })); await old;
  await useTransferStore.getState().browse("device", { ...device, device_id: "wsl", path: "/missing" });
  await useTransferStore.getState().browse("local", local);
  assert.deepEqual(loadTransferDirectories(), { local: "C:\\canonical", devices: { wsl: "/files" } });
  assert.ok(useTransferStore.getState().device.error);
});

test("restore handles devices loading later without replacing an explicitly revealed workspace path", async (t) => {
  reset(t);
  memoryStorage(t);
  useTransferStore.setState({ directories: { local: local.dir, devices: { ssh: "/remembered" } } });
  useAppStore.setState({ devices: [], selectedDeviceId: null });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  useTransferStore.getState().restore();
  await Promise.resolve();
  assert.equal(useTransferStore.getState().device.endpoint, null);
  useAppStore.setState({ devices: [{ ...emptyDevice(), id: "ssh", workspace_root: "/default" }], selectedDeviceId: "ssh" });
  useTransferStore.getState().restore();
  await Promise.resolve();
  assert.deepEqual(useTransferStore.getState().device.endpoint, { ...device, path: "/remembered" });
  useTransferStore.getState().seed(device, "project/a.bin");
  useTransferStore.getState().restore();
  await Promise.resolve();
  assert.deepEqual(useTransferStore.getState().device.endpoint, { ...device, path: "/data/project" });
  assert.deepEqual(useTransferStore.getState().device.selected, ["a.bin"]);
  await useTransferStore.getState().openDevice("");
  useTransferStore.getState().restore();
  assert.equal(useTransferStore.getState().device.endpoint, null);
});

test("new devices fall back to their workspace root and storage failures do not break browsing", async (t) => {
  reset(t);
  memoryStorage(t);
  useAppStore.setState({ devices: [{ ...emptyDevice(), id: "ssh", workspace_root: "/default" }] });
  t.mock.method(localStorage, "setItem", () => { throw new Error("quota"); });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().openDevice("ssh");
  assert.deepEqual(useTransferStore.getState().device.endpoint, { ...device, path: "/default" });
  assert.equal(useTransferStore.getState().device.error, null);
  assert.equal(useTransferStore.getState().directories.devices.ssh, "/default");
});

test("corrupt or incomplete directory preferences are read defensively", (t) => {
  const data = memoryStorage(t);
  data.set(TRANSFER_DIRECTORIES_KEY, "{");
  assert.deepEqual(loadTransferDirectories(), { local: null, devices: {} });
  data.set(TRANSFER_DIRECTORIES_KEY, JSON.stringify({ local: 42, devices: { ssh: "/valid", wsl: "relative", invalid: null, nul: "/a\0b" } }));
  assert.deepEqual(loadTransferDirectories(), { local: null, devices: { ssh: "/valid" } });
  assert.equal(rememberedDeviceDirectory(loadTransferDirectories(), "toString"), undefined);
});

test("planning freezes endpoints while browsing moves elsewhere", async (t) => {
  reset(t);
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local, ["a.bin"]);
  await useTransferStore.getState().browse("device", device);
  let captured: typeof plan.request | undefined;
  let finish!: (result: TransferPlan) => void;
  t.mock.method(transferApi, "plan", (request) => { captured = request; return new Promise<TransferPlan>((resolve) => { finish = resolve; }); });
  const pending = useTransferStore.getState().prepare("local", true);
  await useTransferStore.getState().browse("device", { ...device, path: "/other" });
  finish(plan); await pending;
  assert.deepEqual(captured?.target, device); assert.equal(captured?.exclude_project_files, true);
  assert.deepEqual(useTransferStore.getState().plan?.request.target, device);
});

test("row transfer uses just the clicked entry and preserves the batch selection", async (t) => {
  reset(t);
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local, ["a.bin", ".env"]);
  await useTransferStore.getState().browse("device", device);
  const scan = t.mock.method(transferApi, "plan", async (request) => ({ ...plan, request }));
  await useTransferStore.getState().prepare("local", true, [".env"]);
  assert.deepEqual(scan.mock.calls[0].arguments[0].paths, [".env"]);
  assert.equal(scan.mock.calls[0].arguments[0].exclude_project_files, true);
  assert.deepEqual(useTransferStore.getState().local.selected, ["a.bin", ".env"]);
  useTransferStore.setState({ plan: null });
  await useTransferStore.getState().prepare("local", false);
  assert.deepEqual(scan.mock.calls[1].arguments[0].paths, ["a.bin", ".env"]);
});

test("a row transfer checks only its own unsaved source and freezes paths before confirmation", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: local, openTabs: [{ name: "a.bin", fileContent: "dirty", savedContent: "old", revision: "r", generation: 1, language: "text", eol: "lf", bom: false, conflict: false }] });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local, ["a.bin"]);
  await useTransferStore.getState().browse("device", device);
  let confirm!: (proceed: boolean) => void;
  const guard = t.mock.method(useAppStore.getState(), "confirmAllUnsaved", () => new Promise<boolean>((resolve) => { confirm = resolve; }));
  const scan = t.mock.method(transferApi, "plan", async (request) => ({ ...plan, request }));
  await useTransferStore.getState().prepare("local", false, [".env"]);
  assert.equal(guard.mock.callCount(), 0);
  useTransferStore.setState({ plan: null });
  const paths = ["a.bin"];
  const pending = useTransferStore.getState().prepare("local", false, paths);
  paths[0] = ".env";
  await useTransferStore.getState().browse("local", { type: "local", dir: "C:\\other" });
  await useTransferStore.getState().browse("device", { ...device, path: "/other" });
  confirm(true); await pending;
  assert.equal(guard.mock.callCount(), 1);
  assert.deepEqual(scan.mock.calls[1].arguments[0].paths, ["a.bin"]);
  assert.deepEqual(scan.mock.calls[1].arguments[0].source, local);
  assert.deepEqual(scan.mock.calls[1].arguments[0].target, device);
});

test("row and batch transfer cannot use a destination while it is being reloaded", async (t) => {
  reset(t);
  useTransferStore.setState({ local: { ...initial.local, directory: directory(local), selected: ["a.bin"] }, device: { ...initial.device, directory: directory(device), loading: true } });
  const scan = t.mock.method(transferApi, "plan", async () => plan);
  await useTransferStore.getState().prepare("local", false, ["a.bin"]);
  await useTransferStore.getState().prepare("local", false);
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(useTransferStore.getState().planning, false);
});

test("unsaved source cancellation never queues a disk copy", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: local, openTabs: [{ name: "a.bin", fileContent: "dirty", savedContent: "old", revision: "r", generation: 1, language: "text", eol: "lf", bom: false, conflict: false }] });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local, ["a.bin"]); await useTransferStore.getState().browse("device", device);
  const confirm = t.mock.method(useAppStore.getState(), "confirmAllUnsaved", async () => false);
  const scan = t.mock.method(transferApi, "plan", async () => plan);
  await useTransferStore.getState().prepare("local", false);
  assert.equal(confirm.mock.callCount(), 1); assert.equal(scan.mock.callCount(), 0);
  assert.equal(useTransferStore.getState().planning, false);
});

test("open target tabs are supplied to backend overwrite protection", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: device, openTabs: [{ name: "a.bin", fileContent: "clean", savedContent: "clean", revision: "r", generation: 1, language: "text", eol: "lf", bom: false, conflict: false }] });
  t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().browse("local", local, ["a.bin"]); await useTransferStore.getState().browse("device", device);
  const scan = t.mock.method(transferApi, "plan", async () => plan);
  await useTransferStore.getState().prepare("local", false);
  assert.deepEqual(scan.mock.calls[0].arguments[0].protected_paths, ["a.bin"]);
});

test("completion preserves newly dirty target content and marks an external conflict", async (t) => {
  reset(t);
  const tab = { name: "a.bin", fileContent: "unsaved", savedContent: "old", revision: "r", generation: 1, language: "text" as const, eol: "lf" as const, bom: false, conflict: false };
  useAppStore.setState({ workspace: device, openTabs: [tab] });
  useTransferStore.setState({ tasks: [task("transferring")] });
  t.mock.method(transferApi, "snapshot", async () => [{ ...task("completed"), sequence: 2 }]);
  t.mock.method(transferApi, "task", async () => ({ id: "task", request: plan.request, policy: "overwrite", preserve_executable: false, state: "completed", total_bytes: 4, transferred_bytes: 4, error: null, residuals: [], warnings: [], items: [{ ...plan.items[0], state: "completed", target_path: "a.bin" }] }));
  t.mock.method(api, "readWorkspaceFile", async () => ({ content: "new disk", revision: "new", eol: "lf", bom: false }));
  await useTransferStore.getState().refresh();
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "unsaved");
  assert.equal(useAppStore.getState().openTabs[0].revision, "r");
  assert.equal(useAppStore.getState().openTabs[0].conflict, true);
});

test("a transfer completed before its first snapshot still refreshes its destination", async (t) => {
  reset(t);
  useTransferStore.setState({ device: { ...initial.device, endpoint: device, directory: directory(device) } });
  useTransferStore.getState().register("task");
  t.mock.method(transferApi, "snapshot", async () => [{ ...task("completed"), sequence: 2 }]);
  const reload = t.mock.method(transferApi, "list", async (endpoint) => directory(endpoint));
  await useTransferStore.getState().refresh();
  assert.equal(reload.mock.callCount(), 1);
  assert.deepEqual(reload.mock.calls[0].arguments[0], device);
  assert.deepEqual(useTransferStore.getState().registeredIds, []);
  assert.ok(useTransferStore.getState().completionNotices.task > Date.now());
});

test("completion feedback expires without being renewed by later snapshots", async (t) => {
  reset(t);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  useTransferStore.setState({ tasks: [task("transferring")] });
  t.mock.method(transferApi, "snapshot", async () => [{ ...task("completed"), sequence: 2 }]);
  await useTransferStore.getState().refresh();
  assert.equal(useTransferStore.getState().completionNotices.task, 6000);
  now = 3000; await useTransferStore.getState().refresh();
  assert.equal(useTransferStore.getState().completionNotices.task, 6000);
  now = 6001; await useTransferStore.getState().refresh();
  assert.deepEqual(useTransferStore.getState().completionNotices, {});
  useTransferStore.setState({ tasks: [] });
  await useTransferStore.getState().refresh();
  assert.deepEqual(useTransferStore.getState().completionNotices, {}, "restored history must not appear as newly completed");
});

test("only successful settled tasks enter history; attention and recent completion stay visible", () => {
  const tasks = [
    { ...task("completed"), id: "archived" }, { ...task("completed"), id: "recent" },
    { ...task("completed"), id: "cleanup", residual_count: 1 },
    { ...task("failed"), id: "unknown", unknown_count: 1, failed: 1 },
    ...["queued", "transferring", "partial", "failed", "interrupted", "canceled"].map((state) => ({ ...task(state), id: state })),
  ];
  const initial = splitTransferQueue(tasks, { recent: 5000 }, 4000);
  assert.deepEqual(initial.history.map((item) => item.id), ["archived"]);
  assert.equal(initial.current.length, tasks.length - 1);
  const expired = splitTransferQueue(tasks, { recent: 5000 }, 5000);
  assert.deepEqual(expired.history.map((item) => item.id), ["archived", "recent"]);
  assert.equal(transferQueueState(tasks[2]), "needsCleanup");
  assert.equal(transferQueueState(tasks[3]), "unknown");
});

test("retry availability matches unfinished items and prohibits unknown commits", () => {
  assert.ok(canRetryTransfer({ ...task("failed"), failed: 1 }));
  assert.ok(canRetryTransfer({ ...task("canceled"), pending_count: 1 }));
  assert.ok(canRetryTransfer({ ...task("interrupted"), pending_count: 1 }));
  assert.ok(!canRetryTransfer({ ...task("partial"), failed: 1, unknown_count: 1 }));
  assert.ok(!canRetryTransfer({ ...task("completed"), residual_count: 1 }));
  assert.ok(!canRetryTransfer(task("canceled")));
  assert.ok(!canRetryTransfer({ ...task("transferring"), pending_count: 1 }));
  assert.ok(!canRetryTransfer({ ...task("interrupted"), pending_count: 1, superseded_by: "retry" }));
});

test("retry attempts replace old attention rows while preserving cleanup and unknown results", () => {
  const original = { ...task("interrupted"), id: "original", first_path: "flag.blend", pending_count: 1, superseded_by: "retry" };
  const retry = { ...task("completed"), id: "retry", first_path: "flag.blend", completed: 1, retry_of: "original" };
  let queue = splitTransferQueue([retry, original], {}, Date.now());
  assert.deepEqual(queue.current, []);
  assert.deepEqual(queue.history.map((item) => item.id), ["retry"]);
  queue = splitTransferQueue([{ ...retry, state: "failed", failed: 1 }, original], {}, Date.now());
  assert.deepEqual(queue.current.map((item) => item.id), ["retry"]);
  queue = splitTransferQueue([retry, { ...original, residual_count: 1 }], {}, Date.now());
  assert.deepEqual(queue.current.map((item) => item.id), ["original"]);
  assert.equal(transferQueueState(queue.current[0]), "needsCleanup");
  queue = splitTransferQueue([retry, { ...original, unknown_count: 1 }], {}, Date.now());
  assert.deepEqual(queue.current.map((item) => item.id), ["original"]);
  assert.equal(transferQueueState(queue.current[0]), "unknown");
});

test("successful retry shows one history row and offers the retained previous attempt in details", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const original = { ...task("interrupted"), id: "original", pending_count: 1, superseded_by: "retry" };
  const retry = { ...task("completed"), id: "retry", completed: 1, retry_of: "original" };
  useTransferStore.setState({ tasks: [retry, original] });
  const markup = renderToStaticMarkup(React.createElement(TransferQueue, { visible: true }));
  assert.equal((markup.match(/class="transfer-queue-row /g) ?? []).length, 1);
  assert.ok(!markup.includes("已中断")); assert.ok(markup.includes("已完成（1）"));
  const detail = renderToStaticMarkup(React.createElement(TransferDetailsDialog, { task: retry, onClose: () => {}, onRetry: () => {}, onShowTask: () => {} }));
  assert.ok(detail.includes("查看上次记录"));
  useTransferStore.setState({ tasks: [original] });
  assert.equal(renderToStaticMarkup(React.createElement(TransferQueue, { visible: true })), "");
});

test("queue names describe the original selection and zero-byte progress uses item results", () => {
  const batch = { ...task("transferring"), first_path: "project/src", selection_count: 3, current_path: "project/src/nested/last.bin", item_count: 50 };
  assert.equal(transferTaskName(batch), "src 等 3 项");
  assert.equal(transferTaskName({ ...batch, selection_count: 1 }), "src");
  assert.equal(transferPercent({ ...batch, total_bytes: 0, completed: 25 }), 50);
  assert.equal(transferPercent({ ...batch, transferred_bytes: 10 }), 100);
  assert.equal(transferPercent({ ...batch, total_bytes: 0, item_count: 0 }), 0);
});

test("queue retry participates in the same single-plan guard as new transfers", async (t) => {
  reset(t);
  let finish!: (result: TransferPlan) => void;
  const retry = t.mock.method(transferApi, "retry", () => new Promise<TransferPlan>((resolve) => { finish = resolve; }));
  const pending = useTransferStore.getState().retry("task");
  assert.equal(useTransferStore.getState().planning, true);
  await useTransferStore.getState().retry("other");
  assert.equal(retry.mock.callCount(), 1);
  finish(plan); await pending;
  assert.equal(useTransferStore.getState().plan?.id, plan.id);
  assert.equal(useTransferStore.getState().planning, false);
});

test("compact queue has state-specific actions, folded successes, and no empty block", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const render = () => renderToStaticMarkup(React.createElement(TransferQueue, { visible: true }));
  assert.equal(render(), "");
  useTransferStore.setState({ tasks: [
    { ...task("transferring"), id: "active", first_path: "active.bin" },
    { ...task("failed"), id: "failure", first_path: "failure.bin", failed: 1, error: "Permission denied" },
    { ...task("failed"), id: "unknown", first_path: "unknown.bin", unknown_count: 1, failed: 1 },
    { ...task("completed"), id: "done", first_path: "done.bin", completed: 1 },
  ] });
  const markup = render();
  assert.equal((markup.match(/<progress /g) ?? []).length, 1);
  assert.equal((markup.match(/aria-label="重试未完成项"/g) ?? []).length, 1);
  assert.ok(markup.includes("待核对")); assert.ok(markup.includes("Permission denied"));
  assert.ok(markup.includes('<details class="transfer-history"><summary>已完成（1）'));
  assert.ok(!markup.includes("transfer-task-heading")); assert.ok(!markup.includes('class="transfer-endpoint"'));
});

test("panel shows independent browsers and explicit partial results", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const ssh = { id: "ssh", name: "wsl", is_default: false, transport: "ssh" as const, host: "192.168.1.32", port: 22, username: "user", auth: { type: "key" as const, key_path: null }, workspace_root: "/data" };
  useAppStore.setState({ devices: [ssh, { ...ssh, id: "wsl", name: "wsl-u2404", transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "" } }] });
  useTransferStore.setState({ local: { ...initial.local, endpoint: local, directory: directory(local) }, device: { ...initial.device, endpoint: device, directory: directory(device) }, tasks: [{ ...task("partial"), failed: 1 }] });
  const markup = renderToStaticMarkup(React.createElement(FileTransferPanel, { visible: true, collapsed: false, onToggleCollapse: () => {} }));
  assert.ok(markup.includes("将 a.bin 上传到")); assert.ok(markup.includes("将 a.bin 下载到"));
  assert.ok(markup.includes("transfer-entry-action")); assert.ok(!markup.includes("目标："));
  assert.ok(!markup.includes('title="修改时间"')); assert.ok(!markup.includes("transfer-selection-actions"));
  assert.ok(markup.includes("隐藏文件传输面板")); assert.ok(markup.includes("前往目录（Enter）"));
  assert.ok(markup.includes("wsl · SSH · 192.168.1.32"));
  assert.ok(markup.includes('title="wsl · SSH · 192.168.1.32"'));
  assert.ok(markup.includes("wsl-u2404 · WSL")); assert.ok(!markup.includes("wsl-u2404 · WSL · 192.168.1.32"));
  assert.ok(!markup.includes("transfer-directions")); assert.ok(!markup.includes("transfer-new-directory"));
  assert.ok(markup.includes("部分完成")); assert.ok(markup.includes("重试未完成项"));
  assert.ok(!markup.includes(".env")); assert.ok(markup.includes("不支持传输此类型"));
});

test("browser loading, failure and empty directory states remain distinct", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  useTransferStore.setState({ local: { ...initial.local, endpoint: local, directory: directory(local) },
    device: { ...initial.device, endpoint: device, error: "Permission denied" } });
  const render = () => renderToStaticMarkup(React.createElement(FileTransferPanel, { visible: true, collapsed: false, onToggleCollapse: () => {} }));
  const failed = render();
  assert.ok(failed.includes(i18n.t("transfer.readFailed")));
  assert.ok(failed.includes("Permission denied"));
  assert.match(failed, />重试<\/button>/);
  assert.ok(!failed.includes(i18n.t("transfer.chooseDirectory")));
  useTransferStore.setState({ device: { ...initial.device, endpoint: device, loading: true } });
  const loading = render();
  assert.ok(loading.includes(i18n.t("transfer.loading")));
  assert.ok(!loading.includes(i18n.t("transfer.chooseDirectory")));
  assert.ok(!loading.includes(i18n.t("transfer.readFailed")));
  useTransferStore.setState({ device: { ...initial.device, endpoint: device, directory: { ...directory(device), entries: [] } } });
  const empty = render();
  assert.ok(empty.includes(i18n.t("transfer.emptyDirectory")));
  assert.ok(!empty.includes(i18n.t("transfer.chooseDirectory")));
});

test("batch actions appear in each selected browser and render in both languages", async (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  useTransferStore.setState({ local: { ...initial.local, endpoint: local, directory: directory(local), selected: ["a.bin", ".env"] }, device: { ...initial.device, endpoint: device, directory: directory(device), selected: ["a.bin"] } });
  const panel = React.createElement(FileTransferPanel, { visible: true, collapsed: false, onToggleCollapse: () => {} });
  const zh = renderToStaticMarkup(panel);
  assert.ok(zh.includes("上传所选（2）")); assert.ok(zh.includes("下载所选（1）"));
  assert.ok(zh.includes("transfer-selection-actions")); assert.ok(!zh.includes("目标："));
  try {
    await i18n.changeLanguage("en");
    const en = renderToStaticMarkup(panel);
    assert.ok(en.includes("Upload Selected (2)")); assert.ok(en.includes("Download Selected (1)"));
    assert.ok(en.includes("Hide File Transfer Panel")); assert.ok(en.includes("Go to Directory (Enter)"));
  } finally { await i18n.changeLanguage("zh"); }
});
