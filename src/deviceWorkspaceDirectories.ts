import type { WorkspaceRef } from "./api";
import { isDevicePath } from "./directoryCompletion";

export const DEVICE_WORKSPACE_DIRECTORIES_KEY = "remote-runner.device-workspace-directories.v1";

export function loadDeviceWorkspaceDirectories(): Map<string, string> {
  try {
    const data = JSON.parse(localStorage.getItem(DEVICE_WORKSPACE_DIRECTORIES_KEY) ?? "null");
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return new Map(Object.entries(data).filter((entry): entry is [string, string] =>
        !!entry[0] && typeof entry[1] === "string" && isDevicePath(entry[1])));
    }
  } catch { /* Invalid or unavailable storage starts with empty session memory. */ }
  return new Map();
}

/** Save only resolved, successfully opened roots; tree expansion does not change the current path. */
export function rememberDeviceWorkspaceDirectory(directories: Map<string, string>, endpoint: WorkspaceRef): void {
  if (endpoint.type !== "device" || !endpoint.device_id || !isDevicePath(endpoint.path)) return;
  directories.set(endpoint.device_id, endpoint.path);
  try { localStorage.setItem(DEVICE_WORKSPACE_DIRECTORIES_KEY, JSON.stringify(Object.fromEntries(directories))); }
  catch { /* Shared session memory still survives sidebar unmounts when storage is unavailable. */ }
}

/** Shared across mounted sidebar instances; kept separate from transfer-browser preferences. */
export const deviceWorkspaceDirectories = loadDeviceWorkspaceDirectories();
