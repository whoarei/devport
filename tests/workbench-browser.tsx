/// <reference types="vite/client" />
// Full workbench visual fixture. All APIs are in-memory; no devices are contacted.
// ?theme=light|dark&lang=zh|en&empty=1&transfer=1&local=1&error=1&width=900&many=1&collision=1&running=1&commands=1&deviceWorkspace=1&longNames=1&inlineTransfers=1&rowActions=1
import React from "react";
import { createRoot } from "react-dom/client";
import { api, type DeviceProfile, type WorkspaceRef } from "../src/api";
import { useAppStore } from "../src/store";
import { useTerminalStore } from "../src/terminalStore";
import { useTransferStore } from "../src/transferStore";
import { useWorkspaceRunStore } from "../src/workspaceRunStore";
import { transferApi, type TransferPlan, type TransferSummary } from "../src/transferApi";
import { rootTree } from "../src/workspaceTree";
import { DEFAULT_LAYOUT } from "../src/layoutState";
import { initializeTheme, useThemeStore } from "../src/theme";
import { TitleBar } from "../src/components/TitleBar";
import { WorkspacePanel } from "../src/components/WorkspacePanel";
import { WorkspaceTransferDialogs } from "../src/components/WorkspaceTransferDialogs";
import { DeviceWorkspacePanel } from "../src/components/DeviceWorkspacePanel";
import { type PanelId } from "../src/panels/registry";
import { CommandsPanel } from "../src/components/CommandsPanel";
import { CenterDock } from "../src/components/CenterDock";
import { DeviceManager } from "../src/components/DeviceManager";
import { WorkspaceRunDialogs } from "../src/components/WorkspaceRunDialogs";
import { UnsavedDialog } from "../src/components/UnsavedDialog";
import i18n from "../src/i18n";
import { applyUiZoom } from "../src/uiZoom";
import "../src/styles.css";
import "../src/theme.css";

const params = new URLSearchParams(location.search);
await applyUiZoom(Number(params.get("zoom")) || 100);
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
initializeTheme();
useThemeStore.getState().setPreference(params.get("theme") === "dark" ? "dark" : "light");
const empty = params.has("empty"), transfer = params.has("transfer");
const base: DeviceProfile = { id: "ubuntu", name: "wsl-dev@Ubuntu-24.04", transport: "wsl", is_default: true,
  host: "", port: 22, username: "", auth: { type: "key", key_path: null }, workspace_root: "/home/dev/projects", wsl: { distribution: "Ubuntu-24.04", user: "dev" } };
const devices: DeviceProfile[] = [base, { ...base, id: "local", name: "PowerShell", transport: "local", is_default: false, local: { shell: "pwsh", no_profile: false } },
  { ...base, id: "ssh", name: "开发服务器", transport: "ssh", is_default: false, host: "192.168.1.100", username: "dev" }];
if (params.has("collision")) devices.push({ ...base, id: "ubuntu-root", name: "wsl-root@Ubuntu-24.04", is_default: false, wsl: { distribution: "Ubuntu-24.04", user: "root" } });
if (params.has("longNames")) devices.find((device) => device.id === "ssh")!.name = "生产环境数据采集与长期分析开发服务器";
const workspace: WorkspaceRef = params.has("local") ? { type: "local", dir: "C:\\projects\\workspace-source" }
  : { type: "device", device_id: "ubuntu", path: "/home/dev/projects/remote-runner-demo" };
