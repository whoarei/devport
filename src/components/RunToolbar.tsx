import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { presetRunSessions, useAppStore } from "../store";
import { useWorkspaceRunStore } from "../workspaceRunStore";
import { isActiveRun, runPhaseLabel, runStateLabel } from "../runState";
import { deviceLabel } from "./DeviceEditor";
import { RunReplayButton } from "./RunReplayButton";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";
import { Icon } from "./Icon";
import { RunElapsed } from "./RunElapsed";
import { useShallow } from "zustand/react/shallow";
import { preserveContentFocus } from "../focus";
import { openQuickSsh } from "../quickSsh";
import { SaveTemporaryDevice } from "./SaveTemporaryDevice";
import { needsWorkspaceCopy } from "../workspaceRun";
import { deviceDisplayNames } from "../workspacePresentation";
import { historyArgs, historyCommand } from "../runHistory";

export function RunToolbar() {
  const { t } = useTranslation();
  const detailsId = useId();
  const [detailsRunId, setDetailsRunId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ deviceId: string; message: string } | null>(null);
  const { devices, selectedDeviceId, workspace, activeRunId, active } = useAppStore(useShallow((s) => ({
    devices: s.devices, selectedDeviceId: s.selectedDeviceId, workspace: s.workspace,
    activeRunId: s.activeRunId, active: s.activeRunId ? s.runs[s.activeRunId] : null,
  })));
  const feature = useWorkspaceRunStore();
  const device = devices.find((d) => d.id === selectedDeviceId);
  const deviceNames = deviceDisplayNames(devices);
  const running = useAppStore((s) => Object.values(s.runs).some(isActiveRun));
  const syncBlocked = useAppStore((s) => s.updating || s.loading || s.saving || s.starting || s.guarding || s.workspaceMutating);
  const canSync = workspace && device?.revision && needsWorkspaceCopy(workspace, device);
  const session = activeRunId ? feature.sessions[activeRunId] : null;
  const preset = activeRunId ? presetRunSessions.get(activeRunId) : null;
  const launch = session?.launch ?? active?.replay?.launch;
  const progress = useAppStore((s) => activeRunId ? s.runProgress[activeRunId] : null);
  const warning = activeRunId ? feature.warnings[activeRunId] : null;
  const live = active && isActiveRun(active);
  const detailsOpen = detailsRunId !== null && detailsRunId === activeRunId;
  const sync = active?.workspace_sync;
  const replay = active?.replay;
  const args = replay ? historyArgs(replay) : [];
  const runContext = { area: "run" as const, runId: active?.run_id };
  useEffect(() => {
    setDetailsRunId(null);
    if (activeRunId) void feature.recover(activeRunId);
  }, [activeRunId, feature.recover]);

  return <div className="run-toolbar">
    <div className="run-toolbar-strip">
      <div className="run-target">
        <select aria-label={t("run.selectDeviceAria")} title={device ? deviceLabel(device) : t("run.selectDeviceFirst")} value={selectedDeviceId ?? ""} onChange={(e) => e.target.value === "__quick_ssh__" ? openQuickSsh() : feature.selectTarget(e.target.value || null)}>
          <option value="" disabled>{t("run.selectDeviceFirst")}</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{deviceNames.get(d.id)}</option>)}
          <option value="__quick_ssh__">{t("quickSsh.title")}…</option>
        </select>
        {device?.temporary && <SaveTemporaryDevice key={device.id} device={device}
          onSaveErrorChange={(message) => setSaveError(message ? { deviceId: device.id, message } : null)} />}
        {canSync && <button type="button" className="run-tool run-sync" disabled={syncBlocked || running} onMouseDown={preserveContentFocus}
          aria-label={t("workspaceSync.action")} title={t(running ? "workspaceSync.running" : "workspaceSync.action")}
          onClick={() => void feature.syncWorkspace()}><Icon name="refresh" /><span>{t("workspaceSync.action")}</span></button>}
        <button type="button" className={feature.infoError ? "run-tool has-error" : "run-tool"} disabled={!workspace}
          aria-label={t("workspaceRun.settings")} aria-haspopup="dialog"
          title={feature.infoError ? `${t("workspaceRun.settings")} · ${t("workspaceRun.invalidConfig")}` : t("workspaceRun.settings")}
          onClick={() => useWorkspaceRunStore.setState({ settingsOpen: true })}><Icon name="config" /></button>
      </div>
      {active && <div className="run-task-actions">
        {live && <>
          <span className={`run-state state-${active.state}`} role="status">{runStateLabel(active.state)}</span>
          <RunElapsed run={active} />
        </>}
        <button type="button" className="run-tool run-details-toggle"
          aria-label={t("console.runDetails")} title={t("console.runDetails")} aria-controls={detailsId} aria-expanded={detailsOpen}
          onClick={() => setDetailsRunId(detailsOpen ? null : active.run_id)}>
          <Icon name="info" />
        </button>
        {live
          ? <button type="button" className="danger" disabled={!appCommandEnabled("stop", runContext)}
            onMouseDown={preserveContentFocus}
            title={shortcutTitle(t("run.stop"), "stop")}
            onClick={() => void executeAppCommand("stop", runContext)}>{t("run.stop")}</button>
          : !active.workspace_sync_only && <RunReplayButton run={active} standalone />}
      </div>}
    </div>
    {device?.temporary && saveError?.deviceId === device.id && <div className="runtime-error" role="alert">{saveError.message}</div>}
    {live && (active.waiting_workspace || active.phase || progress) && <div className="run-activity" role="status">
      {[active.waiting_workspace ? t("workspaceSync.waiting") : null, active.phase ? runPhaseLabel(active.phase) : null, progress].filter(Boolean).join(" · ")}
    </div>}
    {active && <dl className="run-task-details" id={detailsId} hidden={!detailsOpen}>
      {!active.workspace_sync_only && <><dt>{t("runHistory.command")}</dt><dd><code>{(replay ? historyCommand(replay) : preset?.command) || active.label}</code></dd></>}
      {args.length > 0 && <><dt>{t("runHistory.args")}</dt><dd><code>{JSON.stringify(args)}</code></dd></>}
      <dt>{t("runHistory.device")}</dt><dd>{active.device_name}</dd>
      {(launch || preset) && <><dt>{t("runHistory.environment")}</dt><dd>
        {launch?.environment === "bash" ? "Bash" : launch?.environment === "project" ? t("workspaceRun.project")
          : launch?.environment === "device_default" ? t("workspaceRun.system") : t("workspaceRun.presetShell")}
        {launch?.program && <> · <code>{launch.program}</code></>}{launch?.version && ` · ${launch.version}`}
      </dd></>}
      {launch && <><dt>{t("runHistory.cwd")}</dt><dd><code>{launch.cwd}</code></dd></>}
      {launch && launch.python_path.length > 0 && <><dt>{t("workspaceRun.pythonPath")}</dt><dd><code>{launch.python_path.join("\n")}</code></dd></>}
      {sync && <><dt>{t("workspaceSync.action")}</dt><dd>
        {t("workspaceSync.summary", { ...sync, bytes: sync.uploaded_bytes.toLocaleString() })}<br /><code>{sync.destination}</code>
      </dd></>}
    </dl>}
    {warning && <div className="workspace-error" role="alert"><span>{t("workspaceRun.historyUnsaved")} · {warning}</span><button onMouseDown={preserveContentFocus} onClick={() => activeRunId && void api.retryWorkspaceHistory(activeRunId).then(() => feature.recover(activeRunId))}>{t("workspaceRun.retry")}</button></div>}
    {active?.error && <div className="runtime-error">{active.error.includes("workspace copy is unavailable or incomplete; use Sync Workspace first") ? t("workspaceSync.required") : active.error}</div>}
    {feature.launchError && <div className="workspace-error" role="alert"><span>{feature.launchError}</span><button onMouseDown={preserveContentFocus} onClick={() => useWorkspaceRunStore.setState({ launchError: null })}>{t("workspaceRun.close")}</button></div>}
  </div>;
}
