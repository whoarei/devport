import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, localWorkspace, deviceWorkspace, type DeviceProfile, type RunEvent, type RunStatus, type WorkspaceRunRequest } from "../src/api";
import { useAppStore } from "../src/store";
import { useWorkspaceRunStore, workspaceSourceCurrent } from "../src/workspaceRunStore";
import { useTerminalStore } from "../src/terminalStore";
import { commandLabel, commandsFor, inferModule, workspaceKey } from "../src/workspaceRun";
import { workspaceRunMenu } from "../src/workspaceRunMenu";
import { RunToolbar } from "../src/components/RunToolbar";
import { WorkspaceRunDialogs } from "../src/components/WorkspaceRunDialogs";
import i18n from "../src/i18n";

const device = (id: string): DeviceProfile => ({ id, revision: `rev-${id}`, name: id, transport: "ssh", host: "example", port: 22, username: "user", auth: { type: "key", key_path: null }, workspace_root: "/tmp/runs", is_default: id === "a" });
const workspace = localWorkspace("/project");
const command = { entry: { type: "python_script" as const, path: "tools/test.py" }, args: ["", "a b", "汉字", "$(touch x)", "C:\\a b", '"quote"'] };
function setup(t: test.TestContext) {
  const app = useAppStore.getState(), feature = useWorkspaceRunStore.getState(), terminal = useTerminalStore.getState();
  t.after(() => { useAppStore.setState(app, true); useWorkspaceRunStore.setState(feature, true); useTerminalStore.setState(terminal, true); });
  t.mock.method(console, "warn", () => {});
  t.mock.method(api, "getWorkspaceRun", async () => null);
  t.mock.method(api, "getRunStatus", async () => ({ run_id: "id", label: "test", device_name: "b", state: "preparing", exit_code: null, error: null, started_at: "", ended_at: null }));
  useAppStore.setState({ workspace, devices: [device("a"), device("b")], selectedDeviceId: "a", loading: false, saving: false, starting: false, guarding: false, updating: false, workspaceMutating: false, openTabs: [], runs: {}, outputBuffers: {}, runProgress: {}, history: [], activeRunId: null, saveAllDirty: async () => true });
  useWorkspaceRunStore.setState({ key: workspaceKey(workspace), sourceRevision: null, config: { config: { schema: 1, run_defaults: { cwd: "." } }, revision: "missing" }, configError: null, launchError: null, preferences: { python: {}, bash: {}, console_mode: "pty", timeout_secs: 0, env: {} }, info: null, sessions: {}, preparation: null, settingsOpen: false });
}

function preparationStatus(state = "preparing", id = "id"): RunStatus {
  return { run_id: id, device_name: "a", label: "Prepare environment", state, phase: "syncing_dependencies", exit_code: state === "exited" ? 0 : null, error: null, started_at: "", ended_at: state === "preparing" ? null : "done" };
}
function receive(events: RunEvent[]) {
  useAppStore.getState().handleRunEvents(events);
  useWorkspaceRunStore.getState().events(events);
}

test.before(async () => { await i18n.changeLanguage("zh"); });
test("module inference requires an unambiguous import root and valid identifiers", () => {
  assert.equal(inferModule("src/app/cli.py", false, ".", ["src"]), null);
  assert.equal(inferModule("src/app/cli.py", false, "src", ["src"]), "app.cli");
  assert.equal(inferModule("src/app/__main__.py", false, "other", ["src"]), "app");
  assert.equal(inferModule("src/bad-name", true, ".", []), null);
  assert.notEqual(workspaceKey(deviceWorkspace("a", "/p")), workspaceKey(deviceWorkspace("b", "/p")));
});

test("history is scoped by script or module source without changing its executable content", () => {
  const records = [{ ...command, id: "script", last_used_at: "" }, { entry: { type: "python_module" as const, name: "app.cli" }, args: ["--help"], id: "module", sources: [{ type: "file" as const, path: "tools/test.py" }, { type: "dir" as const, path: "app" }], last_used_at: "" }];
  assert.equal(commandsFor(records, { type: "file", path: "tools/test.py" }).length, 2);
  assert.deepEqual(commandsFor(records, { type: "dir", path: "app" }).map((r) => r.id), ["module"]);
  assert.equal(commandLabel(records[1]), "python -m app.cli");
});