const source = '# 数据采集与远程运行\nfrom pathlib import Path\nimport json\n\ndef collect_samples(count: int = 10):\n    """Collect device measurements and write a report."""\n    samples = []\n    for index in range(count):\n        value = 23.5 + index * 0.1\n        samples.append({"index": index, "value": value})\n        print(f"[{index + 1:02d}/{count}] temperature: {value:.1f} °C")\n    return samples\n\nif __name__ == "__main__":\n    report = collect_samples()\n    Path("output").mkdir(exist_ok=True)\n    Path("output/report.json").write_text(json.dumps(report, indent=2))\n    print("Report saved to output/report.json")\n';
api.listDevices = async () => devices;
api.listDeletedDevices = async () => [];
api.listLocalShells = async () => [{ id: "pwsh", label: "PowerShell", path: "C:/Program Files/PowerShell/7/pwsh.exe" }];
api.listWslDistributions = async () => ["Ubuntu-24.04"];
api.listSerialPorts = async () => [];
api.readWorkspaceFile = async () => ({ content: source, revision: "demo", eol: "lf", bom: false });
const editorDocuments = new Map<string, { content: string; revision: string; eol: "lf"; bom: boolean }>();
api.readDeviceEditorFile = async (workspace, name) => {
  const key = JSON.stringify([workspace, name]);
  const document = editorDocuments.get(key) ?? { content: `# Device file: ${name}\n${source}`, revision: "device-demo", eol: "lf" as const, bom: false };
  editorDocuments.set(key, document);
  return document;
};
api.writeDeviceEditorFile = async (request) => {
  const key = JSON.stringify([request.workspace, request.name]);
  const before = editorDocuments.get(key);
  if (before && before.revision !== request.expectedRevision) throw { code: "conflict", message: "文件已被修改" };
  const revision = `${before?.revision ?? "demo"}-saved`;
  editorDocuments.set(key, { content: request.content, revision, eol: "lf", bom: false });
  return { revision };
};
api.writeWorkspaceFile = async () => ({ revision: "local-saved" });
api.listWorkspaceDir = async () => [];
api.resizeRunConsole = async () => {};
api.resizeTerminal = async () => {};
api.sendTerminalInput = async () => {};
api.closeTerminal = async () => {};
api.readRunnerConfig = async () => ({ config: { schema: 1, run_defaults: { cwd: "." } }, revision: "demo" });
api.listWorkspaceCommands = async () => ({ entries: [], revision: "demo" });
api.inspectWorkspacePython = async () => ({ python_version: "3.12.9", python_path: [], project: null, legacy_entry: null, legacy_module: false });
api.getWorkspaceRun = async () => null;
const sent = new Set<string>();
api.readTerminal = async id => {
  await new Promise(resolve => setTimeout(resolve, 200));
  const data = sent.has(id) ? "" : btoa("\x1b[36mdev@ubuntu\x1b[0m \x1b[34m~/projects/remote-runner-demo\x1b[0m\r\n$ python --version\r\nPython 3.12.9\r\n$ ");
  sent.add(id);
  return { status: { session_id: id, device_name: base.name, state: "connected", exit_code: null, error: null }, data };
};
api.openTerminal = async () => ({ session_id: crypto.randomUUID(), device_name: base.name, state: "connected", exit_code: null, error: null });
transferApi.list = async endpoint => {
  if (params.has("deviceWorkspace") && endpoint.type === "device") return transferApi.listWithin(endpoint, "");
  if (params.has("error") && endpoint.type === "device") throw new Error("目录不存在，请检查路径或重新选择目录。");
  return { endpoint, overwrite: true, entries: [
    { name: "output", kind: "dir" as const, size: 0, mode: null, identity: "dir", modified: "0" },
    ...["main.py", "pyproject.toml", "README.md", "report.json"].map((name, i) => ({ name, kind: "file" as const, size: 1200 + i * 400, mode: null, identity: name, modified: "0" })),
  ] };
};
const deviceFiles = new Map<string, Map<string, "file" | "dir">>();
for (const path of ["/", "/home", "/home/dev", "/home/dev/projects", "/home/dev/projects/remote-runner-demo", "/home/dev/projects/data", "/home/dev/projects/另一个项目"]) {
  deviceFiles.set(path, new Map());
  if (path !== "/") deviceFiles.get(path.slice(0, path.lastIndexOf("/")) || "/")?.set(path.slice(path.lastIndexOf("/") + 1), "dir");
}
for (const name of ["main.py", "pyproject.toml", "README.md"]) deviceFiles.get("/home/dev/projects/remote-runner-demo")!.set(name, "file");
const devicePath = (endpoint: WorkspaceRef, name = "") => `${endpoint.type === "device" ? endpoint.path.replace(/^~\//, "/home/dev/").replace(/\/+$/, "") : "/local"}${name ? `/${name}` : ""}` || "/";
transferApi.listWithin = async (endpoint, subdir) => {
  if (params.has("error")) throw new Error("目录不存在，请检查设备工作区根目录。");
  const listing = deviceFiles.get(devicePath(endpoint, subdir));
  if (!listing) throw new Error("目录不存在");
  const entries = [...listing].map(([name, kind]) => ({ name, kind, size: 0, mode: null, identity: name, modified: "0" }));
  return { endpoint: endpoint.type === "device" ? { ...endpoint, path: devicePath(endpoint) } : endpoint, entries, overwrite: true };
};
api.createWorkspaceEntry = async (root, name, kind) => {
  const path = devicePath(root, name), slash = path.lastIndexOf("/"), dir = path.slice(0, slash) || "/";
  const listing = deviceFiles.get(dir);
  if (!listing || listing.has(path.slice(slash + 1))) throw new Error("目录不存在或目标已存在");
  listing.set(path.slice(slash + 1), kind);
  if (kind === "dir") deviceFiles.set(path, new Map());
};
api.renameWorkspaceEntry = async (root, name, target) => {
  const path = devicePath(root, name), next = devicePath(root, target), slash = path.lastIndexOf("/"), dir = path.slice(0, slash) || "/";
  const listing = deviceFiles.get(dir), kind = listing?.get(path.slice(slash + 1));
  if (!listing || !kind || listing.has(next.slice(next.lastIndexOf("/") + 1))) throw new Error("文件不存在或目标已存在");
  listing.delete(path.slice(slash + 1)); listing.set(next.slice(next.lastIndexOf("/") + 1), kind);
  for (const [key, value] of [...deviceFiles]) if (key === path || key.startsWith(`${path}/`)) { deviceFiles.delete(key); deviceFiles.set(next + key.slice(path.length), value); }
};
api.deleteWorkspaceEntry = async (root, name) => {
  const path = devicePath(root, name), slash = path.lastIndexOf("/");
  deviceFiles.get(path.slice(0, slash) || "/")?.delete(path.slice(slash + 1));
  for (const key of [...deviceFiles.keys()]) if (key === path || key.startsWith(`${path}/`)) deviceFiles.delete(key);
};
api.renameWorkspaceCommands = async () => {};
useAppStore.setState({ devices, selectedDeviceId: "ubuntu", workspace: empty ? null : workspace, environmentReady: false,
  workspaceTree: rootTree([{ name: "output", is_dir: true }, { name: "tools", is_dir: true }, { name: "main.py", is_dir: false }, { name: "pyproject.toml", is_dir: false }, { name: "README.md", is_dir: false }, { name: "run.sh", is_dir: false }]),
  openTabs: empty ? [] : [{ name: "main.py", fileContent: source, savedContent: source, revision: "demo", eol: "lf", bom: false, language: "python", conflict: false, generation: 1 },
    { name: "pyproject.toml", fileContent: '[project]\nname = "remote-runner-demo"\nversion = "1.0.0"\n', savedContent: "", revision: "demo", eol: "lf", bom: false, language: "toml", conflict: false, generation: 1 }], activeFile: empty ? null : "main.py" });
