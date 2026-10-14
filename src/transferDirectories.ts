import type { WorkspaceRef } from "./api";

export const TRANSFER_DIRECTORIES_KEY = "remote-runner.transfer-directories.v1";
export interface TransferDirectories { local: string | null; devices: Record<string, string> }

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

export function loadTransferDirectories(): TransferDirectories {
  try {
    const data = JSON.parse(localStorage.getItem(TRANSFER_DIRECTORIES_KEY) ?? "null");
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const devices = data.devices && typeof data.devices === "object" && !Array.isArray(data.devices)
        ? Object.fromEntries(Object.entries(data.devices).filter((entry): entry is [string, string] => entry[0].length > 0 && validPath(entry[1]) && entry[1].startsWith("/"))) : {};
      return { local: validPath(data.local) ? data.local : null, devices };
    }
  } catch { /* Missing storage or invalid preferences use defaults. */ }
  return { local: null, devices: {} };
}

export function rememberTransferDirectory(current: TransferDirectories, endpoint: WorkspaceRef): TransferDirectories {
  const next = endpoint.type === "local" ? { ...current, local: endpoint.dir }
    : { ...current, devices: { ...current.devices, [endpoint.device_id]: endpoint.path } };
  try { localStorage.setItem(TRANSFER_DIRECTORIES_KEY, JSON.stringify(next)); }
  catch { /* Keep session memory even when persistent storage is unavailable. */ }
  return next;
}

export function rememberedDeviceDirectory(directories: TransferDirectories, id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(directories.devices, id) ? directories.devices[id] : undefined;
}
