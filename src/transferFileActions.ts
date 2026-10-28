import { api, errorMessage, workspaceRefEquals, type WorkspaceRef } from "./api";
import { uploadBusy } from "./editorDocument";
import i18n from "./i18n";
import { useAppStore } from "./store";
import { appendEndpoint, transferActive, workspaceTransferPath } from "./transferApi";
import { useTransferStore } from "./transferStore";
import { workspaceSourceRevision } from "./workspaceRun";
import { joinPath, parentOf } from "./workspaceTree";
import { applyDeviceEditorMutation, deviceEditorTargets, editorSourceCurrent } from "./editorSources";

export interface DeviceFileContext { endpoint: WorkspaceRef; generation: number; revision: string | null }
export type DeviceFileAction =
  | { type: "create"; name: string; kind: "file" | "dir" }
  | { type: "rename"; name: string; newName: string }
  | { type: "delete"; name: string };

export function deviceFileContext(): DeviceFileContext | null {
  const browser = useTransferStore.getState().device;
  return browser.directory && browser.directory.endpoint.type === "device" && !browser.loading
    ? { endpoint: browser.directory.endpoint, generation: browser.generation, revision: browser.sourceRevision } : null;
}

export function deviceFileContextCurrent(context: DeviceFileContext): boolean {
  const browser = useTransferStore.getState().device;
  return !browser.loading && browser.generation === context.generation
    && workspaceRefEquals(browser.directory?.endpoint ?? null, context.endpoint)
    && context.revision === workspaceSourceRevision(context.endpoint, useAppStore.getState().devices);
}

/** Only the successfully listed directory can be changed; address-bar drafts are ignored. */
export function deviceFileBlocker(context: DeviceFileContext | null): string | null {
  if (!context || !deviceFileContextCurrent(context)) return i18n.t("transfer.directoryChanged");
  return deviceFileOperationBlocker(context.endpoint);
}

/** Shared guards for the transfer browser and the independent device sidebar. */
export function deviceFileOperationBlocker(endpoint: WorkspaceRef): string | null {
  const state = useTransferStore.getState(), app = useAppStore.getState();
  if (state.deviceMutating || state.planning || state.plan || app.loading || app.updating || app.saving || app.starting || app.guarding || app.workspaceMutating) return i18n.t("workspace.busy");
  if (uploadBusy(app)) return i18n.t("workspace.uploadBusy");
  if (endpoint.type !== "device" || !app.devices.some((d) => d.id === endpoint.device_id && ["ssh", "wsl"].includes(d.transport))) return i18n.t("transfer.directoryChanged");
  if (state.registeredIds.some((id) => !state.tasks.some((task) => task.id === id))) return i18n.t("transfer.filesBusy");
  if (state.tasks.some((task) => transferActive(task.state) && [task.source, task.target].some((host) => host.type === "device" && host.device_id === endpoint.device_id))) return i18n.t("transfer.filesBusy");
  return null;
}