test("launch captures target, environment and all settings together after saving, preserving literal argv", async (t) => {
  setup(t);
  let saved!: () => void;
  useAppStore.setState({ saveAllDirty: () => new Promise<boolean>((resolve) => { saved = () => resolve(true); }) });
  let request!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async (r) => { request = r; return "id"; });
  const task = useWorkspaceRunStore.getState().start(command);
  useAppStore.setState({ selectedDeviceId: "b" });
  useWorkspaceRunStore.setState({ preferences: { python: { b: "project" }, bash: {}, console_mode: "pipe", timeout_secs: 12, env: { X: "v" } }, config: { config: { schema: 1, run_defaults: { cwd: "tools" } }, revision: "v2" } });
  saved(); await task;
  assert.equal(request.device_id, "b"); assert.equal(request.device_revision, "rev-b"); assert.equal(request.python, "project");
  assert.deepEqual(request.settings, { cwd: "tools", env: { X: "v" }, console_mode: "pipe", timeout_secs: 12, cols: 80, rows: 24, bash: undefined });
  assert.deepEqual(request.command.args, command.args);
  command.args.push("later"); assert.notDeepEqual(request.command.args, command.args); command.args.pop();
});

test("workspace replacement during save aborts without submitting an old entry in the new workspace", async (t) => {
  setup(t);
  let saved!: () => void, invoked = 0;
  useAppStore.setState({ saveAllDirty: () => new Promise<boolean>((resolve) => { saved = () => resolve(true); }) });
  t.mock.method(api, "runWorkspace", async () => { invoked++; return "id"; });
  const task = useWorkspaceRunStore.getState().start(command);
  useAppStore.setState({ workspace: localWorkspace("/other") }); saved();
  await assert.rejects(task, /工作区/); assert.equal(invoked, 0);
});

test("history execution submits only entry and args, excluding all index metadata", async (t) => {
  setup(t);let submitted!:WorkspaceRunRequest;
  t.mock.method(api,"runWorkspace",async (request)=>{submitted=request;return "id";});
  await useWorkspaceRunStore.getState().start({...command,id:"hash",sources:[{type:"file",path:"old.py"}],last_used_at:"date",needs_edit:false} as typeof command);
  assert.deepEqual(Object.keys(submitted.command).sort(),["args","entry"]);
  assert.deepEqual(submitted.command,command);
});

