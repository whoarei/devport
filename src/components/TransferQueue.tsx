import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useTransferStore } from "../transferStore";
import { transferActive, transferApi, transferBytes, type TransferSummary, type TransferTask } from "../transferApi";
import { canRetryTransfer, splitTransferQueue, transferPercent, transferQueueState, transferTaskName } from "../transferQueue";
import { ContextMenu, contextMenuPosition, type MenuState } from "./ContextMenu";

interface RowProps {
  task: TransferSummary;
  onDetails: () => void;
  onRetry: () => void;
  onMenu: (menu: MenuState) => void;
  menuOpen: boolean;
}

function QueueRow({ task, onDetails, onRetry, onMenu, menuOpen }: RowProps) {
  const { t } = useTranslation();
  const devices = useAppStore((s) => s.devices);
  const blocked = useTransferStore((s) => s.planning || !!s.plan);
  const [working, setWorking] = useState(false);
  const speed = useRef({ bytes: task.transferred_bytes, at: Date.now(), value: 0 });
  if (speed.current.bytes !== task.transferred_bytes) {
    const elapsed = (Date.now() - speed.current.at) / 1000;
    speed.current = { bytes: task.transferred_bytes, at: Date.now(), value: elapsed > 0 ? Math.max(0, task.transferred_bytes - speed.current.bytes) / elapsed : 0 };
  }
  const name = transferTaskName(task);
  const isActive = transferActive(task.state);
  const state = transferQueueState(task);
  const status = t(state === "unknown" ? "transfer.needsReview" : state === "needsCleanup" ? "transfer.needsCleanup" : `transfer.states.${state}`);
  const percent = transferPercent(task);
  const rate = Date.now() - speed.current.at > 2000 ? 0 : speed.current.value;
  const upload = task.source.type === "local";
  const endpoint = upload ? task.target : task.source;
  const device = endpoint.type === "device" ? devices.find((d) => d.id === endpoint.device_id) : null;
  const deviceName = device?.name ?? (endpoint.type === "device" ? endpoint.device_id : t("transfer.local"));
  const route = `${workspaceLabel(task.source, devices)} → ${workspaceLabel(task.target, devices)}`;
  const error = task.error?.replace(/\s+/g, " ").trim();
  const perform = async (action: () => Promise<unknown>) => {
    setWorking(true);
    try { await action(); await useTransferStore.getState().refresh(); }
    catch (error) { useTransferStore.setState({ error: errorMessage(error) }); }
    finally { setWorking(false); }
  };
  const more = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const entries: MenuState["entries"] = [{ label: t("transfer.details"), onSelect: onDetails }];
    if (!isActive && task.residual_count > 0) entries.push({ label: t("transfer.cleanup"), disabled: working, onSelect: () => void perform(() => transferApi.cleanup(task.id)) });
    onMenu({ ...contextMenuPosition(rect.left, rect.bottom, entries.length), entries });
  };
  return <tr className={`transfer-queue-row queue-${state}`}>
    <td><button className="transfer-task-name" title={task.first_path || task.current_path || name} aria-label={t("transfer.taskDetails", { name })} onClick={onDetails}>{name}</button></td>
    <td className="transfer-queue-direction" title={route}><span aria-label={t(upload ? "transfer.upload" : "transfer.download")}>{upload ? "↑" : "↓"}</span> {deviceName}</td>
    <td className="transfer-queue-result" title={error || status}>
      <div className="transfer-result-text"><span>{task.state === "transferring" ? `${percent}%` : status}</span>
        {task.state === "transferring" && rate > 0 && <small>{transferBytes(Math.round(rate))}/s</small>}
        {!isActive && error && state !== "unknown" && <small className="transfer-brief-error">{error}</small>}
      </div>
      {isActive && <progress aria-label={t("transfer.progressFor", { name })} max={100} value={percent} />}
    </td>
    <td className="transfer-queue-actions">
      {isActive && <button disabled={working || task.state === "canceling"} onClick={() => void perform(() => transferApi.cancel(task.id))}>{t("transfer.cancel")}</button>}
      {canRetryTransfer(task) && <button disabled={working || blocked} title={t("transfer.retry")} aria-label={t("transfer.retry")} onClick={onRetry}>{t("transfer.retryShort")}</button>}
      <button className="transfer-more" disabled={working} aria-label={t("transfer.moreActions", { name })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => more(e.currentTarget)}>⋯</button>
    </td>
  </tr>;
}

