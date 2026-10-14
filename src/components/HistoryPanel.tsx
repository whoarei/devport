import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, RunStatus } from "../api";
import { canExportOutput, exportOutput, exportRecord } from "../historyExport";
import { isActiveRun, runStateLabel } from "../runState";
import { panelCollapsePatch, panelVisibilityPatch } from "../layoutState";
import { useAppStore } from "../store";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { ContextMenu, contextMenuPosition, MenuState } from "./ContextMenu";
import { PanelTitle } from "./PanelTitle";

export function HistoryPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { t, i18n } = useTranslation();
  const i18nLanguage = i18n.resolvedLanguage ?? "en";
  const { history, setActiveRun, runs, activeRunId } = useAppStore(useShallow((s) => ({
    history: s.history, setActiveRun: s.setActiveRun, runs: s.runs, activeRunId: s.activeRunId,
  })));
  const running = Object.values(runs).filter(isActiveRun);
  const [error, setError] = useState<string | null>(null);
  const report = (e: unknown) => setError(errorMessage(e));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const selectRun = (id: string) => {
    setActiveRun(id);
    const { layout, setLayout } = useAppStore.getState();
    if (!layout.panelVisible.console || layout.panelCollapsed.console) {
      setLayout({ ...panelVisibilityPatch(layout, "console", true), ...panelCollapsePatch(layout, "console", false) });
    }
  };

  // 鼠标右键按指针定位；点击「更多」（含键盘激活）按按钮位置定位。
  const menuPosition = (event: MouseEvent, count: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.type === "contextmenu"
      ? contextMenuPosition(event.clientX, event.clientY, count)
      : contextMenuPosition(rect.left, rect.bottom, count);
  };

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
        // 持久化过输出的记录才有日志可导出（含旧会话）。
        disabled: !canExportOutput(entry),
        onSelect: () => void exportOutput(entry)
          .then((warning) => { if (warning) report(new Error(warning)); })
          .catch(report),
      },
    ];
    setMenu({ ...menuPosition(event, entries.length), entries });
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
    setMenu({ ...menuPosition(event, entries.length), entries });
  };

  const renderEntry = (entry: RunStatus) => {
    const active = isActiveRun(entry);
    const viewable = runs[entry.run_id] != null;
    const nonzeroExit = entry.exit_code != null && entry.exit_code !== 0;
    const state = nonzeroExit && entry.state === "exited" ? "failed" : entry.state;
    const stateLabel = nonzeroExit && entry.state === "exited"
      ? t("history.exitCode", { code: entry.exit_code }) : runStateLabel(entry.state);
    const date = new Date(entry.started_at);
    const validDate = Number.isFinite(date.getTime());
    const time = validDate ? date.toLocaleTimeString(i18nLanguage, { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    const details = [entry.label, `${entry.device_name} · ${runStateLabel(entry.state)}`,
      validDate ? date.toLocaleString(i18nLanguage) : entry.started_at,
      entry.exit_code != null && t("history.exitCode", { code: entry.exit_code }), entry.error,
      entry.environment_id && t("history.managed", {
        uv: entry.uv_version ?? "?", python: entry.python_version ?? "?", env: entry.environment_id,
      }),
      !viewable && t("history.outputUnavailable"),
    ].filter(Boolean).join("\n");
    return <li key={entry.run_id} className={`history-entry${activeRunId === entry.run_id ? " selected" : ""}`}
      title={details} onContextMenu={(event) => openEntryMenu(event, entry)}>
      <button className="history-open" disabled={!viewable} aria-pressed={activeRunId === entry.run_id}
        aria-label={`${t("history.viewOutput", { label: entry.label })} · ${entry.device_name} · ${stateLabel}`}
        onClick={() => selectRun(entry.run_id)}>
        <span className={`history-status state-${state}`} aria-hidden="true" />
        <span className="history-text">
          <span className="history-label">{entry.label}</span>
          <span className="history-meta">{entry.device_name}</span>
        </span>
      </button>
      <span className="history-entry-actions">
        {active ? <button className="history-stop danger" aria-label={t("history.stopAria", { label: entry.label })}
          title={t("history.stopAria", { label: entry.label })} disabled={entry.state === "stopping"}
          onClick={() => void api.stopRun(entry.run_id).catch(report)}><span aria-hidden="true">■</span></button>
          : <time className="history-time" dateTime={validDate ? date.toISOString() : undefined}>{time}</time>}
        <button className="history-more" aria-label={t("history.entryActions", { label: entry.label })}
          title={t("history.entryActions", { label: entry.label })} aria-haspopup="menu"
          onClick={(event) => openEntryMenu(event, entry)}>⋯</button>
      </span>
    </li>;
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
      <PanelTitle title={t("history.title")} collapsed={collapsed} onToggle={onToggleCollapse}>
        <button aria-label={t("history.actions")} title={t("history.actions")} aria-haspopup="menu" onClick={openPanelMenu}>⋯</button>
      </PanelTitle>
      {error && <div className="history-error" role="alert"><span>{error}</span>
        <button aria-label={t("history.dismissError")} title={t("history.dismissError")} onClick={() => setError(null)}>×</button>
      </div>}
      {running.length > 0 && <ul className="history-list" aria-label={t("history.running")}>
        {running.map(renderEntry)}
      </ul>}
      {!collapsed && (
        <ul className={`history-list history-completed${running.length > 0 ? " has-running" : ""}`} aria-label={t("history.title")}>
          {history.map(renderEntry)}
          {history.length === 0 && running.length === 0 && <li className="empty">{t("history.empty")}</li>}
        </ul>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
