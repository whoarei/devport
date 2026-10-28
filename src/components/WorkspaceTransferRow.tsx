import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { errorMessage, type WorkspaceRef } from "../api";
import { useTransferStore } from "../transferStore";
import { inlineTransferFor } from "../workspaceTransfers";
import { canRetryTransfer, transferPercent, transferQueueState, transferTaskName } from "../transferQueue";
import { transferActive, transferApi, transferBytes } from "../transferApi";
import { preserveContentFocus } from "../focus";
import { Icon } from "./Icon";

export function WorkspaceTransferRow({ workspace, path, children, actions }: { workspace: WorkspaceRef; path: string; children: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  const { tasks, inlineHiddenIds, completionNotices, inlineOrigins, blocked } = useTransferStore(useShallow((s) => ({
    tasks: s.tasks, inlineHiddenIds: s.inlineHiddenIds, completionNotices: s.completionNotices, inlineOrigins: s.inlineOrigins,
    blocked: s.planning || !!s.plan || !!s.workspaceTransfer || s.deviceMutating,
  })));
  const [now, setNow] = useState(Date.now);
  const [working, setWorking] = useState(false);
  const match = inlineTransferFor(workspace, path, tasks, inlineHiddenIds, completionNotices, inlineOrigins, Math.max(now, Date.now()));
  const until = match ? completionNotices[match.task.id] : undefined;
  useEffect(() => {
    if (!until) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  if (!match) return <>{children}{actions}</>;
  const { task, nested } = match;
  const active = transferActive(task.state), state = transferQueueState(task);
  const completed = state === "completed", failed = !active && !completed;
  const percent = completed ? 100 : transferPercent(task), name = transferTaskName(task);
  const status = t(state === "unknown" ? "transfer.needsReview" : state === "needsCleanup" ? "transfer.needsCleanup" : `transfer.states.${state}`);
  const label = nested ? t("transfer.states.transferring") : task.state === "transferring" ? `${percent}%` : status;
  const info = [task.error, status, `${transferBytes(task.transferred_bytes)} / ${transferBytes(task.total_bytes)}`, task.current_path].filter(Boolean).join("\n");
  const cancel = async () => {
    setWorking(true);
    try { await transferApi.cancel(task.id); await useTransferStore.getState().refresh(); }
    catch (error) { useTransferStore.setState({ error: errorMessage(error), inlineDetailsId: task.id, inlineActionError: { id: task.id, message: errorMessage(error) } }); }
    finally { setWorking(false); }
  };
  return <div className={`workspace-transfer-row${failed ? " transfer-failed" : completed ? " transfer-completed" : ""}${nested ? " transfer-current-child" : ""}`}
    style={{ "--transfer-progress": `${percent}%` } as CSSProperties}>
    {(active || completed) && <span className="workspace-transfer-fill" role="progressbar" aria-label={t("transfer.progressFor", { name })}
      aria-valuenow={nested ? undefined : percent} aria-valuemin={0} aria-valuemax={100} />}
    {children}
    <button className="workspace-transfer-status" title={info} aria-label={t("transfer.taskDetails", { name })}
      onMouseDown={preserveContentFocus} onClick={() => useTransferStore.setState({ inlineDetailsId: task.id })}>
      <Icon name={active ? "arrowUp" : completed ? "check" : "alert"} className={task.source.type === "device" && active ? "transfer-download-icon" : ""} />
      <span>{label}</span>
    </button>
    {!nested && <span className="workspace-transfer-actions">
      {active ? <button title={t("transfer.cancel")} aria-label={t("transfer.cancelFor", { name })} disabled={working || task.state === "canceling"}
        onMouseDown={preserveContentFocus} onClick={() => void cancel()}><Icon name="close" /></button>
        : failed && <>
          <button title={task.unknown_count > 0 ? t("transfer.reviewUnknown") : t("transfer.retry")} aria-label={t("transfer.retryFor", { name })}
            disabled={blocked || !canRetryTransfer(task)} onMouseDown={preserveContentFocus} onClick={() => void useTransferStore.getState().retry(task.id, "workspace")}><Icon name="refresh" /></button>
          <button title={t("transfer.clearStatus")} aria-label={t("transfer.clearFor", { name })} onMouseDown={preserveContentFocus}
            onClick={() => useTransferStore.getState().clearInlineTransfer(task.id)}><Icon name="close" /></button>
        </>}
    </span>}
  </div>;
}
