import type { DeviceProfile, WorkspaceRef } from "./api";
import type { EditorTab } from "./editorDocument";
import { endpointPath, workspaceTransferPath } from "./transferApi";
import { isWithin } from "./workspaceTree";
import { dirtyTab, inferLanguage, neighborAfterClose } from "./editorDocument";

export interface EditorFileSource { workspace: WorkspaceRef; path: string; device_revision?: string }
export function editorFileKey(source: EditorFileSource): string {
  const host = source.workspace.type === "device" ? source.workspace.device_id : "local";
  return `device-file:${JSON.stringify([host, `${endpointPath(source.workspace).replace(/\/$/, "")}/${source.path}`])}`;
}
export const editorFilePath = (tab: EditorTab) => tab.source?.path ?? tab.name;
export function editorFileSource(tab: EditorTab, workspace: WorkspaceRef | null): EditorFileSource | null {
  return tab.source ?? (workspace ? { workspace, path: tab.name } : null);
}
export function editorFileTitle(tab: EditorTab, devices: DeviceProfile[], currentWorkspace?: WorkspaceRef | null): string {
  const origin = tab.source ?? (currentWorkspace?.type === "device" ? { workspace: currentWorkspace, path: tab.name } : null);
  if (!origin) return tab.name;
  const { workspace, path } = origin;
  return `${workspace.type === "device" ? devices.find((d) => d.id === workspace.device_id)?.name ?? workspace.device_id : ""}:${endpointPath(workspace).replace(/\/$/, "")}/${path}`;
}
export function editorSourceCurrent(source: EditorFileSource, devices: DeviceProfile[]): boolean {
  if (source.workspace.type !== "device") return true;
  const device = devices.find((d) => d.id === (source.workspace as { device_id: string }).device_id);
  return !!device && (!source.device_revision || source.device_revision === (device.revision ?? "missing"));
}
export function editorPathInWorkspace(tab: EditorTab, workspace: WorkspaceRef | null): string | null {
  if (!workspace) return null;
  return tab.source ? workspaceTransferPath(tab.source.workspace, tab.source.path, workspace) : tab.name;
}
export const workspaceEditorDirty = (state: { openTabs: EditorTab[]; workspace: WorkspaceRef | null }) =>
  state.openTabs.some((tab) => dirtyTab(tab) && editorPathInWorkspace(tab, state.workspace) !== null);

export function deviceEditorTargets(tabs: EditorTab[], workspace: WorkspaceRef, path: string): EditorTab[] {
  return tabs.filter((tab) => {
    const relative = tab.source ? editorPathInWorkspace(tab, workspace) : null;
    return relative !== null && isWithin(relative, path);
  });
}

export function applyDeviceEditorMutation(state: { openTabs: EditorTab[]; activeFile: string | null }, workspace: WorkspaceRef, path: string, target?: string) {
  const affected = new Set(deviceEditorTargets(state.openTabs, workspace, path).map((tab) => tab.name));
  let activeFile = state.activeFile;
  const openTabs = target === undefined ? state.openTabs.filter((tab) => !affected.has(tab.name)) : state.openTabs.map((tab) => {
    if (!affected.has(tab.name)) return tab;
    const relative = editorPathInWorkspace(tab, workspace)!;
    const source = { ...tab.source!, workspace, path: target + relative.slice(path.length) };
    const name = editorFileKey(source);
    if (tab.name === activeFile) activeFile = name;
    return { ...tab, source, name, language: inferLanguage(source.path), generation: tab.generation + 1 };
  });
  if (target === undefined && activeFile && affected.has(activeFile)) activeFile = neighborAfterClose(state.openTabs, activeFile, openTabs);
  return { openTabs, activeFile };
}
