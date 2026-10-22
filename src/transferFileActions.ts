import { api, errorMessage, workspaceRefEquals, type WorkspaceRef } from "./api";
import { uploadBusy } from "./editorDocument";
import i18n from "./i18n";
import { useAppStore } from "./store";
import { appendEndpoint, transferActive, workspaceTransferPath } from "./transferApi";
import { useTransferStore } from "./transferStore";
import { workspaceSourceRevision } from "./workspaceRun";
import { parentOf } from "./workspaceTree";

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
  const state = useTransferStore.getState(), app = useAppStore.getState();
  if (!context || !deviceFileContextCurrent(context)) return i18n.t("transfer.directoryChanged");
  if (state.deviceMutating || state.planning || state.plan || app.updating || app.saving || app.starting || app.guarding || app.workspaceMutating) return i18n.t("workspace.busy");
  if (uploadBusy(app)) return i18n.t("workspace.uploadBusy");
  const endpoint = context.endpoint;
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
  if (!validDeviceFilename(action.name) || (action.type === "rename" && !validDeviceFilename(action.newName))) return fail(i18n.t("transfer.invalidFilename"));
  const entry = state.device.directory!.entries.find((e) => e.name === action.name);
  if (action.type !== "create" && (!entry || !["file", "dir"].includes(entry.kind))) return fail(i18n.t("transfer.directoryChanged"));

  const editor = useAppStore.getState();
  const workspace = editor.workspace;
  if (workspace && action.type !== "create" && workspaceTransferPath(workspace, "", appendEndpoint(context.endpoint, action.name)) !== null) return fail(i18n.t("transfer.workspaceRootProtected"));
  const relative = workspace ? workspaceTransferPath(context.endpoint, action.name, workspace) : null;
  useTransferStore.setState({ deviceMutating: true, error: null });
  let success = false;
  try {
    if (relative !== null) {
      if (action.type === "create") success = await editor.createWorkspaceEntry(parentOf(relative), action.name, action.kind);
      else if (action.type === "rename") success = await editor.renameWorkspaceEntry(relative, action.newName);
      else success = await editor.deleteWorkspaceEntry(relative, () => deviceFileContextCurrent(context));
      if (!success && useAppStore.getState().workspaceError) fail(useAppStore.getState().workspaceError!);
    } else {
      if (action.type === "create") await api.createWorkspaceEntry(context.endpoint, action.name, action.kind);
      else if (action.type === "rename") await api.renameWorkspaceEntry(context.endpoint, action.name, action.newName);
      else await api.deleteWorkspaceEntry(context.endpoint, action.name);
      success = true;
    }
  } catch (error) { fail(errorMessage(error)); }
  finally {
    // A failed recursive deletion may still have removed children: refresh on either outcome.
    if ((success || action.type === "delete") && deviceFileContextCurrent(context)) {
      const selection = success ? action.type === "delete" ? [] : [action.type === "rename" ? action.newName : action.name] : state.device.selected;
      await useTransferStore.getState().browse("device", context.endpoint, selection);
    }
    useTransferStore.setState({ deviceMutating: false });
  }
  return success;
}
