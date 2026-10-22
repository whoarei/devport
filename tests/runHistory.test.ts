import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile, type RunReplay, type RunStatus, type WorkspaceRunRequest } from "../src/api";
import { useAppStore } from "../src/store";
import { useWorkspaceRunStore } from "../src/workspaceRunStore";
import { useTerminalStore } from "../src/terminalStore";
import { submitHistoryRun, useRunHistoryStore } from "../src/runHistoryStore";
import { decodeHistoryOutput, historyDraft, historyEntries } from "../src/runHistory";
import { latestExecution } from "../src/runState";
import { RunToolbar } from "../src/components/RunToolbar";
import { RunHistoryPanel } from "../src/components/RunHistoryPanel";
import { RunHistorySummary } from "../src/components/RunHistoryPreview";
import i18n from "../src/i18n";

const workspace = localWorkspace("/project");
const device = (id: string): DeviceProfile => ({ id, revision: `rev-${id}`, name: id, transport: "ssh", host: id, port: 22, username: "user", auth: { type: "key", key_path: null }, workspace_root: "/runs", is_default: false });
function record(id = "old"): RunStatus {
  const request: WorkspaceRunRequest = { workspace, device_id: "a", device_revision: "rev-a", config_revision: "old-config", command: { entry: { type: "python_script", path: "run.py" }, args: ["", "a b", "汉字", "$(echo x)"] }, python: "project", settings: { cwd: "tools", env: { X: "historical", SECRET_TOKEN: "private-value" }, console_mode: "pipe", timeout_secs: 12, cols: 90, rows: 30 } };
  const replay: RunReplay = { request: { device_id: "a", workspace, kind: "python", entry: "run.py", args: request.command.args, env: request.settings.env, cwd: "tools", console_mode: "pipe", timeout_secs: 12 }, workspace_request: request, device_revision: "rev-a", source_revision: null, device_target: "user@a:22", launch: null };
  return { run_id: id, label: "run.py", device_name: "a", state: "exited", exit_code: 0, error: null, started_at: "2026-10-22T12:00:00+08:00", ended_at: "2026-10-22T12:00:01+08:00", replay };
}
function setup(t: test.TestContext) {
  const app = useAppStore.getState(), feature = useWorkspaceRunStore.getState(), history = useRunHistoryStore.getState(), terminal = useTerminalStore.getState();
  t.after(() => { useAppStore.setState(app, true); useWorkspaceRunStore.setState(feature, true); useRunHistoryStore.setState(history, true); useTerminalStore.setState(terminal, true); });
  useAppStore.setState({ workspace, devices: [device("a"), device("b")], selectedDeviceId: "b", openTabs: [], loading: false, saving: false, starting: false, guarding: false, updating: false, workspaceMutating: false, runs: { old: record() }, history: [record()], outputBuffers: {}, activeRunId: "old", saveAllDirty: async () => true, consoleSize: { cols: 80, rows: 24 } });
  useRunHistoryStore.setState({ detailId: null, draft: null, error: null, busy: false });
  useWorkspaceRunStore.setState({ sessions: {}, warnings: {}, preferences: { python: { b: "device_default" }, bash: {}, console_mode: "pty", timeout_secs: 99, env: { X: "current" } } });
  t.mock.method(console, "warn", () => {});
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  t.mock.method(api, "getRunStatus", async () => ({ ...record("new"), state: "running", ended_at: null }));
}
test.before(async () => { await i18n.changeLanguage("zh"); });

test("original-device replay preserves literal args and historical settings despite toolbar changes during save", async t => {
  setup(t); let saved!: () => void, submitted!: WorkspaceRunRequest;
  useAppStore.setState({ saveAllDirty: () => new Promise(resolve => { saved = () => resolve(true); }) });
  t.mock.method(api, "runWorkspace", async r => { submitted = r; return "new"; });
  const original = record(), draft = historyDraft(original, useAppStore.getState().devices)!;
  const pending = submitHistoryRun(draft);
  useAppStore.setState({ selectedDeviceId: "b" });
  saved(); await pending;
  assert.equal(submitted.device_id, "a"); assert.equal(submitted.python, "project");
  assert.deepEqual(submitted.command.args, original.replay!.workspace_request!.command.args);
  assert.deepEqual(submitted.settings, { ...original.replay!.workspace_request!.settings, cols: 80, rows: 24 });
  assert.equal(submitted.config_revision, undefined);
  assert.equal(original.replay!.workspace_request!.config_revision, "old-config");
  assert.equal(useAppStore.getState().selectedDeviceId, "b"); assert.equal(useAppStore.getState().activeRunId, "new");
});

test("current-device replay changes only the device and uses its current revision", async t => {
  setup(t); let submitted!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async r => { submitted = r; return "new"; });
  await useRunHistoryStore.getState().rerun(record(), "current");
  assert.equal(submitted.device_id, "b"); assert.equal(submitted.device_revision, "rev-b");
  assert.equal(submitted.settings.cwd, "tools"); assert.equal(submitted.settings.env.X, "historical"); assert.equal(submitted.settings.timeout_secs, 12);
  assert.equal(useAppStore.getState().history[0].run_id, "old");
});

