import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "../src/i18n";
import { localWorkspace, deviceWorkspace, type DeviceProfile, type WorkspaceRef } from "../src/api";
import { useAppStore } from "../src/store";
import { useTransferStore } from "../src/transferStore";
import { transferApi, type TransferPlan, type TransferSummary } from "../src/transferApi";
import { inlineTransferFor, loadHiddenTransfers } from "../src/workspaceTransfers";
import { WorkspaceTransferRow } from "../src/components/WorkspaceTransferRow";
import { WorkspaceEntryRow } from "../src/components/WorkspaceEntryRow";
import { createDeviceWorkspaceStore, deviceWorkspaceKey, deviceWorkspaceTarget, registerDeviceWorkspaceTarget } from "../src/deviceWorkspaceStore";

const local = localWorkspace("C:\\work"), device = deviceWorkspace("ssh", "/work");
const host: DeviceProfile = { id: "ssh", revision: "v1", name: "box", transport: "ssh", host: "box", port: 22, username: "user", auth: { type: "key", key_path: null }, workspace_root: "/work", is_default: false };
const attrs = { kind: "file", size: 100, identity: "a", modified: "0", mode: null };
const initial = useTransferStore.getState();
const summary = (extra: Partial<TransferSummary> = {}): TransferSummary => ({ id: "task", source: local, target: device, first_path: "folder", selection_count: 1, state: "transferring", total_bytes: 100, transferred_bytes: 42, current_path: "folder/a.bin", error: null, sequence: 1, item_count: 2, completed: 0, skipped: 0, failed: 0, pending_count: 2, unknown_count: 0, residual_count: 0, warning_count: 0, ...extra });
const plan = (request: TransferPlan["request"]): TransferPlan => ({ id: "plan", request, items: [{ path: request.paths[0], attrs, target_attrs: null, state: "pending", target_path: null, error: null }], total_bytes: 100, conflicts: 0, warnings: [], overwrite: true, keep_both: true });
const tab = (name: string) => ({ name, fileContent: "dirty", savedContent: "saved", revision: "r", generation: 1, eol: "lf" as const, bom: false, language: "text" as const, conflict: false });
test.before(async () => { await i18n.changeLanguage("zh"); });

