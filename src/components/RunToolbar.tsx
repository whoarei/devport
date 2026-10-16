import { useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { api, inferKind, RunRequest, ScriptKind } from "../api";
import { useAppStore } from "../store";
import { anyDirty } from "../editorDocument";
import { isActiveRun, runPhaseLabel, runStateLabel } from "../runState";
import { collectScripts } from "../workspaceTree";
import { deviceLabel } from "./DeviceDialog";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";

/** Managed Python 不支持同设备原地运行（工作区就在目标设备上，没有本地暂存目录可 inspect） */
export function managedPythonBlocked(
  workspaceDeviceId: string | null,
  targetDeviceId: string | null,
): boolean {
  return !!workspaceDeviceId && workspaceDeviceId === targetDeviceId;
}

export function RunToolbar() {
  const { t } = useTranslation();
  const {
    selectedDeviceId,
    devices,
    selectDevice,
    workspace,
    workspaceTree,
    activeFile,
    activeRunId,
    runs,
  } = useAppStore(useShallow((s) => ({ selectedDeviceId: s.selectedDeviceId, devices: s.devices,
    selectDevice: s.selectDevice,
    workspace: s.workspace, workspaceTree: s.workspaceTree, activeFile: s.activeFile,
    activeRunId: s.activeRunId, runs: s.runs })));

  const { mode, entry, argsText, command, managed, consoleMode, timeoutSecs } = useAppStore((s) => s.runDraft);
  const setDraft = useAppStore((s) => s.setRunDraft);
  const [busy, setBusy] = useState(false);
  const dirty = useAppStore(anyDirty);
  const editorBusy = useAppStore((s) => s.loading || s.saving || s.starting || s.guarding);
  const isSerial = devices.find((device) => device.id === selectedDeviceId)?.transport === "serial";
  const effectiveConsoleMode = isSerial ? "pty" : consoleMode;
  // 同设备原地运行：工作区所在设备与运行目标相同，此时禁用 Managed Python
  const inPlace = managedPythonBlocked(
    workspace?.type === "device" ? workspace.device_id : null,
    selectedDeviceId,
  );

  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running =
    activeRun &&
    ["preparing", "syncing", "starting", "running", "stopping"].includes(activeRun.state);
  const progress = useAppStore((s) => (activeRunId ? s.runProgress[activeRunId] : undefined));


  const effectiveEntry = entry || activeFile || "";
  const isPythonEntry = effectiveEntry.toLowerCase().endsWith(".py");

  const run = async () => {
    if (!selectedDeviceId) {
      alert(t("run.selectDeviceFirst"));
      return;
    }
    setBusy(true);
    try {
      const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      let request: RunRequest;
      if (mode === "command") {
        if (!command.trim()) return;
        request = {
          device_id: selectedDeviceId,
          workspace,
          kind: "command",
          command: command.trim(),
          console_mode: effectiveConsoleMode,
          timeout_secs: timeoutSecs,
        };
      } else {
        if (!effectiveEntry) {
          alert(t("run.selectEntry"));
          return;
        }
        const kind: ScriptKind = inferKind(effectiveEntry);
        if (kind === "command") {
          alert(t("run.unsupportedScript"));
          return;
        }
        request = {
          device_id: selectedDeviceId,
          workspace,
          kind,
          entry: effectiveEntry,
          args,
          managed_python: kind === "python" && managed && !isSerial && !inPlace,
          console_mode: effectiveConsoleMode,
          timeout_secs: timeoutSecs,
        };
      }
      await useAppStore.getState().startRun(request);
    } catch (e) {
      alert(t("run.startFailed", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      if (activeRunId) await api.stopRun(activeRunId);
    } catch (e) { alert(t("run.stopFailed", { message: String(e) })); }
  };

  // 右键菜单：空白区弹出运行控制；输入框/下拉/按钮上保留原生编辑菜单
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("input, select, button, textarea")) return;
    event.preventDefault();
    const entries: MenuEntry[] = [
      { label: t("ctxmenu.run"), disabled: !!running || busy || editorBusy || !selectedDeviceId, onSelect: () => void run() },
      { label: t("ctxmenu.stopRun"), danger: true, disabled: !running, onSelect: () => void stop() },
      "separator",
      { label: t("ctxmenu.clearInputs"), disabled: !command && !argsText, onSelect: () => setDraft({ command: "", argsText: "" }) },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  const scriptFiles = collectScripts(workspaceTree);

  return (
    <div className="run-toolbar" onContextMenu={openMenu}>
      <div className="run-toolbar-main">
        <select className="run-device-select" aria-label={t("run.selectDeviceAria")} value={selectedDeviceId ?? ""} onChange={(e) => selectDevice(e.target.value || null)}>
          {devices.length === 0 && <option value="">{t("run.noDevicesHint")}</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>{deviceLabel(d)}{d.is_default ? t("device.defaultSuffix") : ""}</option>
          ))}
        </select>
        <select className="run-mode-select" aria-label={t("run.modeAria")} value={mode} onChange={(e) => setDraft({ mode: e.target.value as "script" | "command" })}>
          <option value="script">{t("run.modeScript")}</option>
          <option value="command">{t("run.modeCommand")}</option>
        </select>

        {mode === "script" ? (
          <select className="run-entry-select" aria-label={t("run.selectEntry")} title={effectiveEntry || t("run.selectEntryPlaceholder")} value={effectiveEntry} onChange={(e) => setDraft({ entry: e.target.value })}>
            <option value="">{t("run.selectEntryPlaceholder")}</option>
            {scriptFiles.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="command-input"
            aria-label={t("run.modeCommand")}
            placeholder={t("run.commandPlaceholder")}
            value={command}
            onChange={(e) => setDraft({ command: e.target.value })}
          />
        )}

        {mode === "script" && (
          <input
            className="args-input"
            aria-label={t("run.argsPlaceholder")}
            placeholder={t("run.argsPlaceholder")}
            value={argsText}
            onChange={(e) => setDraft({ argsText: e.target.value })}
          />
        )}

        {running ? (
          <button className="run-action danger" onClick={stop}>
            {t("run.stop")}
          </button>
        ) : (
          <button className="run-action run-start" disabled={busy || editorBusy || !selectedDeviceId} onClick={run}>
            {dirty ? t("run.saveAndRun") : t("run.run")}
          </button>
        )}
      </div>

      <div className="run-toolbar-options">
        {mode === "script" && isPythonEntry && (
          <label
            className={`managed-toggle${isSerial || inPlace ? " disabled" : ""}`}
            title={inPlace ? t("run.managedInPlaceTitle") : isSerial ? t("run.managedSerialTitle") : t("run.managedTitle")}
          >
            <input
              type="checkbox"
              checked={managed && !isSerial && !inPlace}
              disabled={isSerial || inPlace}
              onChange={(e) => setDraft({ managed: e.target.checked })}
            />
            <span>{t("run.managedLabel")}</span>
          </label>
        )}

        <label className="run-option-field">
          <span>{t("run.consoleModeLabel")}</span>
          <select
            value={effectiveConsoleMode}
            disabled={isSerial}
            title={isSerial ? t("run.serialConsoleTitle") : t("run.consoleModeTitle")}
            onChange={(e) => setDraft({ consoleMode: e.target.value as "pty" | "pipe" })}
          >
            <option value="pty">{isSerial ? t("run.serialConsole") : "pty"}</option>
            {!isSerial && <option value="pipe">pipe</option>}
          </select>
        </label>

        <label className="run-option-field" title={t("run.timeoutTitle")}>
          <span>{t("run.timeoutLabel")}</span>
          <input
            className="timeout-input"
            type="number"
            min={0}
            title={t("run.timeoutTitle")}
            value={timeoutSecs}
            onChange={(e) => setDraft({ timeoutSecs: Number(e.target.value) || 0 })}
          />
          <span>{t("run.secondsUnit")}</span>
        </label>

        {Object.values(runs).some(isActiveRun) && <select className="run-task-select" aria-label={t("run.runningTasksAria")} value={activeRun && isActiveRun(activeRun) ? activeRunId! : ""}
          onChange={(e) => { if (e.target.value) useAppStore.getState().setActiveRun(e.target.value); }}>
          <option value="">{t("run.runningTasks")}</option>
          {Object.values(runs).filter(isActiveRun).map((r) => <option key={r.run_id} value={r.run_id}>{r.label} @ {r.device_name}</option>)}
        </select>}

        {activeRun && activeRun.state !== "exited" && (
          <span className={`run-state state-${activeRun.state}`} role="status">
            {runStateLabel(activeRun.state)}
            {activeRun.phase && ` · ${runPhaseLabel(activeRun.phase)}`}
            {progress && ` · ${progress}`}
            {activeRun.exit_code != null && ` (${activeRun.exit_code})`}
            {activeRun.error && ` — ${activeRun.error}`}
          </span>
        )}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
