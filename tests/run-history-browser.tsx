// Manual fixture: npm run dev -> /tests/run-history-browser.html. No real devices/processes.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { api, localWorkspace, type DeviceProfile, type RunReplay, type RunStatus, type WorkspaceRunRequest } from "../src/api";
import { useAppStore } from "../src/store";
import { useWorkspaceRunStore } from "../src/workspaceRunStore";
import { RunHistoryPanel } from "../src/components/RunHistoryPanel";
import { RunHistoryDialogs } from "../src/components/RunHistoryDialogs";
import { RunToolbar } from "../src/components/RunToolbar";
import { initializeTheme, useThemeStore } from "../src/theme";
import i18n from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";

await i18n.changeLanguage("zh"); const disposeTheme = initializeTheme(); useThemeStore.getState().setPreference("light");
const workspace = localWorkspace("E:/projects/product");
const devices: DeviceProfile[] = [
  { id: "a", revision: "rev-a", name: "anslink", transport: "ssh", host: "192.168.50.100", port: 22, username: "anslink", auth: { type: "key", key_path: null }, workspace_root: "/runs", is_default: true },
  { id: "b", revision: "rev-b", name: "本机 pwsh", transport: "local", local: { shell: "pwsh" }, host: "", port: 22, username: "", auth: { type: "key", key_path: null }, workspace_root: "", is_default: false },
];
function sample(id: string, name: string, args: string[], state = "exited"): RunStatus {
  const request: WorkspaceRunRequest = { workspace, device_id: "a", device_revision: "rev-a", command: { entry: { type: "python_script", path: name }, args }, python: "project", settings: { cwd: "tools", env: { TOKEN: "only-visible-in-details", MODE: "release" }, console_mode: "pipe", timeout_secs: 90, cols: 80, rows: 24 } };
  const replay: RunReplay = { request: { workspace, device_id: "a", kind: "python", entry: name, args }, workspace_request: request, device_revision: "rev-a", device_target: "anslink@192.168.50.100:22", source_revision: null, launch: { environment: "project", program: "/home/anslink/.venv/bin/python", version: "3.12.9", cwd: "/runs/product/tools", python_path: [] } };
  return { run_id: id, device_name: "anslink", label: name, state, exit_code: state === "exited" ? 0 : null, error: null, started_at: `2026-10-22T14:${id === "latest" ? "32" : "20"}:00+08:00`, ended_at: state === "exited" ? "2026-10-22T14:33:00+08:00" : null, replay };
}
const latest = sample("latest", "product.py", ["--mode", "test", "--name", "sample with spaces", ""]);
const old = sample("old", "tools/train.py", ["--epochs", "10", "--description", "一条很长的参数，用来检查窄侧栏的省略显示和悬停完整预览"]);
const live = sample("live", "background.py", [], "running");
useAppStore.setState({ devices, workspace, selectedDeviceId: "b", activeRunId: "latest", runs: { latest, old, live }, history: [latest, old], environmentReady: true, saveAllDirty: async () => true });
useWorkspaceRunStore.setState({ config: { config: { schema: 1, run_defaults: { cwd: "." } }, revision: "demo" } });
api.getWorkspaceRun = async id => { const run = useAppStore.getState().runs[id]; return run?.replay ? { request: run.replay.workspace_request, launch: run.replay.launch, warning: null } : null; };
api.getRunStatus = async id => useAppStore.getState().runs[id] ?? null;
api.readRunHistoryOutput = async id => btoa(`[${id}] first line\nsecond line\nexit status: 0\n`);
api.runWorkspace = async request => {
  const id = crypto.randomUUID(), device = devices.find(d => d.id === request.device_id)!;
  const status = { ...sample(id, request.command.entry.type === "python_module" ? request.command.entry.name : request.command.entry.path, request.command.args), run_id: id, device_name: device.name, started_at: new Date().toISOString() };
  status.replay!.request.device_id = device.id; status.replay!.workspace_request = request; status.replay!.device_revision = device.revision!;
  status.replay!.device_target = device.transport === "local" ? "pwsh" : "anslink@192.168.50.100:22";
  status.replay!.launch = { environment: request.python, program: device.transport === "local" ? "C:/runtime/python.exe" : "/home/anslink/.venv/bin/python", version: "3.12.9", cwd: device.transport === "local" ? "E:/projects/product/tools" : "/runs/product/tools", python_path: [] };
  useAppStore.getState().handleRunEvent({ type: "status", status }); return id;
};
api.stopRun = async id => { const status = useAppStore.getState().runs[id]; if (status) useAppStore.getState().handleRunEvent({ type: "status", status: { ...status, state: "canceled", ended_at: new Date().toISOString() } }); };
api.deleteRunHistory = async () => {};
function Fixture() {
  const [width, setWidth] = useState(280), [collapsed, setCollapsed] = useState(false);
  const active = useAppStore(s => s.activeRunId ? s.runs[s.activeRunId] : null);
  return <div className="app"><RunHistoryDialogs /><div style={{ padding: 10, display: "flex", gap: 12 }}><span>历史命令交互验收</span><button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>中文 / English</button><button onClick={() => useThemeStore.getState().setPreference(useThemeStore.getState().theme === "light" ? "dark" : "light")}>主题</button><label>侧栏宽度 <input aria-label="侧栏宽度" type="range" min={200} max={480} value={width} onChange={e => setWidth(Number(e.target.value))} /></label></div>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}><aside style={{ display: "flex", flexDirection: "column", flexShrink: 0, width, borderRight: "1px solid var(--border)" }}><div className="panel-title" style={{ flex: 1, alignItems: "flex-start" }}>工作区 · product</div><div className="panel-title">▸ 预置命令</div><div style={{ height: 340, display: "flex", flexDirection: "column" }}><RunHistoryPanel visible collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} /></div></aside>
    <section style={{ flex: 1, minWidth: 0 }}><div className="panel-title">运行控制台</div><RunToolbar /><pre style={{ padding: 16, whiteSpace: "pre-wrap" }}>最后一次任务输出：{active?.label} @ {active?.device_name}{"\n"}{JSON.stringify(active?.replay?.workspace_request?.command.args)}</pre></section></main></div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => { root.unmount(); disposeTheme(); });
