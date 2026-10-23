// Manual browser fixture: all file/device APIs below are in-memory mocks.
// npm run dev -> /tests/editor-browser.html. Not included in production builds.
import React from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "../src/components/Editor";
import { WorkspacePanel } from "../src/components/WorkspacePanel";
import { RunToolbar } from "../src/components/RunToolbar";
import { RunConsole } from "../src/components/RunConsole";
import { UnsavedDialog } from "../src/components/UnsavedDialog";
import { api, localWorkspace, WorkspaceEntry } from "../src/api";
import { useAppStore } from "../src/store";
import { rootTree, WORKSPACE_ROOT } from "../src/workspaceTree";
import { endAppTabCycle, handleAppKeyDown, handleAppKeyUp } from "../src/appShortcuts";
import { trackEditorTabUsage } from "../src/editorTabCycle";
import { restoredTab } from "../src/environmentState";
import "../src/styles.css";

const files: Record<string, { content: string; revision: string }> = {
  "main.py": { content: '# 温度采集示例\nimport time\n\ndef read_temperature():\n    value = 23.5\n    print(f"温度: {value} °C")\n    return value\n\nif __name__ == "__main__":\n    read_temperature()\n', revision: "1" },
  "run.sh": { content: '#!/bin/sh\n# 测试 Shell 高亮\nNAME="runner"\nfor i in 1 2 3; do\n  echo "$NAME: $i"\ndone\ncat <<EOF\nhello\nEOF\n', revision: "1" },
  "large.py": { content: '# Long line\ntext = "' + "a".repeat(900_000) + '"\nprint(text)\n', revision: "1" },
  "notes.txt": { content: "普通 UTF-8 文本。\n", revision: "1" },
  "sub/nested.py": { content: "print('子目录脚本')\n", revision: "1" },
};
const dirs = new Set<string>(["sub"]);

function listDir(subdir: string): WorkspaceEntry[] {
  const prefix = subdir ? `${subdir}/` : "";
  const entries = new Map<string, boolean>();
  for (const dir of dirs) {
    const name = dir.slice(prefix.length);
    if (dir.startsWith(prefix) && name && !name.includes("/")) entries.set(name, true);
  }
  for (const file of Object.keys(files)) {
    const name = file.slice(prefix.length);
    if (file.startsWith(prefix) && name && !name.includes("/")) entries.set(name, false);
  }
  return [...entries.entries()]
    .map(([name, is_dir]) => ({ name, is_dir }))
    .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

function renamePath(path: string, target: string) {
  for (const [key, value] of Object.entries(files)) {
    if (key === path || key.startsWith(`${path}/`)) {
      delete files[key];
      files[target + key.slice(path.length)] = value;
    }
  }
  for (const dir of [...dirs]) {
    if (dir === path || dir.startsWith(`${path}/`)) {
      dirs.delete(dir);
      dirs.add(target + dir.slice(path.length));
    }
  }
}

api.readWorkspaceFile = async (_dir, name) => {
  await new Promise(resolve => setTimeout(resolve, 80));
  const file = files[name];
  if (!file) throw { code: "not_found", message: `文件不存在：${name}` };
  return { ...file, eol: "lf", bom: false };
};
api.listWorkspaceDir = async (_dir, subdir) => {
  if (subdir !== WORKSPACE_ROOT && !dirs.has(subdir)) throw { code: "not_found", message: `目录不存在：${subdir}` };
  return listDir(subdir);
};
api.writeWorkspaceFile = async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (files[request.name].revision !== request.expectedRevision) throw { code: "conflict", message: "文件已被其他程序修改" };
  const revision = String(Number(request.expectedRevision) + 1);
  files[request.name] = { content: request.content, revision };
  return { revision };
};
api.createWorkspaceEntry = async (_dir, name, kind) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (files[name] || dirs.has(name)) throw { code: "exists", message: `同名文件或目录已存在：${name}` };
  if (kind === "dir") dirs.add(name);
  else files[name] = { content: "", revision: "1" };
};
api.renameWorkspaceEntry = async (_dir, oldName, newName) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!files[oldName] && !dirs.has(oldName)) throw { code: "not_found", message: `文件或目录不存在：${oldName}` };
  if ((files[newName] || dirs.has(newName)) && newName !== oldName) throw { code: "exists", message: `目标已存在：${newName}` };
  renamePath(oldName, newName);
};
api.deleteWorkspaceEntry = async (_dir, name) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!files[name] && !dirs.has(name)) throw { code: "not_found", message: `文件或目录不存在：${name}` };
  for (const key of Object.keys(files)) if (key === name || key.startsWith(`${name}/`)) delete files[key];
  for (const dir of [...dirs]) if (dir === name || dir.startsWith(`${name}/`)) dirs.delete(dir);
};
api.runScript = async () => "fixture-run";
api.getRunStatus = async () => ({ run_id: "fixture-run", device_name: "模拟设备", label: "界面测试", state: "exited", exit_code: 0, error: null, started_at: "", ended_at: "" });
api.resizeRunConsole = async () => {};
const workspace = localWorkspace("/mock-workspace");
useAppStore.setState({ workspace, recentWorkspaces: [workspace],
  workspaceTree: rootTree(await api.listWorkspaceDir(workspace, WORKSPACE_ROOT)),
  selectedDeviceId: "mock",
  openTabs: [{ name: "main.py", fileContent: files["main.py"].content, savedContent: files["main.py"].content,
    revision: "1", eol: "lf", bom: false, language: "python", conflict: false, generation: 1 },
    restoredTab({ name: "notes.txt", language: "text" })],
  activeFile: "main.py" });

function Fixture() {
  React.useEffect(() => {
    const stopTracking = trackEditorTabUsage();
    const keydown = (event: KeyboardEvent) => { handleAppKeyDown(event, () => {}); };
    const keyup = (event: KeyboardEvent) => { handleAppKeyUp(event); };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", endAppTabCycle);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", endAppTabCycle);
      stopTracking();
    };
  }, []);
  return <div className="app">
    <UnsavedDialog />
    <header style={{ padding: 8, flexShrink: 0 }}>编辑器与文件管理交互验收（模拟文件接口，不连接设备）
      <button onClick={() => { const name = useAppStore.getState().activeFile!; files[name] = { content: "# 外部修改\n", revision: String(Number(files[name].revision) + 1) }; }}>模拟外部修改</button>
      <button onClick={() => { for (let i = 0; i < 200; i++) useAppStore.getState().handleRunEvent({ type: "output", run_id: "fixture-run", stream: "stdout", data: btoa("output line\r\n".repeat(50)) }); }}>模拟大量终端输出</button>
      <button onClick={() => { useAppStore.getState().handleRunEvent({ type: "status", status: { run_id: "fixture-run", device_name: "模拟设备", label: "同步中", state: "syncing", exit_code: null, error: null, started_at: "", ended_at: null } }); }}>模拟同步中（禁止改动工作区）</button>
    </header>
    <main className="app-main"><aside className="dock-side" style={{ width: 240 }}><WorkspacePanel collapsed={false} onToggleCollapse={() => {}} /></aside><section className="dock-center"><Editor /></section></main>
    <footer style={{ height: 220, flexShrink: 0, display: "flex", flexDirection: "column" }}><RunToolbar /><RunConsole collapsed={false} onToggleCollapse={() => {}} /></footer>
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