test("same-device project Python is selectable and old records without snapshots cannot guess rerun settings", (t) => {
  setup(t); t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const remote = deviceWorkspace("a", "/project");
  useAppStore.setState({ workspace: remote, activeRunId: "id", runs: { id: { run_id: "id", device_name: "a", label: "tools/test.py", state: "exited", exit_code: 0, error: null, started_at: "", ended_at: "" } } });
  useWorkspaceRunStore.setState({ sessions: { id: { request: { workspace, device_id: "a", device_revision: "rev-a", command, python: "project", settings: { cwd: ".", env: {}, console_mode: "pty", timeout_secs: 0, cols: 80, rows: 24 } }, launch: null, warning: null } } });
  const html = renderToStaticMarkup(createElement(RunToolbar));
  assert.match(html, /option value="project"/); assert.doesNotMatch(html, /option value="project" disabled/);
  assert.match(html, /disabled="" title="这条旧记录没有保存运行配置/);
});

test("right-click run starts with empty arguments and never follows the active editor tab", async (t) => {
  setup(t); useAppStore.setState({ activeFile: "unrelated.py" });
  let executed: unknown;
  useWorkspaceRunStore.setState({ run: (value) => { executed = value; } });
  const menu = await workspaceRunMenu(workspace, "tools/test.py", false);
  const run = menu[0];
  assert.ok(run && run !== "separator"); run.onSelect?.();
  assert.deepEqual(executed, { entry: { type: "python_script", path: "tools/test.py" }, args: [] });
});

test("late Python checks from an old target cannot replace the current configuration", async (t) => {
  setup(t);
  let resolveOld!: (v: unknown) => void;
  const info = { python_version: "3.12.9", python_path: [], project: null, legacy_entry: null, legacy_module: false };
  t.mock.method(api, "inspectWorkspacePython", () => new Promise((resolve) => { resolveOld = resolve; }));
  const first = useWorkspaceRunStore.getState().check(); const old = resolveOld;
  useAppStore.setState({ selectedDeviceId: "b" }); const second = useWorkspaceRunStore.getState().check();
  resolveOld({ ...info, python_version: "3.13.0" }); await second; old(info); await first;
  assert.equal(useWorkspaceRunStore.getState().info?.python_version, "3.13.0");
});

test("minor Python declarations recognize cached patch environments without matching another minor line", async (t) => {
  setup(t);
  const project = { name: "example", requires_python: ">=3.12", python_version: "3.12", lock_sha256: "lock", entry: "main.py", mode: "script" as const, python_path: [], groups: [], extras: [], package_source_identity: "source" };
  let actual = "3.12.9";
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: project.python_version, python_path: [], project, legacy_entry: null, legacy_module: false }));
  t.mock.method(api, "listProjectEnvironments", async () => [{ id: "env", path: "/runtime/envs/env", ready: true, leased: false,
    manifest: { schema: 1, environment_id: "env", uv_version: "0.12.13", python_request: "3.12", python_executable: "/runtime/envs/env/bin/python", python_version: actual, python_build: "build", platform: "linux-x86_64-gnu", libc: "gnu", lock_sha256: "lock", groups: [], extras: [], created_at: "", last_used_at: "" } }]);
  await useWorkspaceRunStore.getState().check();
  assert.equal(useWorkspaceRunStore.getState().cached, true);
  actual = "3.13.0";
  await useWorkspaceRunStore.getState().check();
  assert.equal(useWorkspaceRunStore.getState().cached, false);
  actual = "3.120.9";
  await useWorkspaceRunStore.getState().check();
  assert.equal(useWorkspaceRunStore.getState().cached, false);
  actual = "3.12.10"; project.python_version = "3.12.9";
  await useWorkspaceRunStore.getState().check();
  assert.equal(useWorkspaceRunStore.getState().cached, false);
});

test("settings restore per-workspace target and per-target Python selection with defensive defaults", async (t) => {
  setup(t);
  const previous=Object.getOwnPropertyDescriptor(globalThis,"localStorage"), data=new Map<string,string>();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,"localStorage",previous);else Reflect.deleteProperty(globalThis,"localStorage");});
  t.mock.method(api,"readRunnerConfig",async()=>({config:{schema:1,run_defaults:{cwd:"."}},revision:"missing"}));
  t.mock.method(api,"listWorkspaceCommands",async()=>({entries:[],revision:"missing"}));
  t.mock.method(api,"inspectWorkspacePython",async()=>({python_version:null,python_path:[],project:null,legacy_entry:null,legacy_module:false}));
  const remote=deviceWorkspace("b","/project");useAppStore.setState({workspace:remote});
  await useWorkspaceRunStore.getState().load();assert.equal(useAppStore.getState().selectedDeviceId,"b");
  useWorkspaceRunStore.getState().selectPython("project");
  useWorkspaceRunStore.getState().selectTarget("a");
  await useWorkspaceRunStore.getState().load();
  assert.equal(useAppStore.getState().selectedDeviceId,"a");assert.equal(useWorkspaceRunStore.getState().preferences.python.b,"project");
  assert.equal(useWorkspaceRunStore.getState().preferences.python.a,undefined);
  data.set(`runner.settings.v1:${workspaceKey(remote)}`,JSON.stringify({python:[],bash:42,env:{bad:4},timeout_secs:-5}));
  await useWorkspaceRunStore.getState().load();assert.deepEqual(useWorkspaceRunStore.getState().preferences.env,{});assert.equal(useWorkspaceRunStore.getState().preferences.timeout_secs,0);
  await Promise.resolve();
});