test("changed or deleted original devices open the editor without running or falling back to current device", async t => {
  setup(t); let invoked = 0;
  t.mock.method(api, "runWorkspace", async () => { invoked++; return "new"; });
  useAppStore.setState({ devices: [{ ...device("a"), revision: "changed" }, device("b")] });
  await useRunHistoryStore.getState().rerun(record(), "original");
  assert.equal(invoked, 0); assert.match(useRunHistoryStore.getState().draft!.notice!, /设备/);
  useAppStore.setState({ devices: [device("b")] });
  await useRunHistoryStore.getState().rerun(record(), "original");
  assert.equal(useRunHistoryStore.getState().draft!.deviceId, "a"); assert.equal(invoked, 0);
});

test("a source or target revision change during saving aborts the replay", async t => {
  setup(t); let saved!: () => void, invoked = 0;
  useAppStore.setState({ saveAllDirty: () => new Promise(resolve => { saved = () => resolve(true); }) });
  t.mock.method(api, "runWorkspace", async () => { invoked++; return "new"; });
  const task = submitHistoryRun(historyDraft(record(), useAppStore.getState().devices)!);
  useAppStore.setState({ devices: [{ ...device("a"), revision: "changed" }, device("b")] });
  saved(); await assert.rejects(task, /设备/); assert.equal(invoked, 0); assert.equal(useAppStore.getState().starting, false);
});

test("cross-workspace replay respects cancellation of the ordinary workspace switch", async t => {
  setup(t); let invoked = 0, switched = false;
  useAppStore.setState({ workspace: localWorkspace("/other"), setWorkspace: async () => { switched = true; } });
  t.mock.method(api, "runWorkspace", async () => { invoked++; return "new"; });
  assert.equal(await submitHistoryRun(historyDraft(record(), useAppStore.getState().devices)!), null);
  assert.equal(switched, true); assert.equal(invoked, 0);
});

test("changed remote workspace sources require review even when replaying on the current device", async t => {
  setup(t); const run = record();
  run.replay!.workspace_request!.workspace = deviceWorkspace("a", "/p");
  run.replay!.source_revision = "old-source";
  await useRunHistoryStore.getState().rerun(run, "current");
  assert.match(useRunHistoryStore.getState().draft!.notice!, /源工作区/);
});

test("preset command replay retains the original target and raw shell command", async t => {
  setup(t); let submitted: unknown, revision: unknown;
  const run = record(); run.replay!.workspace_request = null;
  run.replay!.request = { kind: "command", command: "printf '%s' '$literal'\necho done", device_id: "a", workspace, console_mode: "pipe", timeout_secs: 18 };
  t.mock.method(api, "runScript", async (r, rev) => { submitted = r; revision = rev; return "new"; });
  await useRunHistoryStore.getState().rerun(run, "original");
  assert.deepEqual(submitted, { ...run.replay!.request, cols: 80, rows: 24 }); assert.equal(revision, "rev-a");
});

test("viewing historical output never replaces the latest console task; delete only updates after backend succeeds", async t => {
  setup(t); useRunHistoryStore.getState().view("older");
  assert.equal(useAppStore.getState().activeRunId, "old");
  t.mock.method(api, "deleteRunHistory", async () => { throw new Error("disk write failed"); });
  await useRunHistoryStore.getState().remove(record());
  assert.ok(useAppStore.getState().runs.old); assert.match(useRunHistoryStore.getState().error!, /disk/);
});

test("history pins all running tasks, filters completed workspaces, and excludes preparation tasks", () => {
  const current = record(), other = record("other"), active = record("active"), prep = record("prep");
  other.replay!.workspace_request!.workspace = localWorkspace("/other"); active.replay!.workspace_request!.workspace = localWorkspace("/other");
  active.state = "running"; prep.replay!.workspace_request!.operation = "prepare"; prep.started_at = "2027";
  const runs = { current, other, active, prep };
  assert.deepEqual(historyEntries(runs, workspace).map(r => r.run_id), ["active", "old"]);
  assert.equal(historyEntries(runs, workspace, true).length, 3);
  assert.notEqual(latestExecution(runs)?.run_id, "prep");
});

test("toolbar has no task picker; history shows compact actions and hover summaries omit environment values", t => {
  setup(t);
  const toolbar = renderToStaticMarkup(createElement(RunToolbar));
  assert.doesNotMatch(toolbar, /run-task-select|选择运行中的任务/); assert.match(toolbar, /最后一次任务/); assert.match(toolbar, /重新启动/);
  const panel = renderToStaticMarkup(createElement(RunHistoryPanel, { visible: true, collapsed: false, onToggleCollapse() {} }));
  assert.match(panel, /原设备重跑/); assert.doesNotMatch(panel, /private-value/);
  const summary = renderToStaticMarkup(createElement(RunHistorySummary, { run: record() }));
  assert.match(summary, /a b/); assert.doesNotMatch(summary, /private-value/);
  assert.equal(decodeHistoryOutput(btoa("\x1b[31mOK\x1b[0m\r\n")), "OK\n");
});

test("old records never guess missing run settings", async t => {
  setup(t); const old = record(); delete old.replay;
  await useRunHistoryStore.getState().rerun(old, "original");
  assert.equal(useRunHistoryStore.getState().draft, null); assert.ok(useRunHistoryStore.getState().error);
});
