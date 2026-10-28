import type { WorkspaceRef } from "./api";
import { sameTransferFilename, transferActive, workspaceTransferPath, type TransferSummary } from "./transferApi";

export const INLINE_TRANSFER_NOTICE_MS = 30_000;
const HIDDEN_KEY = "remote-runner.workspace-transfer-hidden.v1";
export interface WorkspaceTransferSelection { workspace: WorkspaceRef; path: string; directory: boolean; revision: string | null }

export function loadHiddenTransfers(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(-100) : [];
  } catch { return []; }
}

export function rememberHiddenTransfers(ids: string[]) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids.slice(-100))); } catch { /* Keep session state. */ }
}

export function transferOrigin(task: TransferSummary, tasks: TransferSummary[], origins: Record<string, WorkspaceTransferSelection>): WorkspaceTransferSelection | null {
  const seen = new Set<string>();
  let current = task;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    if (origins[current.id]) return origins[current.id];
    const parent = tasks.find((item) => item.id === current.retry_of);
    if (!parent) break;
    current = parent;
  }
  return current.selection_count === 1 && current.first_path
    ? { workspace: current.source, path: current.first_path, directory: false, revision: null } : null;
}

/** A directory owns the batch percentage. Its current child gets a status, never a guessed percentage. */
export function inlineTransferFor(workspace: WorkspaceRef, path: string, tasks: TransferSummary[], hidden: string[], notices: Record<string, number>, origins: Record<string, WorkspaceTransferSelection>, now = Date.now()) {
  const matches = tasks.flatMap((task) => {
    if (task.superseded_by) return [];
    const origin = transferOrigin(task, tasks, origins);
    if (!origin) return [];
    const rootPath = workspaceTransferPath(origin.workspace, origin.path, workspace);
    const currentPath = workspaceTransferPath(task.source, task.current_path, workspace);
    if (rootPath !== null && sameTransferFilename(rootPath, path, workspace)) return [{ task, nested: false }];
    return transferActive(task.state) && currentPath !== null && sameTransferFilename(currentPath, path, workspace) && rootPath !== null && sameTransferFilename(path.slice(0, rootPath.length + 1), `${rootPath}/`, workspace)
      ? [{ task, nested: true }] : [];
  });
  const match = matches.find(({ task }) => transferActive(task.state)) ?? matches[0];
  if (!match || hidden.includes(match.task.id)) return null;
  const task = match.task;
  if (task.state === "completed" && !task.residual_count && !task.unknown_count && !(notices[task.id] > now)) return null;
  return match;
}
