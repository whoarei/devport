import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, workspaceRefEquals } from "../api";
import { presetRunSessions, useAppStore } from "../store";
import { useWorkspaceRunStore } from "../workspaceRunStore";
import { isActiveRun, runPhaseLabel, runStateLabel } from "../runState";
import { deviceLabel } from "./DeviceDialog";

export function RunToolbar() {
  const { t } = useTranslation();
  const { devices, selectedDeviceId, workspace, activeRunId, runs, starting } = useAppStore();
  const feature = useWorkspaceRunStore();
  const device = devices.find((d) => d.id === selectedDeviceId);
  const active = activeRunId ? runs[activeRunId] : null;
  const session = activeRunId ? feature.sessions[activeRunId] : null;
  const preset = activeRunId ? presetRunSessions.get(activeRunId) : null;
  const known = !!session?.request || !!preset;
  const source = session?.request?.workspace ?? preset?.workspace ?? null;
  const matching = known && workspaceRefEquals(source, workspace);
  const progress = useAppStore((s) => activeRunId ? s.runProgress[activeRunId] : null);
  const warning = activeRunId ? feature.warnings[activeRunId] : null;
  useEffect(() => { if (activeRunId) void feature.recover(activeRunId); }, [activeRunId]);
  return <div className="run-toolbar">
    <div className="run-toolbar-main">
      <label className="run-option-field">{t("workspaceRun.target")}
        <select aria-label={t("run.selectDeviceAria")} value={selectedDeviceId ?? ""} onChange={(e) => feature.selectTarget(e.target.value || null)}>
          <option value="" disabled>{t("run.selectDeviceFirst")}</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{deviceLabel(d)}</option>)}
        </select>
      </label>
      <label className="run-option-field">Python
        <select aria-label={t("workspaceRun.python")} value={selectedDeviceId ? feature.preferences.python[selectedDeviceId] ?? "device_default" : "device_default"} onChange={(e) => feature.selectPython(e.target.value as "project" | "device_default")}>
          <option value="device_default">{t("workspaceRun.system")}</option>
          <option value="project" disabled={device?.transport === "serial"}>{t("workspaceRun.project")}{feature.info?.python_version ? ` · ${feature.info.python_version}` : ""}</option>
        </select>
      </label>
      <button disabled={!workspace} onClick={() => useWorkspaceRunStore.setState({ settingsOpen: true })}>{t("workspaceRun.settings")}</button>
      {feature.checking && <span className="history-meta">{t("workspaceRun.loading")}</span>}
      {feature.info?.project && !feature.checking && <span className="history-meta">{t(feature.cached ? "runnerEntry.cached" : "runnerEntry.notPrepared")}</span>}
      {feature.infoError && <span className="runtime-error" title={feature.infoError}>{t("workspaceRun.invalidConfig")}</span>}
    </div>
    <div className="run-toolbar-options">
      <select className="run-task-select" aria-label={t("run.runningTasksAria")} value={activeRunId ?? ""} onChange={(e) => useAppStore.getState().setActiveRun(e.target.value || null)}>
        <option value="">{t("workspaceRun.hint")}</option>
        {Object.values(runs).map((r) => <option key={r.run_id} value={r.run_id}>{r.label} @ {r.device_name}</option>)}
      </select>
      {active && <span className={`run-state state-${active.state}`} role="status">{active.waiting_workspace ? t("workspaceSync.waiting") : runStateLabel(active.state)}{active.phase ? ` · ${runPhaseLabel(active.phase)}` : ""}{progress ? ` · ${progress}` : ""}{active.exit_code != null ? ` (${active.exit_code})` : ""}</span>}
      <button className="danger" disabled={!active || !isActiveRun(active)} onClick={() => activeRunId && void api.stopRun(activeRunId).catch((e) => feature.reportError(e))}>{t("run.stop")}</button>
      <button disabled={!matching || starting || !selectedDeviceId || !!active && isActiveRun(active) || session?.request?.operation === "prepare" || session?.request?.operation === "rebuild"} title={known && !matching ? t("workspaceRun.workspaceMismatch") : !known ? t("workspaceRun.unknownSource") : undefined} onClick={() => activeRunId && feature.rerun(activeRunId)}>{t("workspaceRun.rerun")}</button>
    </div>
    {session?.launch && <div className="run-launch" title={session.launch.python_path.join("\n")}>
      <strong>{session.launch.environment === "command" ? t("workspaceRun.presetShell") : session.launch.environment === "bash" ? "Bash" : session.launch.environment === "project" ? t("workspaceRun.project") : t("workspaceRun.system")}</strong>
      <code>{session.launch.program}</code>{session.launch.version && <span>{session.launch.version}</span>}<span>cwd: {session.launch.cwd}</span>
    </div>}
    {preset && !session?.launch && <div className="run-launch">{t("workspaceRun.presetShell")}</div>}
    {warning && <div className="workspace-error" role="alert"><span>{t("workspaceRun.historyUnsaved")} · {warning}</span><button onClick={() => activeRunId && void api.retryWorkspaceHistory(activeRunId).then(() => feature.recover(activeRunId))}>{t("workspaceRun.retry")}</button></div>}
    {active?.error && <div className="runtime-error">{active.error}</div>}
    {feature.launchError && <div className="workspace-error" role="alert"><span>{feature.launchError}</span><button onClick={() => useWorkspaceRunStore.setState({ launchError: null })}>{t("workspaceRun.close")}</button></div>}
  </div>;
}
