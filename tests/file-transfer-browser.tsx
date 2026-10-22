// Manual fixture: npm run dev -> /tests/file-transfer-browser.html. No real device or files.
import React from "react";
import { createRoot } from "react-dom/client";
import { api, type WorkspaceRef } from "../src/api";
import { FileTransferPanel } from "../src/components/FileTransferPanel";
import { emptyDevice } from "../src/components/DeviceDialog";
import { useAppStore } from "../src/store";
import { endpointPath, transferApi } from "../src/transferApi";
import { useTransferStore } from "../src/transferStore";
import { initializeTheme } from "../src/theme";
import i18n from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";

await i18n.changeLanguage("zh");
initializeTheme();
const files = new Map<string, "file" | "dir">([["/data/readme.txt", "file"], ["/data/logs", "dir"], ["/data/logs/output.bin", "file"]]);
const fullPath = (endpoint: WorkspaceRef, name: string) => `${endpointPath(endpoint).replace(/\/$/, "")}/${name}`;
transferApi.list = async (endpoint) => {
  const prefix = `${endpointPath(endpoint).replace(/\/$/, "")}/`;
  return { endpoint, overwrite: true, entries: endpoint.type === "local" ? [] : [...files].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map(([path, kind]) => ({ name: path.slice(prefix.length), kind, size: kind === "file" ? 4 : 0, mode: null, identity: path, modified: "0" })) };
};
api.createWorkspaceEntry = async (endpoint, name, kind) => {
  const path = fullPath(endpoint, name);
  if (files.has(path)) throw new Error("同名文件或目录已存在");
  files.set(path, kind);
};
api.renameWorkspaceEntry = async (endpoint, from, to) => {
  const source = fullPath(endpoint, from), target = fullPath(endpoint, to);
  if (files.has(target)) throw new Error("目标已存在");
  for (const [path, kind] of [...files]) if (path === source || path.startsWith(`${source}/`)) {
    files.delete(path); files.set(target + path.slice(source.length), kind);
  }
};
api.deleteWorkspaceEntry = async (endpoint, name) => {
  const target = fullPath(endpoint, name);
  for (const path of [...files.keys()]) if (path === target || path.startsWith(`${target}/`)) files.delete(path);
};
useAppStore.setState({ devices: [{ ...emptyDevice(), id: "fixture", name: "模拟 SSH 设备", revision: "1", workspace_root: "/data" }], environmentReady: true });
await useTransferStore.getState().browse("local", { type: "local", dir: "C:\\data" });
await useTransferStore.getState().browse("device", { type: "device", device_id: "fixture", path: "/data" });
document.addEventListener("contextmenu", (event) => event.preventDefault(), true);
createRoot(document.getElementById("root")!).render(<React.StrictMode><div style={{ height: "100vh" }}><FileTransferPanel visible collapsed={false} onToggleCollapse={() => {}} /></div></React.StrictMode>);