export function validDeviceFilename(name: string): boolean {
  return !!name.trim() && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

/** Reuse workspace mutations inside an open workspace so tabs, drafts and the tree follow. */
export async function mutateDeviceFile(context: DeviceFileContext, action: DeviceFileAction): Promise<boolean> {
  const state = useTransferStore.getState();
  const fail = (message: string) => { useTransferStore.setState({ error: message }); return false; };
  const blocked = deviceFileBlocker(context);
  if (blocked) return fail(blocked);
  const entry = state.device.directory!.entries.find((e) => e.name === action.name);
  if (action.type !== "create" && (!entry || !["file", "dir"].includes(entry.kind))) return fail(i18n.t("transfer.directoryChanged"));
  useTransferStore.setState({ error: null });
  const { success, started } = await performDeviceFileAction(context.endpoint, "", action, () => deviceFileContextCurrent(context), (message) => { fail(message); });
  // A failed recursive deletion may still have removed children: refresh on either outcome.
  if (started && (success || action.type === "delete") && deviceFileContextCurrent(context)) {
    const selection = success ? action.type === "delete" ? [] : [action.type === "rename" ? action.newName : action.name] : state.device.selected;
    await useTransferStore.getState().browse("device", context.endpoint, selection);
  }
  return success;
}

/** Mutate below a fixed root, routing editor-owned paths through the editor's tab/dirty guards. */
export async function performDeviceFileAction(
  root: WorkspaceRef, dir: string, action: DeviceFileAction,
  current: () => boolean, reportError: (message: string) => void,
): Promise<{ success: boolean; started: boolean }> {
  const fail = (message: string) => { reportError(message); return { success: false, started: false }; };
  if (!current()) return fail(i18n.t("transfer.directoryChanged"));
  const blocked = deviceFileOperationBlocker(root);
  if (blocked) return fail(blocked);
  if (!validDeviceFilename(action.name) || (action.type === "rename" && !validDeviceFilename(action.newName))) return fail(i18n.t("transfer.invalidFilename"));
  const path = joinPath(dir, action.name);
  const endpoint = dir.split("/").filter(Boolean).reduce(appendEndpoint, root);
  const editor = useAppStore.getState();
  const workspace = editor.workspace;
  if (workspace && action.type !== "create" && workspaceTransferPath(workspace, "", appendEndpoint(endpoint, action.name)) !== null) return fail(i18n.t("transfer.workspaceRootProtected"));
  const relative = workspace ? workspaceTransferPath(root, path, workspace) : null;
  const external = deviceEditorTargets(editor.openTabs, root, path);
  if (external.some((tab) => !editorSourceCurrent(tab.source!, editor.devices))) return fail(i18n.t("editor.deviceChanged"));
  if (action.type === "rename") {
    const moved = applyDeviceEditorMutation(editor, root, path, joinPath(dir, action.newName));
    if (new Set(moved.openTabs.map((tab) => tab.name)).size !== editor.openTabs.length) return fail(i18n.t("editor.targetOpen"));
  }
  useTransferStore.setState({ deviceMutating: true });
  if (relative === null) useAppStore.setState({ workspaceMutating: true });
  let success = false;
  try {
    if (relative !== null) {
      if (action.type === "create") success = await editor.createWorkspaceEntry(parentOf(relative), action.name, action.kind);
      else if (action.type === "rename") success = await editor.renameWorkspaceEntry(relative, action.newName);
      else success = await editor.deleteWorkspaceEntry(relative, current);
      if (!success && useAppStore.getState().workspaceError) fail(useAppStore.getState().workspaceError!);
    } else {
      if (action.type === "delete") for (const tab of external) {
        if (!await useAppStore.getState().confirmUnsaved(tab.name) || !current()) return { success: false, started: true };
      }
      if (!current()) return { success: false, started: true };
      if (action.type === "create") await api.createWorkspaceEntry(root, path, action.kind);
      else if (action.type === "rename") await api.renameWorkspaceEntry(root, path, joinPath(dir, action.newName));
      else await api.deleteWorkspaceEntry(root, path);
      success = true;
      if (action.type !== "create") {
        useAppStore.setState((s) => applyDeviceEditorMutation(s, root, path, action.type === "rename" ? joinPath(dir, action.newName) : undefined));
        const app = useAppStore.getState();
        if (!app.openTabs.length) app.setLayout({ panelVisible: { ...app.layout.panelVisible, editor: false } });
      }
    }
  } catch (error) { fail(errorMessage(error)); }
  finally {
    if (!success && action.type === "delete") useAppStore.setState((s) => ({ openTabs: s.openTabs.map((tab) => external.some((old) => old.name === tab.name) ? { ...tab, discardRecovery: false } : tab) }));
    if (relative === null) useAppStore.setState({ workspaceMutating: false });
    useTransferStore.setState({ deviceMutating: false });
  }
  return { success, started: true };
}