useWorkspaceRunStore.setState({ config: { config: { schema: 1, run_defaults: { cwd: "." } }, revision: "demo" } });
useTerminalStore.setState({ tabs: empty ? [] : [
  { id: "ubuntu-terminal", deviceId: "ubuntu", deviceName: base.name, title: "dev@ubuntu:~/projects/remote-runner-demo/tools", busy: false, status: { session_id: "demo-terminal", device_name: base.name, state: "connected", exit_code: null, error: null } },
  { id: "local-terminal", deviceId: "local", deviceName: "PowerShell", title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", busy: false },
], activeTab: "run" });
if (!empty) {
  useAppStore.getState().handleRunEvents([
    { type: "status", status: { run_id: "demo-run", device_name: base.name, label: "main.py", state: params.has("running") ? "syncing" : "exited", exit_code: params.has("running") ? null : 0, error: null, started_at: new Date(Date.now() - 69000).toISOString(), ended_at: params.has("running") ? null : new Date().toISOString() } },
    { type: "output", run_id: "demo-run", stream: "stdout", data: btoa("$ python main.py\r\n\r\n" + Array.from({length: 6}, (_, i) => `[${String(i + 1).padStart(2, "0")}/10] temperature: ${(23.5 + i * .1).toFixed(1)} C`).join("\r\n") + "\r\n\r\n\x1b[32mReport saved to output/report.json\x1b[0m\r\n") },
  ]);
  useAppStore.setState({ activeRunId: "demo-run" });
}
if (params.has("running")) useAppStore.setState({ runProgress: { "demo-run": "Uploading workspace · 24 / 100 files" } });
if (params.has("many")) {
  const tab = useAppStore.getState().openTabs[0];
  if (tab) useAppStore.setState({ openTabs: [...useAppStore.getState().openTabs, ...Array.from({ length: 8 }, (_, i) => ({ ...tab, name: `tools/measurement_analysis_${i + 1}.py` }))], activeFile: "tools/measurement_analysis_8.py" });
  const terminal = useTerminalStore.getState().tabs[0];
  if (terminal) useTerminalStore.setState({ tabs: [...useTerminalStore.getState().tabs, ...Array.from({ length: 6 }, (_, i) => ({ ...terminal, id: `extra-${i}`, title: `dev@ubuntu:~/projects/remote-runner-demo/measurement-${i + 1}`, status: undefined }))], activeTab: "extra-5" });
}
if (!empty && params.has("longNames")) {
  const longName = "tools/measurement_collection_and_long_term_analysis_report_generator.py";
  const tab = useAppStore.getState().openTabs[0];
  useAppStore.setState({ openTabs: [...useAppStore.getState().openTabs, { ...tab, name: longName, savedContent: "" }] });
  const remote: WorkspaceRef = { type: "device", device_id: "ssh", path: "/home/dev/projects/remote-runner-demo" };
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  await useAppStore.getState().openDeviceFile(remote, longName);
  useAppStore.getState().editContent(useAppStore.getState().activeFile!, `${source}\n# Edited device draft\n`);
}
if (params.has("commands")) {
  useAppStore.setState({ openTabs: useAppStore.getState().openTabs.map((tab) => ({ ...tab, savedContent: tab.fileContent })) });
  let count = 0;
  api.runScript = async (request) => {
    const id = `preset-${++count}`;
    await new Promise((resolve) => setTimeout(resolve, 300));
    useAppStore.getState().handleRunEvents([
      { type: "status", status: { run_id: id, device_name: base.name, label: request.command ?? "command", state: "exited", exit_code: 0, error: null, started_at: new Date().toISOString(), ended_at: new Date().toISOString() } },
      { type: "output", run_id: id, stream: "stdout", data: btoa(`Fixture command run #${count}\r\n`) },
    ]);
    return id;
  };
}
if (transfer) {
  await useTransferStore.getState().browse("local", { type: "local", dir: "C:\\projects\\remote-runner-demo" });
  await useTransferStore.getState().browse("device", workspace.type === "device" ? workspace : { type: "device", device_id: base.id, path: base.workspace_root });
}
useAppStore.setState({ layout: { ...DEFAULT_LAYOUT, panelVisible: { ...DEFAULT_LAYOUT.panelVisible, editor: !empty, transfer, deviceWorkspace: params.has("deviceWorkspace") }, panelCollapsed: { ...DEFAULT_LAYOUT.panelCollapsed } } });
const width = Number(params.get("width"));
if (width >= 640) document.getElementById("root")!.style.cssText = `width:min(${width}px,100vw);margin:auto;border-inline:1px solid var(--border);`;
// Inline-transfer interactions use the real UI and store, with an entirely in-memory backend.
if (params.has("inlineTransfers")) {
  base.workspace_root = "/home/dev/projects/remote-runner-demo";
  const remote: WorkspaceRef = { type: "device", device_id: base.id, path: base.workspace_root };
  const local: WorkspaceRef = workspace.type === "local" ? workspace : { type: "local", dir: "C:\\projects\\workspace-source" };
  const attributes = { kind: "file", size: 1_048_576, mode: null, identity: "mock", modified: "0" };
  api.listWorkspaceDir = async (_workspace, subdir) => subdir === "output" ? [{ name: "report.json", is_dir: false }] : [
    { name: "output", is_dir: true }, { name: "tools", is_dir: true }, { name: "main.py", is_dir: false },
    { name: "pyproject.toml", is_dir: false }, { name: "README.md", is_dir: false }, { name: "run.sh", is_dir: false },
  ];
  const task = (id: string, first_path: string, source: WorkspaceRef, target: WorkspaceRef, state = "transferring", transferred_bytes = 0): TransferSummary => ({
    id, first_path, source, target, state, transferred_bytes, total_bytes: 1_048_576, selection_count: 1,
    sequence: 1, current_path: first_path === "output" ? "output/report.json" : first_path, error: state === "failed" ? "Connection disconnected" : null,
    item_count: 1, completed: state === "completed" ? 1 : 0, skipped: 0, failed: state === "failed" ? 1 : 0,
    pending_count: state === "transferring" ? 1 : 0, unknown_count: 0, residual_count: 0, warning_count: 0,
  });
  let tasks = [task("upload-file", "main.py", local, remote, "transferring", 440_402), task("upload-folder", "output", local, remote, "transferring", 713_031), task("failed-download", "README.md", remote, local, "failed", 300_000)];
  const plans = new Map<string, TransferPlan>(), retries = new Map<string, string>(), animated = new Set<string>();
  transferApi.plan = async request => {
    const plan: TransferPlan = { id: crypto.randomUUID(), request, total_bytes: attributes.size, conflicts: 0, warnings: [], overwrite: true, keep_both: true,
      items: request.paths.map(path => ({ path, attrs: attributes, target_attrs: null, state: "pending", target_path: null, error: null })) };
    plans.set(plan.id, plan); return plan;
  };
  transferApi.retry = async id => {
    const old = tasks.find(item => item.id === id)!;
    const plan = await transferApi.plan({ source: old.source, target: old.target, paths: [old.first_path], exclude_project_files: false, protected_paths: [] });
    retries.set(plan.id, id); return plan;
  };
  transferApi.discard = async id => { plans.delete(id); };
  transferApi.start = async id => {
    const plan = plans.get(id)!, created = task(crypto.randomUUID(), plan.request.paths[0], plan.request.source, plan.request.target);
    const previous = retries.get(id);
    if (previous) { created.retry_of = previous; tasks = tasks.map(item => item.id === previous ? { ...item, superseded_by: created.id, sequence: item.sequence + 1 } : item); }
    tasks = [created, ...tasks]; animated.add(created.id); return created.id;
  };
  transferApi.cancel = async id => { tasks = tasks.map(item => item.id === id ? { ...item, state: "canceled", pending_count: 1, sequence: item.sequence + 1 } : item); };
  transferApi.snapshot = async () => {
    tasks = tasks.map(item => {
      if (!animated.has(item.id) || item.state !== "transferring") return item;
      const bytes = Math.min(item.total_bytes, item.transferred_bytes + 131_072), done = bytes === item.total_bytes;
      return { ...item, transferred_bytes: bytes, state: done ? "completed" : "transferring", completed: done ? 1 : 0, pending_count: done ? 0 : 1, sequence: item.sequence + 1 };
    });
    return tasks.map(item => ({ ...item }));
  };
  transferApi.task = async id => {
    const item = tasks.find(task => task.id === id)!;
    return { id, request: { source: item.source, target: item.target, paths: [item.first_path], exclude_project_files: false, protected_paths: [] }, state: item.state,
      policy: "keep_both", preserve_executable: false, total_bytes: item.total_bytes, transferred_bytes: item.transferred_bytes, error: item.error, warnings: [], residuals: [],
      items: [{ path: item.first_path, attrs: attributes, target_attrs: null, state: item.state === "completed" ? "completed" : item.state === "failed" ? "failed" : "pending", target_path: item.first_path, error: item.error }] };
  };
  useTransferStore.setState({ tasks, options: { ...useTransferStore.getState().options, device_id: base.id }, directories: { local: local.dir, devices: { [base.id]: base.workspace_root } }, inlineHiddenIds: [] });
}
if (params.has("rowActions")) {
  for (const device of devices) device.revision = "demo";
  const longName = "measurement_collection_and_long_term_analysis_report_generator.py";
  const app = useAppStore.getState();
  useAppStore.setState({ workspaceTree: rootTree([...app.workspaceTree[""].entries, { name: longName, is_dir: false }]) });
  deviceFiles.get("/home/dev/projects/remote-runner-demo")!.set(longName, "file");
  api.runWorkspace = async request => {
    const id = crypto.randomUUID(), status = { run_id: id, device_name: base.name, label: request.command.entry.type === "python_module" ? request.command.entry.name : request.command.entry.path,
      state: "exited", exit_code: 0, error: null, started_at: new Date().toISOString(), ended_at: new Date().toISOString() };
    useAppStore.getState().handleRunEvents([{ type: "status", status }, { type: "output", run_id: id, stream: "stdout", data: btoa("Fixture shortcut run completed.\r\n") }]);
    return id;
  };
}
function Fixture() {
  const layout = useAppStore(s => s.layout);
  React.useEffect(() => {
    if (!params.has("inlineTransfers")) return;
    const timer = setInterval(() => { void useTransferStore.getState().refresh(); }, 500);
    return () => clearInterval(timer);
  }, []);
  const toggle = (id: PanelId) => useAppStore.getState().setLayout({ panelCollapsed: { ...layout.panelCollapsed, [id]: !layout.panelCollapsed[id] } });
  return <div className="app">
    <TitleBar closeReady uiZoom={100} onUiZoom={() => {}} onAbout={() => {}} onCheckUpdate={() => {}} />
    <main className="app-main">
      {layout.sidebarVisible && <aside className="dock-side" style={{ width: 252 }}>
        <WorkspacePanel collapsed={layout.panelCollapsed.workspace} onToggleCollapse={() => toggle("workspace")} />
        {layout.panelVisible.deviceWorkspace && <DeviceWorkspacePanel visible collapsed={layout.panelCollapsed.deviceWorkspace} onToggleCollapse={() => toggle("deviceWorkspace")} />}
        <div className="commands-section"><CommandsPanel collapsed={layout.panelCollapsed.commands} onToggleCollapse={() => toggle("commands")} /></div>
      </aside>}
      <CenterDock />
    </main>
    <DeviceManager /><WorkspaceRunDialogs /><UnsavedDialog /><WorkspaceTransferDialogs />
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