test("right-click submission failures reveal the run console without an open editor", async (t) => {
  setup(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const layout = useAppStore.getState().layout;
  useAppStore.setState({ layout: { ...layout, panelVisible: { ...layout.panelVisible, console: false, editor: false }, panelCollapsed: { ...layout.panelCollapsed, console: true } } });
  t.mock.method(api, "runWorkspace", async () => { throw new Error("BOUNDARY_REJECTED"); });
  useWorkspaceRunStore.getState().run(command);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useAppStore.getState().openTabs.length, 0);
  assert.equal(useAppStore.getState().layout.panelVisible.editor, false);
  assert.equal(useAppStore.getState().layout.panelVisible.console, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.console, false);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.match(renderToStaticMarkup(createElement(RunToolbar)), /role="alert"[^>]*><span>BOUNDARY_REJECTED/);
  t.mock.method(api, "runWorkspace", async () => "id");
  await useWorkspaceRunStore.getState().start(command);
  assert.equal(useWorkspaceRunStore.getState().launchError, null);
});

test("preparation stays in settings and preserves the current task, console tab and layout", async (t) => {
  setup(t);
  const layout = useAppStore.getState().layout;
  const hidden = { ...layout, panelVisible: { ...layout.panelVisible, console: false }, panelCollapsed: { ...layout.panelCollapsed, console: true } };
  useAppStore.setState({ layout: hidden, activeRunId: "previous" });
  useTerminalStore.setState({ activeTab: "terminal-original" });
  let request!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async (r) => { request = r; return "id"; });
  await useWorkspaceRunStore.getState().prepare(true);
  assert.equal(request.operation, "rebuild");
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, true);
  assert.equal(useWorkspaceRunStore.getState().preparation?.runId, "id");
  assert.equal(useAppStore.getState().activeRunId, "previous");
  assert.equal(useTerminalStore.getState().activeTab, "terminal-original");
  assert.equal(useAppStore.getState().layout, hidden);
});

test("submission failures stay inline and a second click cannot submit duplicate preparation", async (t) => {
  setup(t); t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const layout = useAppStore.getState().layout;
  let reject!: (error: Error) => void, calls = 0;
  t.mock.method(api, "runWorkspace", () => { calls++; return new Promise((_resolve, failed) => { reject = failed; }); });
  const pending = useWorkspaceRunStore.getState().prepare();
  await new Promise((resolve) => setImmediate(resolve));
  await useWorkspaceRunStore.getState().prepare(true);
  assert.equal(calls, 1);
  reject(new Error("PREPARATION_REJECTED")); await pending;
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, true);
  assert.equal(useWorkspaceRunStore.getState().preparation?.error, "PREPARATION_REJECTED");
  assert.equal(useWorkspaceRunStore.getState().launchError, null);
  assert.equal(useAppStore.getState().layout, layout);
  assert.match(renderToStaticMarkup(createElement(WorkspaceRunDialogs)), /role="alert">PREPARATION_REJECTED/);
});

test("a preparation that completes before invoke returns is retained and refreshes the environment once", async (t) => {
  setup(t);
  let checked = 0;
  t.mock.method(useWorkspaceRunStore.getState(), "check", async () => { checked++; });
  t.mock.method(api, "runWorkspace", async () => { receive([{ type: "status", status: preparationStatus("exited") }]); return "id"; });
  await useWorkspaceRunStore.getState().prepare();
  assert.equal(useWorkspaceRunStore.getState().preparation?.status?.state, "exited");
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, true);
  assert.equal(checked, 1);
  receive([{ type: "status", status: preparationStatus("exited") }]);
  assert.equal(checked, 1);
});

test("closing settings preserves progress, UTF-8 logs and failures for reopening", async (t) => {
  setup(t); t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  t.mock.method(useWorkspaceRunStore.getState(), "check", async () => {});
  t.mock.method(api, "runWorkspace", async () => "id");
  await useWorkspaceRunStore.getState().prepare();
  useWorkspaceRunStore.setState({ settingsOpen: false });
  const bytes = Buffer.from("\u001b[32m安装汉字依赖\u001b[0m\n");
  receive([{ type: "runtime_progress", run_id: "id", phase: "syncing_dependencies", message: "Resolving packages", downloaded_bytes: 0, total_bytes: null },
    { type: "output", run_id: "id", stream: "stdout", data: bytes.subarray(0, 7).toString("base64") },
    { type: "output", run_id: "id", stream: "stdout", data: bytes.subarray(7).toString("base64") }]);
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, false);
  useWorkspaceRunStore.setState({ settingsOpen: true });
  let html = renderToStaticMarkup(createElement(WorkspaceRunDialogs));
  assert.match(html, /安装汉字依赖/); assert.match(html, /Resolving packages/); assert.doesNotMatch(html, /\u001b/);
  receive([{ type: "status", status: { ...preparationStatus("failed"), error: "Dependency installation failed" } }]);
  html = renderToStaticMarkup(createElement(WorkspaceRunDialogs));
  assert.match(html, /role="alert">Dependency installation failed/);
  assert.match(html, /失败 · 同步依赖/);
  assert.match(html, /安装汉字依赖/);
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, true);
});

