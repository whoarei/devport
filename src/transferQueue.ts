import i18n from "./i18n";
import { transferActive, type TransferSummary } from "./transferApi";

export function transferTaskName(task: TransferSummary): string {
  const path = task.first_path || task.current_path;
  const name = path?.split("/").pop() || i18n.t("transfer.unnamedTask");
  const count = task.selection_count ?? 1;
  return count > 1 ? i18n.t("transfer.batchName", { name, count }) : name;
}

export function canRetryTransfer(task: TransferSummary): boolean {
  const pending = task.pending_count ?? Math.max(0, task.item_count - task.completed - task.skipped - task.failed);
  return !task.superseded_by && !transferActive(task.state) && task.state !== "completed" && !(task.unknown_count > 0) && task.failed + pending > 0;
}

export function transferQueueState(task: TransferSummary): string {
  if (transferActive(task.state)) return task.state;
  if (task.unknown_count > 0) return "unknown";
  if ((task.state === "completed" || task.superseded_by) && task.residual_count > 0) return "needsCleanup";
  return task.state;
}

export function transferPercent(task: TransferSummary): number {
  const fraction = task.total_bytes > 0 ? task.transferred_bytes / task.total_bytes : (task.completed + task.skipped) / Math.max(1, task.item_count);
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

export function splitTransferQueue(tasks: TransferSummary[], notices: Record<string, number>, now: number) {
  const current: TransferSummary[] = [], history: TransferSummary[] = [];
  for (const task of tasks) {
    if (task.superseded_by && !transferActive(task.state) && task.residual_count === 0 && !(task.unknown_count > 0)) continue;
    const archived = task.state === "completed" && task.residual_count === 0 && !(task.unknown_count > 0) && !(notices[task.id] > now);
    (archived ? history : current).push(task);
  }
  return { current, history };
}
