import { useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { api, inferKind, RunRequest, ScriptKind } from "../api";
import { useAppStore } from "../store";
import { anyDirty } from "../editorDocument";
import { isActiveRun, runStateLabel } from "../runState";
import { collectScripts } from "../workspaceTree";
import { deviceLabel } from "./DeviceDialog";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";

export function RunToolbar() {
  const { t } = useTranslation();
  const {
    selectedDeviceId,
    devices,
    selectDevice,
    workspaceDir,
    workspaceTree,
    activeFile,
    activeRunId,
    runs,
  } = useAppStore(useShallow((s) => ({ selectedDeviceId: s.selectedDeviceId, devices: s.devices,
    selectDevice: s.selectDevice,
    workspaceDir: s.workspaceDir, workspaceTree: s.workspaceTree, activeFile: s.activeFile,
    activeRunId: s.activeRunId, runs: s.runs })));

  const { mode, entry, argsText, command, consoleMode, timeoutSecs } = useAppStore((s) => s.runDraft);
  const setDraft = useAppStore((s) => s.setRunDraft);
  const [busy, setBusy] = useState(false);
  const dirty = useAppStore(anyDirty);
  const editorBusy = useAppStore((s) => s.loading || s.saving || s.starting || s.guarding);
  const isSerial = devices.find((device) => device.id === selectedDeviceId)?.transport === "serial";
  const effectiveConsoleMode = isSerial ? "pty" : consoleMode;

  const activeRun = activeRunId ? runs[activeRunId] : null;
  const running =
    activeRun &&
    ["preparing", "syncing", "starting", "running", "stopping"].includes(activeRun.state);


  const effectiveEntry = entry || activeFile || "";

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
          workspace_dir: workspaceDir,
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
          workspace_dir: workspaceDir,
          kind,
          entry: effectiveEntry,
          args,
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
      {Object.values(runs).some(isActiveRun) && <select aria-label={t("run.runningTasksAria")} value={activeRun && isActiveRun(activeRun) ? activeRunId! : ""}
        onChange={(e) => { if (e.target.value) useAppStore.getState().setActiveRun(e.target.value); }}>
        <option value="">{t("run.runningTasks")}</option>
        {Object.values(runs).filter(isActiveRun).map((r) => <option key={r.run_id} value={r.run_id}>{r.label} @ {r.device_name}</option>)}
      </select>}
      <select aria-label={t("run.selectDeviceAria")} value={selectedDeviceId ?? ""} onChange={(e) => selectDevice(e.target.value || null)}>
        {devices.length === 0 && <option value="">{t("run.noDevicesHint")}</option>}
        {devices.map((d) => (
          <option key={d.id} value={d.id}>{deviceLabel(d)}{d.is_default ? t("device.defaultSuffix") : ""}</option>
        ))}
      </select>
      <select value={mode} onChange={(e) => setDraft({ mode: e.target.value as "script" | "command" })}>
        <option value="script">{t("run.modeScript")}</option>
        <option value="command">{t("run.modeCommand")}</option>
      </select>

      {mode === "script" ? (
        <select value={effectiveEntry} onChange={(e) => setDraft({ entry: e.target.value })}>
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
          placeholder={t("run.commandPlaceholder")}
          value={command}
          onChange={(e) => setDraft({ command: e.target.value })}
        />
      )}

      {mode === "script" && (
        <input
          className="args-input"
          placeholder={t("run.argsPlaceholder")}
          value={argsText}
          onChange={(e) => setDraft({ argsText: e.target.value })}
        />
      )}

      <select
        value={effectiveConsoleMode}
        disabled={isSerial}
        title={isSerial ? t("run.serialConsoleTitle") : t("run.consoleModeTitle")}
        onChange={(e) => setDraft({ consoleMode: e.target.value as "pty" | "pipe" })}
      >
        <option value="pty">{isSerial ? t("run.serialConsole") : "pty"}</option>
        {!isSerial && <option value="pipe">pipe</option>}
      </select>

      <input
        className="timeout-input"
        type="number"
        min={0}
        title={t("run.timeoutTitle")}
        value={timeoutSecs}
        onChange={(e) => setDraft({ timeoutSecs: Number(e.target.value) || 0 })}
      />

      {running ? (
        <button className="danger" onClick={stop}>
          {t("run.stop")}
        </button>
      ) : (
        <button className="run-start" disabled={busy || editorBusy || !selectedDeviceId} onClick={run}>
          {dirty ? t("run.saveAndRun") : t("run.run")}
        </button>
      )}

      {activeRun && (
        <span className={`run-state state-${activeRun.state}`}>
          {runStateLabel(activeRun.state)}
          {activeRun.exit_code != null && ` (${activeRun.exit_code})`}
          {activeRun.error && ` — ${activeRun.error}`}
        </span>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