test("cancel uses the preparation task and a late cancel error cannot overwrite a retry", async (t) => {
  setup(t);
  t.mock.method(useWorkspaceRunStore.getState(), "check", async () => {});
  let id = "first", stopped = "", reject!: (error: Error) => void;
  t.mock.method(api, "runWorkspace", async () => id);
  t.mock.method(api, "getRunStatus", async (runId) => preparationStatus("preparing", runId));
  t.mock.method(api, "stopRun", (runId) => { stopped = runId; return new Promise((_resolve, failed) => { reject = failed; }); });
  await useWorkspaceRunStore.getState().prepare();
  useAppStore.setState({ activeRunId: "unrelated" });
  const stopping = useWorkspaceRunStore.getState().cancelPreparation();
  assert.equal(stopped, "first"); assert.equal(useWorkspaceRunStore.getState().preparation?.stopping, true);
  receive([{ type: "status", status: preparationStatus("canceled", "first") }]);
  assert.equal(useWorkspaceRunStore.getState().preparation?.status?.state, "canceled");
  id = "second"; await useWorkspaceRunStore.getState().prepare(true);
  reject(new Error("stale cancel failure")); await stopping;
  assert.equal(useWorkspaceRunStore.getState().preparation?.runId, "second");
  assert.equal(useWorkspaceRunStore.getState().preparation?.error, null);
  assert.equal(useAppStore.getState().activeRunId, "unrelated");
});

test("completion for an old target or source does not refresh the newly selected environment", async (t) => {
  setup(t);
  let checked = 0;
  t.mock.method(useWorkspaceRunStore.getState(), "check", async () => { checked++; });
  t.mock.method(api, "runWorkspace", async () => "id");
  await useWorkspaceRunStore.getState().prepare();
  useAppStore.setState({ workspace: localWorkspace("/other"), selectedDeviceId: "b" });
  receive([{ type: "status", status: preparationStatus("exited") }]);
  assert.equal(checked, 0);
  assert.equal(useWorkspaceRunStore.getState().preparation?.deviceId, "a");
  assert.deepEqual(useWorkspaceRunStore.getState().preparation?.workspace, workspace);
});

test("replacing a source connection while saving aborts preparation even if settings have already reloaded", async (t) => {
  setup(t);
  const remote = deviceWorkspace("a", "/project");
  let saved!: () => void, submitted = 0;
  useAppStore.setState({ workspace: remote, saveAllDirty: () => new Promise((resolve) => { saved = () => resolve(true); }) });
  useWorkspaceRunStore.setState({ key: workspaceKey(remote), sourceRevision: "rev-a" });
  t.mock.method(api, "runWorkspace", async () => { submitted++; return "id"; });
  const pending = useWorkspaceRunStore.getState().prepare();
  useAppStore.setState({ devices: [{ ...device("a"), revision: "new-host" }, device("b")] });
  useWorkspaceRunStore.setState({ sourceRevision: "new-host" });
  saved(); await pending;
  assert.equal(submitted, 0);
  assert.match(useWorkspaceRunStore.getState().preparation?.error ?? "", /工作区/);
  assert.equal(useWorkspaceRunStore.getState().settingsOpen, true);
});

