import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile, type RunReplay, type RunStatus, type WorkspaceRunRequest } from "../src/api";
import { useAppStore } from "../src/store";
import { useWorkspaceRunStore } from "../src/workspaceRunStore";
import { useTerminalStore } from "../src/terminalStore";
import { loadDeletedRunHistoryEvents, submitHistoryRun, useRunHistoryStore } from "../src/runHistoryStore";
import { decodeHistoryOutput, historyDraft, historyEntries } from "../src/runHistory";
import { latestExecution } from "../src/runState";
import { RunToolbar } from "../src/components/RunToolbar";
import { RunHistoryPanel } from "../src/components/RunHistoryPanel";
import { RunHistorySummary } from "../src/components/RunHistoryPreview";
import i18n from "../src/i18n";
import { eventText, useEventStore } from "../src/eventStore";

const workspace = localWorkspace("/project");
const device = (id: string): DeviceProfile => ({ id, revision: `rev-${id}`, name: id, transport: "ssh", host: id, port: 22, username: "user", auth: { type: "key", key_path: null }, workspace_root: "/runs", is_default: false });
function record(id = "old"): RunStatus {
  const request: WorkspaceRunRequest = { workspace, device_id: "a", device_revision: "rev-a", config_revision: "old-config", command: { entry: { type: "python_script", path: "run.py" }, args: ["", "a b", "汉字", "$(echo x)"] }, python: "project", settings: { cwd: "tools", env: { X: "historical", SECRET_TOKEN: "private-value" }, console_mode: "pipe", timeout_secs: 12, cols: 90, rows: 30 } };
  const replay: RunReplay = { request: { device_id: "a", workspace, kind: "python", entry: "run.py", args: request.command.args, env: request.settings.env, cwd: "tools", console_mode: "pipe", timeout_secs: 12 }, workspace_request: request, device_revision: "rev-a", source_revision: null, device_target: "user@a:22", launch: null };
  return { run_id: id, label: "run.py", device_name: "a", state: "exited", exit_code: 0, error: null, started_at: "2026-10-22T12:00:00+08:00", ended_at: "2026-10-22T12:00:01+08:00", replay };
}
function setup(t: test.TestContext) {
  const app = useAppStore.getState(), feature = useWorkspaceRunStore.getState(), history = useRunHistoryStore.getState(), terminal = useTerminalStore.getState(), events = useEventStore.getState();
  t.after(() => { useAppStore.setState(app, true); useWorkspaceRunStore.setState(feature, true); useRunHistoryStore.setState(history, true); useTerminalStore.setState(terminal, true); useEventStore.setState(events, true); });
  useAppStore.setState({ workspace, devices: [device("a"), device("b")], selectedDeviceId: "b", openTabs: [], loading: false, saving: false, starting: false, guarding: false, updating: false, workspaceMutating: false, runs: { old: record() }, history: [record()], deletedRunIds: new Set(), outputBuffers: {}, activeRunId: "old", saveAllDirty: async () => true, consoleSize: { cols: 80, rows: 24 } });
  useRunHistoryStore.setState({ detailId: null, draft: null, error: null, busy: false, historyBusy: false });
  useEventStore.setState({ events: [], running: [] });
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
  t.mock.method(api, "archiveRunHistory", async () => { throw new Error("disk write failed"); });
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

test("clear follows the visible workspace scope, preserves active runs, and its event restores the original records", async t => {
  setup(t);
  const old = record(), other = record("other"), live = { ...record("live"), state: "running", ended_at: null };
  other.replay!.workspace_request!.workspace = localWorkspace("/other");
  live.replay!.workspace_request!.workspace = localWorkspace("/elsewhere");
  useAppStore.setState({ runs: { old, other, live }, history: [old, other], activeRunId: "live" });
  useRunHistoryStore.getState().view("old");
  t.mock.method(api, "archiveRunHistory", async ids => {
    assert.deepEqual(ids, ["old"]);
    assert.ok(useAppStore.getState().runs.old);
    return { id: "clear", deleted_at: "2026-10-22T06:00:00Z", run_ids: ids };
  });
  t.mock.method(api, "restoreRunHistory", async id => { assert.equal(id, "clear"); return [old]; });
  t.mock.method(api, "getRunHistory", async () => [old, other]);
  t.mock.method(api, "listRunningRuns", async () => [live]);
  await useRunHistoryStore.getState().clear(historyEntries(useAppStore.getState().runs, workspace));
  assert.deepEqual(Object.keys(useAppStore.getState().runs), ["other", "live"]);
  assert.equal(useRunHistoryStore.getState().detailId, null);
  assert.equal(useAppStore.getState().activeRunId, "live");
  const event = useEventStore.getState().events[0];
  assert.equal(event.timestamp, Date.parse("2026-10-22T06:00:00Z"));
  assert.equal(event.dismissible, false);
  assert.equal(eventText(event.title), "已移除 1 条历史命令");
  assert.equal(event.message, undefined);
  await useEventStore.getState().runAction(event.id);
  assert.deepEqual(useAppStore.getState().runs.old, old);
  assert.deepEqual(useAppStore.getState().runs.old.replay, old.replay);
  assert.equal(useAppStore.getState().activeRunId, "live");
  assert.equal(useEventStore.getState().events.length, 0);
});

test("clear all skips active and preparation tasks; clear with only active tasks is a no-op", async t => {
  setup(t);
  const live = { ...record("live"), state: "running", ended_at: null }, prep = record("prep"), other = record("other");
  other.replay!.workspace_request!.workspace = localWorkspace("/other");
  prep.replay!.workspace_request!.operation = "prepare";
  useAppStore.setState({ runs: { old: record(), other, live, prep }, history: [record(), other, prep] });
  const archive = t.mock.method(api, "archiveRunHistory", async ids => ({ id: "all", deleted_at: new Date().toISOString(), run_ids: ids }));
  await useRunHistoryStore.getState().clear(historyEntries(useAppStore.getState().runs, workspace, true));
  assert.deepEqual(new Set(archive.mock.calls[0].arguments[0]), new Set(["old", "other"]));
  assert.deepEqual(Object.keys(useAppStore.getState().runs), ["live", "prep"]);
  await useRunHistoryStore.getState().clear([live]);
  assert.equal(archive.mock.callCount(), 1);
});

test("failed clear preserves history, output, selection and details and reports an application event", async t => {
  setup(t);
  const output = { chunks: [new Uint8Array([65])], bytes: 1, start: 0 };
  useAppStore.setState({ outputBuffers: { old: output } });
  useRunHistoryStore.getState().view("old");
  t.mock.method(api, "archiveRunHistory", async () => { throw new Error("disk full"); });
  await useRunHistoryStore.getState().clear([record()]);
  assert.ok(useAppStore.getState().runs.old);
  assert.equal(useAppStore.getState().activeRunId, "old");
  assert.equal(useAppStore.getState().outputBuffers.old, output);
  assert.equal(useRunHistoryStore.getState().detailId, "old");
  assert.equal(useRunHistoryStore.getState().historyBusy, false);
  assert.equal(useEventStore.getState().events[0].level, "error");
  assert.equal(useEventStore.getState().events[0].message, "disk full");
  assert.equal(useEventStore.getState().events[0].action, undefined);
});

test("late status, resync and in-flight snapshots cannot revive cleared history", async t => {
  setup(t);
  let snapshot!: (runs: RunStatus[]) => void;
  t.mock.method(api, "getRunHistory", () => new Promise<RunStatus[]>(resolve => { snapshot = resolve; }));
  t.mock.method(api, "listRunningRuns", async () => []);
  const loading = useAppStore.getState().loadRuns();
  t.mock.method(api, "archiveRunHistory", async ids => ({ id: "clear", deleted_at: new Date().toISOString(), run_ids: ids }));
  await useRunHistoryStore.getState().clear([record()]);
  useAppStore.getState().handleRunEvents([
    { type: "status", status: record() },
    { type: "output", run_id: "old", stream: "stdout", data: btoa("late") },
    { type: "resync", statuses: [record()] },
  ]);
  snapshot([record()]); await loading;
  assert.deepEqual(useAppStore.getState().runs, {});
  assert.deepEqual(useAppStore.getState().history, []);
  assert.deepEqual(useAppStore.getState().outputBuffers, {});
  assert.equal(useAppStore.getState().activeRunId, null);
});

test("new runs arriving while clear is pending survive; a failed restore remains retryable", async t => {
  setup(t);
  let finish!: () => void;
  const original = record(), fresh = { ...record("fresh"), started_at: "2026-10-23T12:00:00Z" };
  t.mock.method(api, "archiveRunHistory", ids => new Promise(resolve => { finish = () => resolve({ id: "batch", deleted_at: new Date().toISOString(), run_ids: ids }); }));
  const clearing = useRunHistoryStore.getState().clear([original]);
  await Promise.resolve();
  assert.equal(useRunHistoryStore.getState().historyBusy, true);
  useAppStore.getState().handleRunEvent({ type: "status", status: fresh });
  useAppStore.getState().setActiveRun("fresh");
  finish(); await clearing;
  assert.deepEqual(Object.keys(useAppStore.getState().runs), ["fresh"]);
  const restoration = t.mock.method(api, "restoreRunHistory", async () => { throw new Error("read-only disk"); });
  const event = useEventStore.getState().events[0];
  await useEventStore.getState().runAction(event.id);
  assert.equal(useEventStore.getState().events[0].actionError, "read-only disk");
  assert.equal(useRunHistoryStore.getState().historyBusy, false);
  restoration.mock.mockImplementation(async () => [original]);
  t.mock.method(api, "getRunHistory", async () => [fresh, original]);
  t.mock.method(api, "listRunningRuns", async () => []);
  await useEventStore.getState().runAction(event.id);
  assert.ok(useAppStore.getState().runs.old);
  assert.equal(useAppStore.getState().activeRunId, "fresh");
  assert.equal(useEventStore.getState().events.length, 0);
});

test("successful restore survives a refresh failure without leaving a stale Undo action", async t => {
  setup(t);
  t.mock.method(api, "archiveRunHistory", async ids => ({ id: "one", deleted_at: new Date().toISOString(), run_ids: ids }));
  await useRunHistoryStore.getState().remove(record());
  t.mock.method(api, "restoreRunHistory", async () => [record()]);
  t.mock.method(api, "listRunningRuns", async () => []);
  t.mock.method(api, "getRunHistory", async () => { throw new Error("refresh failed"); });
  await useEventStore.getState().runAction("history-deleted:one");
  assert.ok(useAppStore.getState().runs.old);
  assert.equal(useAppStore.getState().deletedRunIds.has("old"), false);
  assert.ok(!useEventStore.getState().events.some(e => e.id === "history-deleted:one"));
  assert.ok(useEventStore.getState().events.some(e => e.level === "error"));
});

test("persistent deleted-history events rebuild without duplicates and follow language changes", async t => {
  setup(t);
  t.after(() => { void i18n.changeLanguage("zh"); });
  t.mock.method(api, "listDeletedRunHistory", async () => [{ id: "saved", deleted_at: "2026-10-22T06:00:00Z", run_ids: ["old", "another"] }]);
  await loadDeletedRunHistoryEvents(); await loadDeletedRunHistoryEvents();
  assert.equal(useEventStore.getState().events.length, 1);
  const event = useEventStore.getState().events[0];
  assert.equal(eventText(event.action!.label), "撤销");
  await i18n.changeLanguage("en");
  assert.equal(eventText(event.title), "Removed 2 history records");
  assert.equal(eventText(event.action!.label), "Undo");
  assert.ok(!useAppStore.getState().runs.old);
});

test("deleted-history refresh removes expired events and preserves unrelated events and retry errors", async t => {
  setup(t);
  let batches = [{ id: "expired", deleted_at: "2026-10-15T06:00:00Z", run_ids: ["old"] },
    { id: "recent", deleted_at: "2026-10-22T06:00:00Z", run_ids: ["another"] }];
  t.mock.method(api, "listDeletedRunHistory", async () => batches);
  t.mock.method(api, "restoreRunHistory", async () => { throw new Error("disk unavailable"); });
  useEventStore.getState().add({ id: "other", timestamp: Date.now(), title: "Other event" });
  await loadDeletedRunHistoryEvents();
  await useEventStore.getState().runAction("history-deleted:recent");
  const recent = useEventStore.getState().events.find(event => event.id === "history-deleted:recent");
  assert.equal(recent?.actionError, "disk unavailable");
  batches = batches.filter(batch => batch.id !== "expired");
  await loadDeletedRunHistoryEvents();
  assert.deepEqual(new Set(useEventStore.getState().events.map(event => event.id)), new Set(["other", "history-deleted:recent"]));
  assert.equal(useEventStore.getState().events.find(event => event.id === "history-deleted:recent"), recent);
  assert.equal(useAppStore.getState().deletedRunIds.has("old"), true);
  assert.ok(!useAppStore.getState().runs.old);
});
