// npm run dev -> /tests/directory-browser.html. In-memory files only; no device connections.
import React from "react";
import { createRoot } from "react-dom/client";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile } from "../src/api";
import { transferApi, endpointPath, type TransferDirectory } from "../src/transferApi";
import { useAppStore } from "../src/store";
import { useTransferStore } from "../src/transferStore";
import { RemoteWorkspaceDialog } from "../src/components/RemoteWorkspaceDialog";
import { FileTransferPanel } from "../src/components/FileTransferPanel";
import i18n from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";

await i18n.changeLanguage("zh");
document.documentElement.dataset.theme = "light";
const devices: DeviceProfile[] = [
  { id: "wsl", revision: "v1", name: "Ubuntu-24.04", is_default: true, transport: "wsl", wsl: { distribution: "Ubuntu", user: "test" },
    host: "", port: 22, username: "test", auth: { type: "key", key_path: null }, workspace_root: "/srv/workspaces" },
  { id: "ssh", revision: "v2", name: "开发服务器", is_default: false, transport: "ssh", host: "test", port: 22, username: "test", auth: { type: "key", key_path: null }, workspace_root: "/other" },
];
const tree: Record<string, string[]> = {
  "/": ["home", "srv", "slow"], "/home/test": ["projects"],
  "/srv": ["workspaces", "project-cache", "projects", "protected"],
  "/srv/workspaces": ["device-tools", "remote-runner", "scripts", "serial-debug", "wsl-samples"],
  "/srv/workspaces/remote-runner": ["docs", "scripts", "src", "src-tauri", "tests"],
  "/srv/projects": ["repo", "repo tools", "research"], "/slow": ["old"], "/other": ["server-only"],
  "C:\\work": ["project-local", "project tools", "notes.txt"],
};
const requests: { command: string; path: string; device?: string }[] = [];
const controls = { approve: true };
transferApi.list = async (endpoint): Promise<TransferDirectory> => {
  const original = endpointPath(endpoint);
  const path = original.startsWith("~/") ? "/home/test" + original.slice(1).replace(/\/$/, "") : original;
  requests.push({ command: "list", path, device: endpoint.type === "device" ? endpoint.device_id : undefined });
  await new Promise((resolve) => setTimeout(resolve, path === "/slow" ? 800 : 35));
  if (path === "/missing") throw new Error("目录不存在");
  if (path === "/denied") throw new Error("没有访问权限");
  return { endpoint: endpoint.type === "local" ? localWorkspace(path) : deviceWorkspace(endpoint.device_id, path), overwrite: true,
    entries: (tree[path] ?? []).map((name) => ({ name, kind: name.endsWith(".txt") ? "file" : "dir", size: 0, modified: "", mode: null, identity: name })) };
};
api.listWorkspaceDir = async (workspace) => { requests.push({ command: "workspace", path: endpointPath(workspace) }); return []; };
api.closeWorkspaceSession = async () => { requests.push({ command: "close-session", path: "" }); };
useAppStore.setState({ devices, selectedDeviceId: "wsl", workspace: deviceWorkspace("wsl", "/original"), environmentReady: true,
  confirmAllUnsaved: async () => controls.approve });
await useTransferStore.getState().browse("local", localWorkspace("C:\\work"));
await useTransferStore.getState().browse("device", deviceWorkspace("wsl", "/srv/workspaces"));
Object.assign(window, { directoryFixture: { requests, controls, app: useAppStore, transfers: useTransferStore } });
function Fixture() {
  return <main style={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: 12, display: "flex", gap: 8 }}><button onClick={() => useAppStore.getState().openRemoteWorkspaceDialog()}>打开选择器</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; }}>切换主题</button></div>
    <FileTransferPanel visible collapsed={false} onToggleCollapse={() => {}} />
    <RemoteWorkspaceDialog />
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