test("explicit config refresh recovers external revisions and the next run uses the new cwd", async (t) => {
  setup(t);
  t.mock.method(api, "readRunnerConfig", async () => ({ config: { schema: 1, run_defaults: { cwd: "data" } }, revision: "external-revision" }));
  assert.equal(await useWorkspaceRunStore.getState().refreshConfig(), true);
  let submitted!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async (request) => { submitted = request; return "id"; });
  await useWorkspaceRunStore.getState().start(command);
  assert.equal(submitted.config_revision, "external-revision");
  assert.equal(submitted.settings.cwd, "data");
});

test("a stale config refresh cannot replace a new workspace or a newly saved setting", async (t) => {
  setup(t);
  let resolve!: (state: Awaited<ReturnType<typeof api.readRunnerConfig>>) => void;
  t.mock.method(api, "readRunnerConfig", () => new Promise((done) => { resolve = done; }));
  for (const switchWorkspace of [true, false]) {
    const previous = useWorkspaceRunStore.getState().config;
    const pending = useWorkspaceRunStore.getState().refreshConfig();
    if (switchWorkspace) useAppStore.setState({ workspace: localWorkspace("/other") });
    else useWorkspaceRunStore.setState({ config: { config: { schema: 1, run_defaults: { cwd: "saved" } }, revision: "saved" } });
    resolve({ config: { schema: 1, run_defaults: { cwd: "stale" } }, revision: "stale" });
    assert.equal(await pending, false);
    if (switchWorkspace) assert.equal(useWorkspaceRunStore.getState().config, previous);
    else assert.equal(useWorkspaceRunStore.getState().config?.revision, "saved");
    assert.notEqual(useWorkspaceRunStore.getState().config?.revision, "stale");
    useAppStore.setState({ workspace });
  }
});

test("initial config loads independently of slow history and cannot overwrite a subsequent save", async (t) => {
  setup(t);
  let historyDone!: (value: Awaited<ReturnType<typeof api.listWorkspaceCommands>>) => void;
  t.mock.method(api, "readRunnerConfig", async () => ({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "old" }));
  t.mock.method(api, "listWorkspaceCommands", () => new Promise((resolve) => { historyDone = resolve; }));
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: null, python_path: [], project: null, legacy_entry: null, legacy_module: false }));
  const loading = useWorkspaceRunStore.getState().load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useWorkspaceRunStore.getState().config?.revision, "old");
  useWorkspaceRunStore.setState({ config: { config: { schema: 1, run_defaults: { cwd: "saved" } }, revision: "saved" } });
  historyDone({ entries: [], revision: "missing" }); await loading;
  let submitted!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async (request) => { submitted = request; return "id"; });
  await useWorkspaceRunStore.getState().start(command);
  assert.equal(submitted.config_revision, "saved"); assert.equal(submitted.settings.cwd, "saved");
});

test("late initial config success or failure cannot replace a saved config", async (t) => {
  setup(t);
  let finish!: (reject: boolean) => void;
  t.mock.method(api, "readRunnerConfig", () => new Promise((resolve, reject) => {
    finish = (failed) => failed ? reject(new Error("stale error")) : resolve({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "stale" });
  }));
  t.mock.method(api, "listWorkspaceCommands", async () => ({ entries: [], revision: "missing" }));
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: null, python_path: [], project: null, legacy_entry: null, legacy_module: false }));
  for (const failed of [false, true]) {
    const loading = useWorkspaceRunStore.getState().load();
    const saved = { config: { schema: 1 as const, run_defaults: { cwd: "saved" } }, revision: "saved" };
    useWorkspaceRunStore.setState({ config: saved, configError: null });
    finish(failed); await loading;
    assert.equal(useWorkspaceRunStore.getState().config, saved);
    assert.equal(useWorkspaceRunStore.getState().configError, null);
  }
});

