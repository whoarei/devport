import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { presetRunSessions, useAppStore } from "../store";
import { useWorkspaceRunStore } from "../workspaceRunStore";
import { runPhaseLabel, runStateLabel } from "../runState";
import { deviceLabel } from "./DeviceDialog";
import { RunReplayButton } from "./RunReplayButton";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";

export function RunToolbar() {
  const { t } = useTranslation();
  const { devices, selectedDeviceId, workspace, activeRunId, runs } = useAppStore();
  const feature = useWorkspaceRunStore();
  const device = devices.find((d) => d.id === selectedDeviceId);
  const active = activeRunId ? runs[activeRunId] : null;
  const session = activeRunId ? feature.sessions[activeRunId] : null;
  const preset = activeRunId ? presetRunSessions.get(activeRunId) : null;
  const launch = session?.launch ?? active?.replay?.launch;
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
      {feature.checking && <span className="secondary-text">{t("workspaceRun.loading")}</span>}
      {feature.info?.project && !feature.checking && <span className="secondary-text">{t(feature.cached ? "runnerEntry.cached" : "runnerEntry.notPrepared")}</span>}
      {feature.infoError && <span className="runtime-error" title={feature.infoError}>{t("workspaceRun.invalidConfig")}</span>}
    </div>
    <div className="run-toolbar-options">
      <span className="run-latest-task" aria-label={t("runHistory.latest")} title={active ? `${active.label} @ ${active.device_name}` : undefined}>{active ? `${active.label} @ ${active.device_name}` : t("runHistory.noLatest")}</span>
      {active && <span className={`run-state state-${active.state}`} role="status">{active.waiting_workspace ? t("workspaceSync.waiting") : runStateLabel(active.state)}{active.phase ? ` · ${runPhaseLabel(active.phase)}` : ""}{progress ? ` · ${progress}` : ""}{active.exit_code != null ? ` (${active.exit_code})` : ""}</span>}
      <button className="danger" disabled={!appCommandEnabled("stop", { area: "run", runId: activeRunId ?? undefined })}
        title={shortcutTitle(`${t("run.stop")}${active ? ` · ${active.label} @ ${active.device_name}` : ""}`, "stop")}
        onClick={() => void executeAppCommand("stop", { area: "run", runId: activeRunId ?? undefined })}>{t("run.stop")}</button>
      <RunReplayButton run={active} />
    </div>
    {launch && <div className="run-launch" title={launch.python_path.join("\n")}>
      <strong>{launch.environment === "command" ? t("workspaceRun.presetShell") : launch.environment === "bash" ? "Bash" : launch.environment === "project" ? t("workspaceRun.project") : t("workspaceRun.system")}</strong>
      <code>{launch.program}</code>{launch.version && <span>{launch.version}</span>}<span>cwd: {launch.cwd}</span>
    </div>}
    {preset && !launch && <div className="run-launch">{t("workspaceRun.presetShell")}</div>}
    {warning && <div className="workspace-error" role="alert"><span>{t("workspaceRun.historyUnsaved")} · {warning}</span><button onClick={() => activeRunId && void api.retryWorkspaceHistory(activeRunId).then(() => feature.recover(activeRunId))}>{t("workspaceRun.retry")}</button></div>}
    {active?.error && <div className="runtime-error">{active.error}</div>}
    {feature.launchError && <div className="workspace-error" role="alert"><span>{feature.launchError}</span><button onClick={() => useWorkspaceRunStore.setState({ launchError: null })}>{t("workspaceRun.close")}</button></div>}
  </div>;
}
