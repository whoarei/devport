import { useEffect } from "react";
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

export function RunToolbar() {
  const { t } = useTranslation();
  const { devices, selectedDeviceId, workspace, activeRunId, active } = useAppStore(useShallow((s) => ({
    devices: s.devices, selectedDeviceId: s.selectedDeviceId, workspace: s.workspace,
    activeRunId: s.activeRunId, active: s.activeRunId ? s.runs[s.activeRunId] : null,
  })));
  const feature = useWorkspaceRunStore();
  const device = devices.find((d) => d.id === selectedDeviceId);
  const session = activeRunId ? feature.sessions[activeRunId] : null;
  const preset = activeRunId ? presetRunSessions.get(activeRunId) : null;
  const launch = session?.launch ?? active?.replay?.launch;
  const progress = useAppStore((s) => activeRunId ? s.runProgress[activeRunId] : null);
  const warning = activeRunId ? feature.warnings[activeRunId] : null;
  useEffect(() => { if (activeRunId) void feature.recover(activeRunId); }, [activeRunId]);
  return <div className="run-toolbar">
    <div className="run-toolbar-main">
      <label className="run-option-field run-device-field"><span>{t("workspaceRun.target")}</span>
        <select aria-label={t("run.selectDeviceAria")} title={device ? deviceLabel(device) : t("run.selectDeviceFirst")} value={selectedDeviceId ?? ""} onChange={(e) => feature.selectTarget(e.target.value || null)}>
          <option value="" disabled>{t("run.selectDeviceFirst")}</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.transport === "wsl" ? `${d.name} · WSL` : deviceLabel(d)}</option>)}
        </select>
      </label>
      <label className="run-option-field run-python-field"><span>Python</span>
        <select aria-label={t("workspaceRun.python")} value={selectedDeviceId ? feature.preferences.python[selectedDeviceId] ?? "device_default" : "device_default"} onChange={(e) => feature.selectPython(e.target.value as "project" | "device_default")}>
          <option value="device_default">{t("workspaceRun.system")}</option>
          <option value="project" disabled={device?.transport === "serial"}>{t("workspaceRun.project")}{feature.info?.python_version ? ` · ${feature.info.python_version}` : ""}</option>
        </select>
      </label>
      <button className="run-settings" disabled={!workspace} onClick={() => useWorkspaceRunStore.setState({ settingsOpen: true })}><Icon name="config" />{t("workspaceRun.settings")}</button>
      {feature.checking && <span className="secondary-text">{t("workspaceRun.loading")}</span>}
      {feature.info?.project && !feature.checking && <span className="secondary-text">{t(feature.cached ? "runnerEntry.cached" : "runnerEntry.notPrepared")}</span>}
      {feature.infoError && <span className="runtime-error" title={feature.infoError}>{t("workspaceRun.invalidConfig")}</span>}
    </div>
    {active && <div className="run-toolbar-options">
      <span className="run-latest-task" aria-label={t("runHistory.latest")} title={`${active.label} @ ${active.device_name}`}>{`${active.label} @ ${active.device_name}`}</span>
      <span className={`run-state state-${active.state}`} role="status">{runStateLabel(active.state)}{active.exit_code != null ? ` (${active.exit_code})` : ""}</span>
      <RunElapsed run={active} />
      {isActiveRun(active) && <button className="danger" disabled={!appCommandEnabled("stop", { area: "run", runId: activeRunId ?? undefined })}
        onMouseDown={preserveContentFocus}
        title={shortcutTitle(`${t("run.stop")} · ${active.label} @ ${active.device_name}`, "stop")}
        onClick={() => void executeAppCommand("stop", { area: "run", runId: activeRunId ?? undefined })}>{t("run.stop")}</button>}
      <RunReplayButton run={active} />
    </div>}
    {active && isActiveRun(active) && (active.waiting_workspace || active.phase || progress) && <div className="run-activity" role="status">
      <span className="run-activity-indicator" aria-hidden="true" />
      <span>{[active.waiting_workspace ? t("workspaceSync.waiting") : null, active.phase ? runPhaseLabel(active.phase) : null, progress].filter(Boolean).join(" · ")}</span>
    </div>}
    {launch && <div className="run-launch" title={launch.python_path.join("\n")}>
      <strong>{launch.environment === "command" ? t("workspaceRun.presetShell") : launch.environment === "bash" ? "Bash" : launch.environment === "project" ? t("workspaceRun.project") : t("workspaceRun.system")}</strong>
      <code>{launch.program}</code>{launch.version && <span>{launch.version}</span>}<span>cwd: {launch.cwd}</span>
    </div>}
    {preset && !launch && <div className="run-launch">{t("workspaceRun.presetShell")}</div>}
    {warning && <div className="workspace-error" role="alert"><span>{t("workspaceRun.historyUnsaved")} · {warning}</span><button onMouseDown={preserveContentFocus} onClick={() => activeRunId && void api.retryWorkspaceHistory(activeRunId).then(() => feature.recover(activeRunId))}>{t("workspaceRun.retry")}</button></div>}
    {active?.error && <div className="runtime-error">{active.error}</div>}
    {feature.launchError && <div className="workspace-error" role="alert"><span>{feature.launchError}</span><button onMouseDown={preserveContentFocus} onClick={() => useWorkspaceRunStore.setState({ launchError: null })}>{t("workspaceRun.close")}</button></div>}
  </div>;
}