export function TransferDetailsDialog({ task, onClose, onRetry, onShowTask }: { task: TransferSummary; onClose: () => void; onRetry: () => void; onShowTask: (id: string) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const devices = useAppStore((s) => s.devices);
  const blocked = useTransferStore((s) => s.planning || !!s.plan);
  const previousAvailable = useTransferStore((s) => !!task.retry_of && s.tasks.some((item) => item.id === task.retry_of));
  const nextAvailable = useTransferStore((s) => !!task.superseded_by && s.tasks.some((item) => item.id === task.superseded_by));
  const [detail, setDetail] = useState<TransferTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [onlyFailures, setOnlyFailures] = useState(task.failed > 0 || task.unknown_count > 0);
  const filterChosen = useRef(false);
  const [page, setPage] = useState(0);
  const isActive = transferActive(task.state);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  // Read full item results only on open, on completion, or on explicit refresh.
  // The lightweight queue snapshot continues to supply live counts/progress.
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(null);
    void transferApi.task(task.id).then((result) => {
      if (disposed) return;
      setDetail(result);
      if (!filterChosen.current) setOnlyFailures(result.items.some((item) => ["failed", "unknown"].includes(item.state)));
    }).catch((e) => { if (!disposed) setError(errorMessage(e)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [task.id, isActive, revision]);
  const cleanup = async () => {
    setWorking(true); setError(null);
    try { await transferApi.cleanup(task.id); await useTransferStore.getState().refresh(); setRevision((n) => n + 1); }
    catch (e) { setError(errorMessage(e)); }
    finally { setWorking(false); }
  };
  const items = detail?.items.filter((item) => !onlyFailures || ["failed", "unknown"].includes(item.state)) ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 100) - 1));
  return <dialog ref={ref} className="transfer-details-dialog" aria-labelledby="transfer-details-title" onCancel={onClose}>
    <div className="transfer-details-heading"><h2 id="transfer-details-title">{t("transfer.taskDetails", { name: transferTaskName(task) })}</h2><button className="transfer-details-close" aria-label={t("transfer.close")} onClick={onClose}>×</button></div>
    <dl className="transfer-details-paths"><dt>{t("transfer.source")}</dt><dd>{workspaceLabel(task.source, devices)}</dd><dt>{t("transfer.destination")}</dt><dd>{workspaceLabel(task.target, devices)}</dd></dl>
    {(previousAvailable || nextAvailable) && <div className="transfer-attempt-links">
      {previousAvailable && <button onClick={() => onShowTask(task.retry_of!)}>{t("transfer.previousAttempt")}</button>}
      {nextAvailable && <button onClick={() => onShowTask(task.superseded_by!)}>{t("transfer.nextAttempt")}</button>}
    </div>}
    <p className="transfer-details-summary">{t(`transfer.states.${task.state}`)} · {t("transfer.taskCounts", { completed: task.completed, count: task.item_count, failed: task.failed, skipped: task.skipped })} · {transferBytes(task.transferred_bytes)} / {transferBytes(task.total_bytes)}</p>
    {isActive && task.current_path && <p className="transfer-hint">{task.current_path}</p>}
    {(detail?.error || task.error) && <p className="transfer-error">{detail?.error || task.error}</p>}
    {task.unknown_count > 0 && <p className="transfer-error">{t("transfer.reviewUnknown")}</p>}
    <label className="transfer-result-filter"><input type="checkbox" checked={onlyFailures} onChange={(e) => { filterChosen.current = true; setOnlyFailures(e.target.checked); setPage(0); }} /> {t("transfer.onlyFailures")}</label>
    {loading && <p role="status" className="transfer-hint">{t("transfer.loadingResults")}</p>}
    {detail && <><ul className="transfer-item-results">{items.slice(currentPage * 100, (currentPage + 1) * 100).map((item) => <li key={item.path}><span>{t(`transfer.states.${item.state}`)}</span> {item.path}{item.target_path && item.target_path !== item.path && ` → ${item.target_path}`}{item.error && <p className="transfer-error">{item.error}</p>}</li>)}</ul>
      {!loading && items.length === 0 && <p className="transfer-hint">{t(onlyFailures ? "transfer.noFailures" : "transfer.noResults")}</p>}
      {items.length > 100 && <div className="transfer-file-pages"><button aria-label={t("transfer.previousPage")} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button> {currentPage + 1} / {Math.ceil(items.length / 100)} <button aria-label={t("transfer.nextPage")} disabled={(currentPage + 1) * 100 >= items.length} onClick={() => setPage(currentPage + 1)}>→</button></div>}
      {detail.warnings.length > 0 && <details className="transfer-detail-notes"><summary>{t("transfer.warnings", { count: detail.warnings.length })}</summary><ul>{detail.warnings.slice(0, 100).map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      {detail.residuals.length > 0 && <details className="transfer-detail-notes"><summary>{t("transfer.residuals", { count: detail.residuals.length })}</summary><ul>{detail.residuals.map((path) => <li key={path}>{path}</li>)}</ul></details>}
    </>}
    {error && <p role="alert" className="transfer-error">{error}</p>}
    <div className="transfer-details-actions"><button disabled={loading || working} onClick={() => setRevision((n) => n + 1)}>{t("transfer.refresh")}</button>
      {!isActive && task.residual_count > 0 && <button disabled={working} onClick={() => void cleanup()}>{t("transfer.cleanup")}</button>}
      {canRetryTransfer(task) && <button disabled={working || blocked} onClick={onRetry}>{t("transfer.retryShort")}</button>}
      <button onClick={onClose}>{t("transfer.close")}</button></div>
  </dialog>;
}

export function TransferQueue({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const tasks = useTransferStore((s) => s.tasks);
  const notices = useTransferStore((s) => s.completionNotices);
  const [now, setNow] = useState(Date.now);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<(MenuState & { taskId: string }) | null>(null);
  useEffect(() => {
    if (!visible) { setSelectedId(null); setMenu(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const time = Date.now(); setNow(time);
      const next = Math.min(...Object.values(notices).filter((until) => until > time));
      if (Number.isFinite(next)) timer = setTimeout(tick, Math.max(0, next - time));
    };
    tick();
    return () => clearTimeout(timer);
  }, [visible, notices]);
  const { current, history } = splitTransferQueue(tasks, notices, now);
  const selected = tasks.find((task) => task.id === selectedId);
  const retry = (task: TransferSummary) => {
    if (!canRetryTransfer(task)) return;
    setSelectedId(null); setMenu(null);
    void useTransferStore.getState().retry(task.id);
  };
  const table = (items: TransferSummary[]) => <table className="transfer-queue-table"><thead><tr><th>{t("transfer.task")}</th><th className="queue-direction-column">{t("transfer.direction")}</th><th className="queue-result-column">{t("transfer.progressResult")}</th><th className="queue-actions-column">{t("transfer.action")}</th></tr></thead><tbody>{items.map((task) => <QueueRow key={task.id} task={task} onDetails={() => { setMenu(null); setSelectedId(task.id); }} onRetry={() => retry(task)} onMenu={(next) => setMenu({ ...next, taskId: task.id })} menuOpen={visible && menu?.taskId === task.id} />)}</tbody></table>;
  if (!current.length && !history.length && !selected) return null;
  return <section className="transfer-queue" aria-label={t("transfer.queue")}>
    <h3>{t("transfer.queue")}</h3>
    {current.length > 0 && table(current)}
    {history.length > 0 && <details className="transfer-history"><summary>{t("transfer.completedHistory", { count: history.length })}</summary>{table(history)}</details>}
    {visible && menu && typeof document !== "undefined" && createPortal(<ContextMenu menu={menu} onClose={() => setMenu(null)} />, document.body)}
    {visible && selected && <TransferDetailsDialog key={selected.id} task={selected} onClose={() => setSelectedId(null)} onRetry={() => retry(selected)} onShowTask={setSelectedId} />}
  </section>;
}
