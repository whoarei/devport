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
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  useTransferStore.setState({ ...initial, inlineHiddenIds: [] });
  useAppStore.setState({ workspace: local, devices: [host], selectedDeviceId: "ssh", openTabs: [], workspaceTree: {}, saving: false, starting: false, updating: false, loading: false, guarding: false, workspaceMutating: false });
  t.after(() => {
    useTransferStore.setState(initial); useAppStore.setState(app);
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  t.mock.method(transferApi, "list", async (endpoint) => ({ endpoint, entries: [], overwrite: true }));
  return data;
}

for (const upload of [true, false]) test(`workspace ${upload ? "upload" : "download"} fixes the selected source without opening the transfer panel`, async (t) => {
  reset(t);
  const workspace = upload ? local : device, target = upload ? device : local;
  const layout = useAppStore.getState().layout;
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  useTransferStore.getState().requestWorkspaceTransfer(workspace, "nested/a.bin", false);
  const request = useTransferStore.getState().workspaceTransfer;
  assert.ok(request);
  assert.equal(useAppStore.getState().layout, layout);
  await useTransferStore.getState().prepareWorkspaceTransfer(target);
  assert.deepEqual(scan.mock.calls[0].arguments[0].source, upload ? localWorkspace("C:\\work\\nested") : deviceWorkspace("ssh", "/work/nested"));
  assert.deepEqual(scan.mock.calls[0].arguments[0].paths, ["a.bin"]);
  assert.deepEqual(scan.mock.calls[0].arguments[0].target, target);
  assert.equal(useTransferStore.getState().planOwner, "workspace");
  assert.equal(useTransferStore.getState().workspaceTransfer, null);
  assert.equal(useTransferStore.getState().inlinePlanOrigin, request);
  assert.equal(useAppStore.getState().layout, layout);
});

test("workspace transfers resolve HOME targets and use the current open-file protection", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: device, openTabs: [{ ...tab("a.bin"), fileContent: "saved" }] });
  t.mock.method(transferApi, "list", async () => ({ endpoint: device, entries: [], overwrite: true }));
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  await useTransferStore.getState().prepareWorkspaceTransfer(deviceWorkspace("ssh", "~/work"));
  assert.deepEqual(scan.mock.calls[0].arguments[0].target, device);
  assert.deepEqual(scan.mock.calls[0].arguments[0].protected_paths, ["a.bin"]);
});

test("canceling an unsaved source keeps the destination dialog and never scans files", async (t) => {
  reset(t);
  useAppStore.setState({ openTabs: [tab("a.bin")] });
  t.mock.method(useAppStore.getState(), "confirmAllUnsaved", async () => false);
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  await useTransferStore.getState().prepareWorkspaceTransfer(device);
  assert.equal(scan.mock.callCount(), 0);
  assert.ok(useTransferStore.getState().workspaceTransfer);
  assert.equal(useTransferStore.getState().planning, false);
});

test("a changed source connection invalidates destination selection", async (t) => {
  reset(t);
  const scan = t.mock.method(transferApi, "plan", async (request) => plan(request));
  useTransferStore.getState().requestWorkspaceTransfer(device, "a.bin", false);
  useAppStore.setState({ devices: [{ ...host, revision: "v2" }] });
  await useTransferStore.getState().prepareWorkspaceTransfer(local);
  assert.equal(scan.mock.callCount(), 0);
  assert.match(useTransferStore.getState().error!, /设备或目录已变化/);
});

test("connection changes during preflight discard the stale backend plan", async (t) => {
  reset(t);
  let finish!: (result: TransferPlan) => void;
  let captured!: TransferPlan["request"];
  t.mock.method(transferApi, "plan", (request) => { captured = request; return new Promise<TransferPlan>((resolve) => { finish = resolve; }); });
  const discard = t.mock.method(transferApi, "discard", async () => {});
  useTransferStore.getState().requestWorkspaceTransfer(local, "a.bin", false);
  const pending = useTransferStore.getState().prepareWorkspaceTransfer(device);
  await Promise.resolve();
  useAppStore.setState({ devices: [{ ...host, revision: "v2" }] });
  finish(plan(captured)); await pending;
  assert.equal(useTransferStore.getState().plan, null);
  assert.deepEqual(discard.mock.calls[0].arguments, ["plan"]);
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