test("changing the source connection reloads config and history even when the workspace ID and path stay unchanged", async (t) => {
  setup(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const effects: { run: React.EffectCallback; deps: React.DependencyList }[] = [];
  t.mock.method(React, "useEffect", (run, deps) => { effects.push({ run, deps: deps ?? [] }); });
  const remote = deviceWorkspace("a", "/project");
  useAppStore.setState({ workspace: remote });
  let host = "old-host", reads = 0;
  t.mock.method(api, "readRunnerConfig", async () => { reads++; return { config: { schema: 1, run_defaults: { cwd: host } }, revision: host }; });
  t.mock.method(api, "listWorkspaceCommands", async () => ({ entries: [], revision: host }));
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: host, python_path: [], project: null, legacy_entry: null, legacy_module: false }));
  let previous: React.DependencyList[] = [];
  const renderAndFlush = async () => {
    effects.length = 0;
    renderToStaticMarkup(createElement(WorkspaceRunDialogs));
    // Run the three parent effects with their actual dependency arrays.
    effects.slice(0, 3).forEach((effect, index) => {
      if (!previous[index] || effect.deps.some((value, i) => !Object.is(value, previous[index][i]))) effect.run();
      previous[index] = effect.deps;
    });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await renderAndFlush();
  assert.equal(useWorkspaceRunStore.getState().config?.revision, "old-host");
  useWorkspaceRunStore.getState().selectTarget("b");
  host = "new-host";
  useAppStore.setState({ devices: [{ ...device("a"), revision: "new-source-revision", host }, device("b")] });
  await renderAndFlush();
  assert.equal(reads, 2);
  assert.equal(useWorkspaceRunStore.getState().config?.revision, host);
  assert.equal(useWorkspaceRunStore.getState().commands?.revision, host);
  assert.equal(useWorkspaceRunStore.getState().sourceRevision, "new-source-revision");
  assert.equal(useAppStore.getState().selectedDeviceId, "b");
  let submitted!: WorkspaceRunRequest;
  t.mock.method(api, "runWorkspace", async (request) => { submitted = request; return "id"; });
  await useWorkspaceRunStore.getState().start(command);
  assert.equal(submitted.settings.cwd, host); assert.equal(submitted.config_revision, host);
  assert.equal(submitted.device_id, "b");
});

test("late source responses are rejected before the reload effect runs, even when the target revision is unchanged", async (t) => {
  setup(t);
  const remote = deviceWorkspace("a", "/project");
  useAppStore.setState({ workspace: remote });
  const info = { python_version: null, python_path: [], project: null, legacy_entry: null, legacy_module: false };
  t.mock.method(api, "readRunnerConfig", async () => ({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "original" }));
  t.mock.method(api, "listWorkspaceCommands", async () => ({ entries: [], revision: "original" }));
  t.mock.method(api, "inspectWorkspacePython", async () => info);
  await useWorkspaceRunStore.getState().load();
  await new Promise((resolve) => setImmediate(resolve));
  useAppStore.setState({ selectedDeviceId: "b" });
  let configDone!: (value: Awaited<ReturnType<typeof api.readRunnerConfig>>) => void;
  let historyDone!: (value: Awaited<ReturnType<typeof api.listWorkspaceCommands>>) => void;
  let inspectFailed!: (error: Error) => void;
  t.mock.method(api, "readRunnerConfig", () => new Promise((done) => { configDone = done; }));
  t.mock.method(api, "listWorkspaceCommands", () => new Promise((done) => { historyDone = done; }));
  t.mock.method(api, "inspectWorkspacePython", () => new Promise((_done, failed) => { inspectFailed = failed; }));
  const original = useWorkspaceRunStore.getState().config;
  const pending = [useWorkspaceRunStore.getState().refreshConfig(), useWorkspaceRunStore.getState().refreshCommands(), useWorkspaceRunStore.getState().check()];
  useAppStore.setState({ devices: [{ ...device("a"), revision: "changed-source", host: "new-host" }, device("b")] });
  configDone({ config: { schema: 1, run_defaults: { cwd: "stale-response" } }, revision: "stale-response" });
  historyDone({ entries: [], revision: "stale-response" }); inspectFailed(new Error("old-source-error"));
  await Promise.all(pending);
  assert.equal(useWorkspaceRunStore.getState().config, original);
  assert.equal(useWorkspaceRunStore.getState().commands?.revision, "original");
  assert.equal(useWorkspaceRunStore.getState().infoError, null);
  assert.equal(workspaceSourceCurrent(remote, "rev-a"), false);
  let invoked = false;
  t.mock.method(api, "runWorkspace", async () => { invoked = true; return "id"; });
  await assert.rejects(useWorkspaceRunStore.getState().start(command), /工作区/);
  assert.equal(invoked, false);
});