function reset(t: test.TestContext) {
  const app = useAppStore.getState();
  const peer = deviceWorkspaceTarget.getState();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  useTransferStore.setState({ ...initial, inlineHiddenIds: [] });
  useAppStore.setState({ workspace: local, devices: [host], selectedDeviceId: "ssh", openTabs: [], workspaceTree: {}, saving: false, starting: false, updating: false, loading: false, guarding: false, workspaceMutating: false });
  useAppStore.setState({ layout: { ...app.layout, sidebarVisible: true, panelVisible: { ...app.layout.panelVisible, deviceWorkspace: true }, panelCollapsed: { ...app.layout.panelCollapsed, deviceWorkspace: false } } });
  deviceWorkspaceTarget.setState({ root: device, key: deviceWorkspaceKey(host), generation: 1, ready: true });
  t.after(() => {
    useTransferStore.setState(initial); useAppStore.setState(app);
    deviceWorkspaceTarget.setState(peer);
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  t.mock.method(transferApi, "list", async (endpoint) => ({ endpoint, entries: [], overwrite: true }));
  t.mock.method(transferApi, "start", async () => "new-task");
  t.mock.method(transferApi, "snapshot", async () => []);
  t.mock.method(transferApi, "discard", async () => {});
  return data;
}

for (const upload of [true, false]) test(`workspace ${upload ? "upload" : "download"} preserves relative paths and starts without dialogs`, async (t) => {
  reset(t);
  const workspace = upload ? local : device, target = upload ? device : local;
  const layout = useAppStore.getState().layout;
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  await useTransferStore.getState().requestWorkspaceTransfer(workspace, "nested/a.bin", false);
  assert.deepEqual(scan.mock.calls[0].arguments[0].source, workspace);
  assert.deepEqual(scan.mock.calls[0].arguments[0].paths, ["nested/a.bin"]);
  assert.deepEqual(scan.mock.calls[0].arguments[0].target, target);
  assert.deepEqual(start.mock.calls[0].arguments, ["plan", "skip", false]);
  assert.equal(useTransferStore.getState().plan, null);
  assert.equal(useTransferStore.getState().workspaceTransfer, null);
  assert.equal(useTransferStore.getState().inlineOrigins["new-task"].path, "nested/a.bin");
  assert.equal(useAppStore.getState().layout, layout);
});

test("only existing-file conflicts open a plan, and changing the peer invalidates it", async (t) => {
  reset(t);
  t.mock.method(transferApi, "plan", async (request) => ({ ...plan(request), conflicts: 1 }));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(useTransferStore.getState().plan?.conflicts, 1);
  assert.equal(useTransferStore.getState().workspaceTransfer, null);
  assert.equal(useTransferStore.getState().inlinePlanCurrent?.(), true);
  deviceWorkspaceTarget.setState({ generation: 2 });
  assert.equal(useTransferStore.getState().inlinePlanCurrent?.(), false);
});

test("downloads protect currently open destination files", async (t) => {
  reset(t);
  useAppStore.setState({ openTabs: [{ ...tab("nested/a.bin"), fileContent: "saved" }] });
  const scan = t.mock.method(transferApi, "plan", async (request) => ({ ...plan(request), conflicts: 1 }));
  await useTransferStore.getState().requestWorkspaceTransfer(device, "nested/a.bin", false);
  assert.deepEqual(scan.mock.calls[0].arguments[0].protected_paths, ["nested/a.bin"]);
});

test("canceling an unsaved source never scans or starts a transfer", async (t) => {
  reset(t);
  useAppStore.setState({ openTabs: [tab("a.bin")] });
  t.mock.method(useAppStore.getState(), "confirmAllUnsaved", async () => false);
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(useTransferStore.getState().workspaceTransfer, null);
  assert.equal(useTransferStore.getState().planning, false);
});

test("a missing device workspace only shows a notice without opening panels or starting a transfer", async (t) => {
  reset(t);
  deviceWorkspaceTarget.setState({ root: null, ready: false });
  const app = useAppStore.getState();
  useAppStore.setState({ layout: { ...app.layout, panelVisible: { ...app.layout.panelVisible, deviceWorkspace: false } } });
  const layout = useAppStore.getState().layout;
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
  assert.equal(useAppStore.getState().layout, layout);
  assert.match(useTransferStore.getState().inlineNotice!.message, /设备工作区未打开/);
  assert.equal(useTransferStore.getState().inlineError, null);
  assert.equal(useTransferStore.getState().workspaceTransfer, null);
  assert.equal(useTransferStore.getState().plan, null);
  const resolved = deviceWorkspace("ssh", "/home/user/actual-work");
  deviceWorkspaceTarget.setState({ root: resolved, ready: true });
  assert.equal(scan.mock.callCount(), 0);
  useAppStore.setState({ layout: { ...layout, panelVisible: { ...layout.panelVisible, deviceWorkspace: true } } });
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.deepEqual(scan.mock.calls[0].arguments[0].target, resolved);
  assert.equal(useTransferStore.getState().inlineNotice, null);
});

test("missing devices, unloaded roots and missing local workspaces never create plans", async (t) => {
  reset(t);
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  deviceWorkspaceTarget.setState({ ready: false });
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  useAppStore.setState({ selectedDeviceId: null });
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.match(useTransferStore.getState().inlineNotice!.message, /选择 SSH/);
  useAppStore.setState({ selectedDeviceId: "ssh", workspace: null });
  deviceWorkspaceTarget.setState({ ready: true });
  await useTransferStore.getState().requestWorkspaceTransfer(device, "a.bin", false);
  assert.match(useTransferStore.getState().inlineNotice!.message, /本机工作区/);
  assert.equal(scan.mock.callCount(), 0);
});

for (const changed of ["device", "source", "destination"] as const) test(`changing the ${changed} during preflight discards the stale plan`, async (t) => {
  reset(t);
  let finish!: (result: TransferPlan) => void;
  let captured!: TransferPlan["request"];
  t.mock.method(transferApi, "plan", (request) => { captured = request; return new Promise<TransferPlan>((resolve) => { finish = resolve; }); });
  const discard = t.mock.method(transferApi, "discard", async () => {});
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  const pending = useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  if (changed === "device") useAppStore.setState({ devices: [{ ...host, revision: "v2" }] });
  else if (changed === "source") useAppStore.setState({ workspace: localWorkspace("C:\\other") });
  else deviceWorkspaceTarget.setState({ root: deviceWorkspace("ssh", "/other"), generation: 2 });
  finish(plan(captured)); await pending;
  assert.equal(useTransferStore.getState().plan, null);
  assert.equal(start.mock.callCount(), 0);
  assert.deepEqual(discard.mock.calls[0].arguments, ["plan"]);
  assert.match(useTransferStore.getState().inlineError!.message, /设备或目录已变化/);
});

test("direct submission failure stays visible in the source workspace", async (t) => {
  reset(t);
  t.mock.method(transferApi, "plan", async (request) => plan(request));
  t.mock.method(transferApi, "start", async () => { throw new Error("permission denied"); });
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.equal(useTransferStore.getState().inlineError?.message, "permission denied");
  assert.equal(useTransferStore.getState().planning, false);
});

test("retrying unfinished workspace files without conflicts starts immediately", async (t) => {
  reset(t);
  useTransferStore.setState({ tasks: [summary({ state: "failed", failed: 1 })] });
  t.mock.method(transferApi, "retry", async () => plan({ source: local, target: device, paths: ["folder/a.bin"], exclude_project_files: false, protected_paths: [] }));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  await useTransferStore.getState().retry("task", "workspace");
  assert.equal(start.mock.callCount(), 1);
  assert.equal(useTransferStore.getState().plan, null);
  assert.equal(useTransferStore.getState().inlineOrigins["new-task"].path, "folder");
});

test("the peer root is unavailable until the sidebar has successfully resolved its directory", async (t) => {
  reset(t);
  const browser = createDeviceWorkspaceStore(new Map());
  const detach = registerDeviceWorkspaceTarget(browser);
  t.after(detach);
  let finish!: (result: Awaited<ReturnType<typeof transferApi.listWithin>>) => void;
  t.mock.method(transferApi, "listWithin", () => new Promise((resolve) => { finish = resolve; }));
  const pending = browser.getState().follow(host);
  assert.equal(deviceWorkspaceTarget.getState().ready, false);
  const resolved = deviceWorkspace("ssh", "/resolved/work");
  finish({ endpoint: resolved, entries: [], overwrite: true });
  await pending;
  assert.equal(deviceWorkspaceTarget.getState().ready, true);
  assert.deepEqual(deviceWorkspaceTarget.getState().root, resolved);
  detach();
  assert.equal(deviceWorkspaceTarget.getState().ready, false);
  assert.equal(deviceWorkspaceTarget.getState().root, null);
});

test("a successful submission survives snapshot failure without another start or conflict dialog", async (t) => {
  reset(t);
  t.mock.method(transferApi, "plan", async (request) => plan(request));
  const start = t.mock.method(transferApi, "start", async () => "new-task");
  t.mock.method(transferApi, "snapshot", async () => { throw new Error("temporary disconnect"); });
  await useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  assert.equal(start.mock.callCount(), 1);
  assert.ok(useTransferStore.getState().registeredIds.includes("new-task"));
  assert.equal(useTransferStore.getState().plan, null);
  assert.equal(useTransferStore.getState().inlineError, null);
});

test("directory rows own aggregate progress and current child rows never reuse that percentage", (t) => {
  reset(t);
  const task = summary();
  assert.equal(inlineTransferFor(local, "folder", [task], [], {}, {})?.nested, false);
  assert.equal(inlineTransferFor(local, "folder/a.bin", [task], [], {}, {})?.nested, true);
  assert.equal(inlineTransferFor(local, "folder/b.bin", [task], [], {}, {}), null);
  assert.equal(inlineTransferFor(device, "folder", [task], [], {}, {}), null);
  assert.equal(inlineTransferFor(localWorkspace("C:\\WORK"), "folder", [task], [], {}, {})?.task.id, task.id);
});

test("completion clears at 30 seconds and failed states remain until explicitly cleared", (t) => {
  reset(t);
  const completed = summary({ state: "completed", completed: 2, pending_count: 0 });
  assert.ok(inlineTransferFor(local, "folder", [completed], [], { task: 31_000 }, {}, 30_999));
  assert.equal(inlineTransferFor(local, "folder", [completed], [], { task: 31_000 }, {}, 31_000), null);
  const failed = summary({ state: "failed", failed: 1, pending_count: 1 });
  assert.ok(inlineTransferFor(local, "folder", [failed], [], {}, {}, 1_000_000));
  assert.equal(inlineTransferFor(local, "folder", [failed], [failed.id], {}, {}), null);
});

test("clearing a failure persists only UI dismissal and cannot cancel or delete a task", (t) => {
  reset(t);
  const failed = summary({ state: "failed", failed: 1 });
  useTransferStore.setState({ tasks: [failed], inlineDetailsId: failed.id });
  useTransferStore.getState().clearInlineTransfer(failed.id);
  assert.deepEqual(useTransferStore.getState().tasks, [failed]);
  assert.deepEqual(loadHiddenTransfers(), [failed.id]);
  assert.equal(useTransferStore.getState().inlineDetailsId, null);
  useTransferStore.setState({ tasks: [summary({ id: "running" })] });
  useTransferStore.getState().clearInlineTransfer("running");
  assert.deepEqual(loadHiddenTransfers(), [failed.id]);
});

test("cleared or expired latest results never revive an older failure on the same file", (t) => {
  reset(t);
  const old = summary({ id: "older", state: "failed", failed: 1 });
  const latest = summary({ id: "latest", state: "completed", completed: 2, pending_count: 0 });
  assert.equal(inlineTransferFor(local, "folder", [latest, old], [], {}, {}), null);
  assert.equal(inlineTransferFor(local, "folder", [{ ...latest, state: "failed" }, old], ["latest"], {}, {}), null);
});

test("a retry stays attached to its original directory even when only a nested file failed", async (t) => {
  reset(t);
  const original = summary({ id: "old", state: "partial", failed: 1, first_path: "folder" });
  useTransferStore.setState({ tasks: [original] });
  const retryPlan = plan({ source: local, target: device, paths: ["folder/a.bin"], exclude_project_files: false, protected_paths: [] });
  t.mock.method(transferApi, "retry", async () => retryPlan);
  await useTransferStore.getState().retry(original.id, "workspace");
  useTransferStore.getState().register("new");
  const retried = summary({ id: "new", retry_of: "old", first_path: "folder/a.bin" });
  const tasks = [retried, { ...original, superseded_by: "new" }];
  const origins = useTransferStore.getState().inlineOrigins;
  assert.equal(inlineTransferFor(local, "folder", tasks, [], {}, origins)?.task.id, "new");
  assert.equal(inlineTransferFor(local, "folder", tasks, [], {}, {})?.task.id, "new", "restart can reconstruct the directory from task lineage");
});

test("failed rows retain both retry and clear while clearing restores the ordinary file row", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const task = summary({ state: "failed", failed: 1 });
  useTransferStore.setState({ tasks: [task] });
  const render = () => renderToStaticMarkup(createElement(WorkspaceTransferRow, { workspace: local, path: "folder", children: createElement("button", null, "folder") }));
  assert.match(render(), /aria-label="重试 folder"/);
  assert.match(render(), /aria-label="清除 folder 的传输状态"/);
  useTransferStore.getState().clearInlineTransfer(task.id);
  assert.equal(render(), "<button>folder</button>");
});

test("retry errors are visible through row details when the transfer panel is hidden", async (t) => {
  reset(t);
  const failed = summary({ state: "failed", failed: 1 });
  useTransferStore.setState({ tasks: [failed] });
  t.mock.method(transferApi, "retry", async () => { throw new Error("connection failed"); });
  await useTransferStore.getState().retry(failed.id, "workspace");
  assert.equal(useTransferStore.getState().inlineDetailsId, failed.id);
  assert.deepEqual(useTransferStore.getState().inlineActionError, { id: failed.id, message: "connection failed" });
  assert.equal(useTransferStore.getState().planning, false);
});

test("transfer states take priority over hover shortcuts and restore shortcuts after clearing", (t) => {
  reset(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const render = () => renderToStaticMarkup(createElement(WorkspaceEntryRow, {
    workspace: local, path: "folder", name: "folder", directory: true, disabled: false,
    onMore: () => {}, onNew: () => {}, onContextMenu: () => {}, children: createElement("button", { className: "tree-row" }, "folder"),
  }));
  useTransferStore.setState({ tasks: [summary()] });
  assert.match(render(), /aria-label="取消传输 folder"/);
  assert.doesNotMatch(render(), /workspace-entry-actions/);
  useTransferStore.setState({ tasks: [summary({ state: "failed", failed: 1 })] });
  assert.match(render(), /aria-label="重试 folder"/);
  assert.match(render(), /aria-label="清除 folder 的传输状态"/);
  assert.doesNotMatch(render(), /workspace-entry-actions/);
  useTransferStore.getState().clearInlineTransfer("task");
  assert.match(render(), /workspace-entry-actions/);
});
