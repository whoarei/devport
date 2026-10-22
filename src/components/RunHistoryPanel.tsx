import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { RunStatus } from "../api";
import { useAppStore } from "../store";
import { historyArgs, historyCommand, historyEntries } from "../runHistory";
import { isActiveRun, runStateLabel } from "../runState";
import { useRunHistoryStore } from "../runHistoryStore";
import { PanelTitle } from "./PanelTitle";
import { RunReplayButton } from "./RunReplayButton";
import { RunHistoryPreview } from "./RunHistoryPreview";
import { ContextMenu, type MenuEntry, type MenuState } from "./ContextMenu";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";

export function RunHistoryPanel({ visible, collapsed, onToggleCollapse }: { visible: boolean; collapsed: boolean; onToggleCollapse: () => void }) {
  const { t } = useTranslation();
  const { runs, workspace } = useAppStore(useShallow(s => ({ runs: s.runs, workspace: s.workspace, updating: s.updating })));
  const state = useRunHistoryStore();
  const [all, setAll] = useState(false), [menu, setMenu] = useState<MenuState | null>(null);
  const [preview, setPreview] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(), hide = useRef<ReturnType<typeof setTimeout>>();
  const tooltipId = useId();
  const clear = useCallback(() => { clearTimeout(timer.current); clearTimeout(hide.current); }, []);
  const close = useCallback(() => { clear(); setPreview(null); }, [clear]);
  const keep = useCallback(() => clearTimeout(hide.current), []);
  const leave = useCallback(() => { clearTimeout(timer.current); hide.current = setTimeout(() => setPreview(null), 100); }, []);
  useEffect(() => { close(); setMenu(null); return clear; }, [visible, collapsed, workspace, all, close, clear]);
  const entries = historyEntries(runs, workspace, all);
  const completed = entries.filter(run => !isActiveRun(run));
  const clearEntry: MenuEntry = {
    label: t(all ? "runHistory.clearAll" : "runHistory.clearWorkspace"), danger: true,
    disabled: state.historyBusy || !completed.length, onSelect: () => void state.clear(completed),
  };
  const hover = (run: RunStatus, anchor: HTMLElement) => {
    clear(); setPreview(null); const rect = (anchor.closest(".run-history-row") ?? anchor).getBoundingClientRect();
    timer.current = setTimeout(() => setPreview({ id: run.run_id, anchor: rect }), 400);
  };
  return <div className="run-history-panel" onContextMenu={e => {
    e.preventDefault(); close(); setMenu({ x: e.clientX, y: e.clientY, entries: [clearEntry] });
  }}>
    <PanelTitle title={t("runHistory.title")} collapsed={collapsed} onToggle={onToggleCollapse} />
    {!collapsed && <>
      <select className="history-scope" aria-label={t("runHistory.title")} value={all ? "all" : "workspace"} onChange={e => { close(); setAll(e.target.value === "all"); }}>
        <option value="workspace">{t("runHistory.currentWorkspace")}</option><option value="all">{t("runHistory.allWorkspaces")}</option>
      </select>
      <ul className="run-history-list" onScroll={close}>
        {entries.map(run => <li key={run.run_id} data-shortcut-run-id={run.run_id} className={`run-history-row${state.detailId === run.run_id ? " selected" : ""}`}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close(); setMenu({ x: e.clientX, y: e.clientY, entries: [
            { label: t("runHistory.delete"), danger: true, disabled: state.historyBusy || isActiveRun(run), onSelect: () => void state.remove(run) },
            "separator", clearEntry,
          ] }); }}>
          <button type="button" className="history-record" aria-label={t("runHistory.showDetails", { name: run.label })} aria-describedby={preview?.id === run.run_id ? tooltipId : undefined}
            onMouseEnter={e => hover(run, e.currentTarget)} onMouseLeave={leave} onFocus={e => hover(run, e.currentTarget)} onBlur={close} onClick={() => { close(); state.view(run.run_id); }}>
            <span className="history-command">{run.replay ? historyCommand(run.replay) : run.label}{run.replay && historyArgs(run.replay).length > 0 && <span className="history-args"> {historyArgs(run.replay).map(a => JSON.stringify(a)).join(" ")}</span>}</span>
            <span className="history-meta"><span className={`history-status state-${run.state}`}>{runStateLabel(run.state)}</span> · {run.device_name} · {run.started_at ? new Date(run.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
          </button>
          <div className="history-row-actions" onMouseEnter={close}>
            {isActiveRun(run) ? <button type="button" className="history-stop" disabled={!appCommandEnabled("stop", { area: "history", runId: run.run_id })}
              title={shortcutTitle(`${t("run.stop")} · ${run.label} @ ${run.device_name}`, "stop")} aria-label={`${t("run.stop")} · ${run.label} @ ${run.device_name}`}
              onClick={() => void executeAppCommand("stop", { area: "history", runId: run.run_id })}>■</button> : <RunReplayButton run={run} compact />}
          </div>
        </li>)}
        {!entries.length && <li className="empty">{t("runHistory.empty")}</li>}
      </ul>
    </>}
    {state.error && <div className="history-error" role="alert">{state.error}</div>}
    {visible && !collapsed && !menu && preview && runs[preview.id] && <RunHistoryPreview run={runs[preview.id]} anchor={preview.anchor} id={tooltipId} close={close} keep={keep} leave={leave} />}
    {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
  </div>;
}
