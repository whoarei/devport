import { workspaceRefEquals, type WorkspaceRef } from "./api";
import { deviceWorkspaceKey, deviceWorkspaceNode, type DeviceWorkspaceStore } from "./deviceWorkspaceStore";
import { useAppStore } from "./store";
import { appendEndpoint, type TransferEntry } from "./transferApi";
import { deviceFileOperationBlocker, performDeviceFileAction, type DeviceFileAction } from "./transferFileActions";
import { useTransferStore } from "./transferStore";
import i18n from "./i18n";

export interface DeviceWorkspaceFileContext {
  root: WorkspaceRef;
  dir: string;
  key: string;
  generation: number;
}

export const deviceWorkspaceEndpoint = (root: WorkspaceRef, dir: string) => dir.split("/").filter(Boolean).reduce(appendEndpoint, root);

export function deviceWorkspaceFileContext(browser: DeviceWorkspaceStore, dir: string): DeviceWorkspaceFileContext | null {
  const state = browser.getState(), node = deviceWorkspaceNode(state.tree, dir);
  return state.root && state.key && node?.loaded && !node.loading && !state.navigating
    ? { root: state.root, dir, key: state.key, generation: state.generation } : null;
}

export function deviceWorkspaceContextCurrent(browser: DeviceWorkspaceStore, context: DeviceWorkspaceFileContext): boolean {
  const state = browser.getState(), app = useAppStore.getState();
  const node = deviceWorkspaceNode(state.tree, context.dir);
  return state.key === context.key && context.key === deviceWorkspaceKey(app.devices.find((d) => d.id === app.selectedDeviceId))
    && state.generation === context.generation && workspaceRefEquals(state.root, context.root)
    && !state.navigating && !!node?.loaded && !node.loading;
}

export function deviceWorkspaceFileBlocker(browser: DeviceWorkspaceStore, context: DeviceWorkspaceFileContext | null): string | null {
  if (!context || !deviceWorkspaceContextCurrent(browser, context)) return i18n.t("transfer.directoryChanged");
  if (browser.getState().mutating) return i18n.t("workspace.busy");
  return deviceFileOperationBlocker(context.root);
}

export async function mutateDeviceWorkspaceFile(browser: DeviceWorkspaceStore, context: DeviceWorkspaceFileContext, action: DeviceFileAction): Promise<boolean> {
  const current = () => deviceWorkspaceContextCurrent(browser, context);
  const report = (error: string) => { if (current()) browser.setState({ error }); };
  const blocked = deviceWorkspaceFileBlocker(browser, context);
  if (blocked) { report(blocked); return false; }
  const entry: TransferEntry | undefined = deviceWorkspaceNode(browser.getState().tree, context.dir)?.entries.find((entry) => entry.name === action.name);
  if (action.type !== "create" && !entry) { report(i18n.t("transfer.directoryChanged")); return false; }
  browser.setState({ mutating: true, error: null });
  let result = { success: false, started: false };
  try {
    result = await performDeviceFileAction(context.root, context.dir, action, current, report);
    return result.success;
  } finally {
    if (current()) {
      browser.setState({ mutating: false });
      if (result.started && (result.success || action.type === "delete")) await browser.getState().refreshBranch(context.dir);
    }
    const transfer = useTransferStore.getState().device;
    const endpoint = deviceWorkspaceEndpoint(context.root, context.dir);
    if (result.started && (result.success || action.type === "delete") && !transfer.loading && workspaceRefEquals(transfer.directory?.endpoint, endpoint)) {
      await useTransferStore.getState().browse("device", endpoint);
    }
  }
}
