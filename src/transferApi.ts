import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceRef } from "./api";

export interface TransferAttributes { kind: string; size: number; modified: string; mode: number | null; identity: string }
export interface TransferEntry extends TransferAttributes { name: string }
export interface TransferDirectory { endpoint: WorkspaceRef; entries: TransferEntry[]; overwrite: boolean }
export type ConflictPolicy = "keep_both" | "skip" | "overwrite";
export interface TransferRequest { source: WorkspaceRef; target: WorkspaceRef; paths: string[]; exclude_project_files: boolean; protected_paths: string[] }
export interface TransferItem { path: string; attrs: TransferAttributes; target_attrs: TransferAttributes | null; state: string; target_path: string | null; error: string | null }
export interface TransferPlan { id: string; request: TransferRequest; items: TransferItem[]; total_bytes: number; conflicts: number; warnings: string[]; overwrite: boolean; keep_both: boolean }
export interface TransferSummary {
  id: string; source: WorkspaceRef; target: WorkspaceRef; state: string;
  retry_of?: string | null; superseded_by?: string | null;
  first_path: string; selection_count: number;
  total_bytes: number; transferred_bytes: number; current_path: string; error: string | null;
  sequence: number; item_count: number; completed: number; skipped: number; failed: number;
  residual_count: number; warning_count: number;
  pending_count: number; unknown_count: number;
}
export interface TransferTask {
  id: string; request: TransferRequest; policy: ConflictPolicy; preserve_executable: boolean;
  retry_of?: string | null; superseded_by?: string | null;
  state: string; items: TransferItem[]; warnings: string[]; residuals: string[];
  total_bytes: number; transferred_bytes: number; error: string | null;
}

export const transferApi = {
  list: (endpoint: WorkspaceRef) => invoke<TransferDirectory>("transfer_list_dir", { endpoint }),
  /** List a relative directory under a fixed root; the response keeps the canonical root endpoint. */
  listWithin: (endpoint: WorkspaceRef, subdir: string) => invoke<TransferDirectory>("transfer_list_dir", { endpoint, subdir }),
  mkdir: (endpoint: WorkspaceRef, name: string) => invoke<void>("transfer_create_dir", { endpoint, name }),
  plan: (request: TransferRequest) => invoke<TransferPlan>("transfer_plan", { request }),
  discard: (planId: string) => invoke<void>("transfer_discard_plan", { planId }),
  start: (planId: string, policy: ConflictPolicy, preserveExecutable: boolean) => invoke<string>("transfer_start", { planId, policy, preserveExecutable }),
  snapshot: () => invoke<TransferSummary[]>("transfer_snapshot"),
  task: (taskId: string) => invoke<TransferTask>("transfer_task", { taskId }),
  cancel: (taskId: string) => invoke<void>("transfer_cancel", { taskId }),
  cancelAll: () => invoke<void>("transfer_cancel_all"),
  retry: (taskId: string) => invoke<TransferPlan>("transfer_retry_failed", { taskId }),
  cleanup: (taskId: string) => invoke<void>("transfer_cleanup", { taskId }),
};

export function transferActive(state: string): boolean {
  return ["queued", "transferring", "committing", "canceling"].includes(state);
}

export function endpointPath(endpoint: WorkspaceRef): string { return endpoint.type === "local" ? endpoint.dir : endpoint.path; }

export function sameTransferFilename(a: string, b: string, target: WorkspaceRef): boolean {
  const windows = target.type === "local" && (/^[a-z]:/i.test(target.dir) || /^\\\\/.test(target.dir));
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function appendEndpoint(endpoint: WorkspaceRef, name: string): WorkspaceRef {
  const separator = endpoint.type === "local" && endpoint.dir.includes("\\") ? "\\" : "/";
  const path = `${endpointPath(endpoint).replace(/[\\/]$/, "")}${separator}${name}`;
  return endpoint.type === "local" ? { type: "local", dir: path } : { ...endpoint, path };
}

/** Map a workspace-relative file into a transfer root, only on the same host. */
export function workspaceTransferPath(workspace: WorkspaceRef, name: string, endpoint: WorkspaceRef): string | null {
  if (workspace.type !== endpoint.type) return null;
  if (workspace.type === "device" && (endpoint.type !== "device" || workspace.device_id !== endpoint.device_id)) return null;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  const full = `${normalize(endpointPath(workspace))}/${name}`;
  const root = `${normalize(endpointPath(endpoint))}/`;
  const insensitive = workspace.type === "local" && (/^[a-z]:/i.test(full) || full.startsWith("//"));
  if (!(insensitive ? full.toLowerCase().startsWith(root.toLowerCase()) : full.startsWith(root))) return null;
  return full.slice(root.length);
}

export function transferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