test("a menu captured from an old source connection cannot execute after that connection is replaced", async (t) => {
  setup(t);
  const remote = deviceWorkspace("a", "/project");
  useAppStore.setState({ workspace: remote });
  t.mock.method(api, "readRunnerConfig", async () => ({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "missing" }));
  t.mock.method(api, "listWorkspaceCommands", async () => ({ entries: [], revision: "missing" }));
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: null, python_path: [], project: null, legacy_entry: null, legacy_module: false }));
  await useWorkspaceRunStore.getState().load();
  let invoked = false;
  useWorkspaceRunStore.setState({ run: () => { invoked = true; } });
  const old = (await workspaceRunMenu(remote, "tools/test.py", false))[0];
  assert.ok(old && old !== "separator");
  useAppStore.setState({ devices: [{ ...device("a"), revision: "new-source", host: "new-host" }, device("b")] });
  await useWorkspaceRunStore.getState().load();
  old.onSelect?.();
  assert.equal(invoked, false);
  const current = (await workspaceRunMenu(remote, "tools/test.py", false))[0];
  assert.ok(current && current !== "separator"); current.onSelect?.();
  assert.equal(invoked, true);
});

test("a device workspace still defaults to its source when devices arrive after the first load", async (t) => {
  setup(t);
  const remote = deviceWorkspace("b", "/project");
  useAppStore.setState({ workspace: remote, devices: [], selectedDeviceId: null });
  t.mock.method(api, "readRunnerConfig", async () => ({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "missing" }));
  t.mock.method(api, "listWorkspaceCommands", async () => ({ entries: [], revision: "missing" }));
  t.mock.method(api, "inspectWorkspacePython", async () => ({ python_version: null, python_path: [], project: null, legacy_entry: null, legacy_module: false }));
  await useWorkspaceRunStore.getState().load();
  assert.equal(useWorkspaceRunStore.getState().sourceRevision, "missing");
  useAppStore.setState({ devices: [device("a"), device("b")], selectedDeviceId: "a" });
  await useWorkspaceRunStore.getState().load();
  assert.equal(useAppStore.getState().selectedDeviceId, "b");
});

test("a queued workspace run remains active and exposes a cancellable waiting status", (t) => {
  setup(t);
  t.mock.method(React, "useSyncExternalStore", (_subscribe, snapshot) => snapshot());
  const waiting = { ...preparationStatus(), phase: undefined, waiting_workspace: true };
  useAppStore.getState().handleRunEvents([{ type: "status", status: waiting }]);
  useAppStore.setState({ activeRunId: waiting.run_id });
  const html = renderToStaticMarkup(createElement(RunToolbar));
  assert.ok(html.includes(i18n.t("workspaceSync.waiting")));
  const stopButton = html.match(/<button class="danger"([^>]*)>[^<]+<\/button>/);
  assert.ok(stopButton, "waiting tasks retain the stop action");
  assert.doesNotMatch(stopButton[1], /disabled/);
  assert.ok(stopButton[0].includes(i18n.t("run.stop")));
  assert.equal(useAppStore.getState().history.length, 0);
});

test("sync reports survive terminal status, history and event snapshot recovery", (t) => {
  setup(t);
  const report = { destination: "/home/user/work/workspace", added: 0, updated: 0, deleted: 0, skipped: 42, permissions: 0, uploaded_bytes: 0 };
  const status = { ...preparationStatus("running"), phase: undefined, waiting_workspace: false, workspace_sync: report };
  useAppStore.getState().handleRunEvents([{ type: "status", status }]);
  const finished = { ...status, state: "exited", exit_code: 0, ended_at: "done" };
  useAppStore.getState().handleRunEvents([{ type: "status", status: finished }]);
  assert.deepEqual(useAppStore.getState().history[0].workspace_sync, report);
  useAppStore.getState().handleRunEvents([{ type: "resync", statuses: [finished] }]);
  assert.deepEqual(useAppStore.getState().runs.id.workspace_sync, report);
  assert.equal(useAppStore.getState().history[0].workspace_sync?.uploaded_bytes, 0);
});
