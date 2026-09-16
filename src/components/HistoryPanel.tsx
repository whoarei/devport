import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, RunStatus } from "../api";
import { canExportOutput, exportOutput, exportRecord } from "../historyExport";
import { isActiveRun, runStateLabel } from "../runState";
import { useAppStore } from "../store";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { ContextMenu, contextMenuPosition, MenuState } from "./ContextMenu";
import { PanelTitle } from "./PanelTitle";

export function HistoryPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { t } = useTranslation();
  const { history, setActiveRun, runs, activeRunId } = useAppStore(useShallow((s) => ({
    history: s.history, setActiveRun: s.setActiveRun, runs: s.runs, activeRunId: s.activeRunId,
  })));
  const running = Object.values(runs).filter(isActiveRun);
  const report = (e: unknown) => useAppStore.setState({ editorError: errorMessage(e) });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const openEntryMenu = (event: MouseEvent, entry: RunStatus) => {
    event.preventDefault();
    event.stopPropagation();
    const entries = [
      {
        label: t("history.exportJson"),
        onSelect: () => void exportRecord(entry).catch(report),
      },
      {
        label: t("history.exportLog"),
        // 只有本会话起持久化了输出的 run 有日志可导出
        disabled: !canExportOutput(entry),
        onSelect: () => void exportOutput(entry)
          .then((warning) => { if (warning) report(new Error(warning)); })
          .catch(report),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  // 面板空白区右键：清空全部历史
  const openPanelMenu = (event: MouseEvent) => {
    event.preventDefault();
    const entries = [
      {
        label: t("history.clear"),
        danger: true,
        disabled: history.length === 0,
        onSelect: () => setConfirmClear(true),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  const confirmRequest: ConfirmRequest | null = useMemo(() => confirmClear ? {
    title: t("history.clearTitle"),
    message: t("history.clearMessage", { count: history.length }),
    confirmLabel: t("history.clearConfirm"),
    danger: true,
    onCancel: () => setConfirmClear(false),
    onConfirm: () => {
      setConfirmClear(false);
      void useAppStore.getState().clearHistory().catch(report);
    },
  } : null, [confirmClear, history.length, t]);

  return (
    <div className="history-panel" onContextMenu={openPanelMenu}>
      <PanelTitle title={t("history.title")} collapsed={collapsed} onToggle={onToggleCollapse} />
      {running.length > 0 && <ul className="history-list" aria-label={t("history.running")}>
        {running.map((run) => <li key={run.run_id}>
          <button aria-pressed={activeRunId === run.run_id} onClick={() => setActiveRun(run.run_id)}>
            {run.label} · {run.device_name} · {runStateLabel(run.state)}
          </button>
          <button className="danger" aria-label={t("history.stopAria", { label: run.label })} disabled={run.state === "stopping"}
            onClick={() => void api.stopRun(run.run_id).catch(report)}>{t("history.stopLabel")}</button>
        </li>)}
      </ul>}
      {!collapsed && (
        <ul className="history-list">
          {history.map((h) => {
            // 只有本次会话内的 run 有输出缓冲可回看
            const viewable =
              runs[h.run_id] != null;
            return (
              <li key={h.run_id} onClick={() => viewable && setActiveRun(h.run_id)}
                onContextMenu={(event) => openEntryMenu(event, h)}>
                <span className={`run-state state-${h.state}`}>{runStateLabel(h.state)}</span>
                <span className="history-label">{h.label}</span>
                <span className="history-meta">
                  {h.device_name} · exit={h.exit_code ?? "-"} ·{" "}
                  {new Date(h.started_at).toLocaleTimeString()}
                </span>
                {h.environment_id && (
                  <span className="history-meta managed" title={h.environment_id}>
                    {t("history.managed", {
                      uv: h.uv_version ?? "?",
                      python: h.python_version ?? "?",
                      env: h.environment_id.slice(0, 8),
                    })}
                  </span>
                )}
              </li>
            );
          })}
          {history.length === 0 && <li className="empty">{t("history.empty")}</li>}
        </ul>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
