import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, RunRequest } from "../api";
import { loadPresets, newPresetId, normalizePresets, PresetCommand, savePresets } from "../presetCommands";
import { useAppStore } from "../store";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { ContextMenu, contextMenuPosition, MenuState } from "./ContextMenu";
import { PanelTitle } from "./PanelTitle";
import { Icon } from "./Icon";
import { preserveContentFocus } from "../focus";
import { deviceDisplayNames } from "../workspacePresentation";

/** 编辑草稿；id 为 null 表示新增 */
interface PresetDraft {
  id: string | null;
  name: string;
  command: string;
  consoleMode: "pty" | "pipe";
  timeoutSecs: number;
}

const emptyDraft = (): PresetDraft => ({ id: null, name: "", command: "", consoleMode: "pty", timeoutSecs: 0 });

/** 新增 / 编辑预置命令的模态对话框：命令可能很长或是多行，用 textarea 编辑。 */
function PresetEditDialog({ draft, onChange, onSave, onCancel }: {
  draft: PresetDraft | null;
  onChange: (draft: PresetDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const commandInput = useRef<HTMLTextAreaElement>(null);
  // draft 每次击键都会换成新对象，不能作为 effect 依赖，否则焦点会一直被抢回命令框；
  // 只在打开 / 关闭（null 与非 null 切换）时处理 showModal / 初始聚焦。
  const open = draft != null;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) element.showModal();
      commandInput.current?.focus();
    } else if (element.open) {
      element.close();
    }
  }, [open]);
  const valid = draft != null && draft.command.trim() !== "";
  return (
    <dialog
      className="preset-dialog"
      ref={dialog}
      aria-labelledby="preset-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h3 id="preset-dialog-title">{draft?.id ? t("commands.editTitle") : t("commands.addTitle")}</h3>
      <label>
        {t("commands.nameLabel")}
        <input
          placeholder={t("commands.namePlaceholder")}
          value={draft?.name ?? ""}
          onChange={(event) => draft && onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        {t("commands.commandLabel")}
        <textarea
          ref={commandInput}
          rows={5}
          placeholder={t("commands.commandPlaceholder")}
          value={draft?.command ?? ""}
          onChange={(event) => draft && onChange({ ...draft, command: event.target.value })}
        />
      </label>
      <div className="preset-dialog-row">
        <select
          value={draft?.consoleMode ?? "pty"}
          title={t("run.consoleModeTitle")}
          onChange={(event) => draft && onChange({ ...draft, consoleMode: event.target.value as "pty" | "pipe" })}
        >
          <option value="pty">pty</option>
          <option value="pipe">pipe</option>
        </select>
        <input
          type="number"
          min={0}
          title={t("run.timeoutTitle")}
          value={draft?.timeoutSecs ?? 0}
          onChange={(event) => draft && onChange({ ...draft, timeoutSecs: Number(event.target.value) || 0 })}
        />
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>{t("dialog.cancel")}</button>
        <button type="button" className="primary" disabled={!valid} onClick={onSave}>{t("commands.save")}</button>
      </div>
    </dialog>
  );
}

export function CommandsPanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<PresetCommand[]>(loadPresets);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PresetCommand | null>(null);
  const launching = useRef(false);
  const devices = useAppStore((s) => s.devices);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const busy = useAppStore((s) => s.starting || s.loading || s.saving || s.guarding || s.updating || s.workspaceMutating);
  const targetName = selectedDeviceId ? deviceDisplayNames(devices).get(selectedDeviceId) : undefined;
  const report = (error: unknown) => useAppStore.setState({ editorError: errorMessage(error) });

  const update = (next: PresetCommand[]) => {
    const normalized = normalizePresets(next);
    setPresets(normalized);
    savePresets(normalized);
  };

  // 双击直接对当前选中的设备执行；串口设备只有合并输出，强制 pty
  const runPreset = async (preset: PresetCommand) => {
    const state = useAppStore.getState();
    if (launching.current || state.starting || state.loading || state.saving || state.guarding || state.updating || state.workspaceMutating) return;
    if (!state.selectedDeviceId) {
      useAppStore.setState({ editorError: t("run.selectDeviceFirst") });
      return;
    }
    const device = state.devices.find((d) => d.id === state.selectedDeviceId);
    const request: RunRequest = {
      device_id: state.selectedDeviceId,
      workspace: state.workspace,
      kind: "command",
      command: preset.command,
      console_mode: device?.transport === "serial" ? "pty" : preset.consoleMode,
      timeout_secs: preset.timeoutSecs,
    };
    launching.current = true;
    try {
      await state.startRun(request);
    } catch (error) {
      report(error);
    } finally {
      launching.current = false;
    }
  };

  const openEntryMenu = (event: MouseEvent, preset: PresetCommand) => {
    event.preventDefault();
    event.stopPropagation();
    const entries = [
      { label: t("commands.run"), disabled: busy || !targetName, onSelect: () => void runPreset(preset) },
      {
        label: t("commands.edit"),
        onSelect: () => setDraft({
          id: preset.id, name: preset.name, command: preset.command,
          consoleMode: preset.consoleMode, timeoutSecs: preset.timeoutSecs,
        }),
      },
      { label: t("commands.delete"), danger: true, onSelect: () => setConfirmDelete(preset) },
    ];
    const rect = event.currentTarget.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({ ...contextMenuPosition(keyboard ? rect.left : event.clientX, keyboard ? rect.bottom : event.clientY, entries.length), entries });
  };

  // 标题栏右键：添加预置命令（与 ＋ 按钮一致）
  const openTitleMenu = (event: MouseEvent) => {
    event.preventDefault();
    const entries = [
      { label: t("commands.add"), onSelect: () => setDraft(emptyDraft()) },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  const saveDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!command) return;
    if (draft.id) {
      update(presets.map((preset) => preset.id === draft.id
        ? { ...preset, name, command, consoleMode: draft.consoleMode, timeoutSecs: draft.timeoutSecs }
        : preset));
    } else {
      update([...presets, { id: newPresetId(), name, command, consoleMode: draft.consoleMode, timeoutSecs: draft.timeoutSecs }]);
    }
    setDraft(null);
  };

  const confirmRequest: ConfirmRequest | null = useMemo(() => confirmDelete ? {
    title: t("commands.deleteTitle"),
    message: t("commands.deleteMessage", { name: confirmDelete.name || confirmDelete.command }),
    confirmLabel: t("commands.deleteConfirm"),
    danger: true,
    onCancel: () => setConfirmDelete(null),
    onConfirm: () => {
      setConfirmDelete(null);
      update(presets.filter((preset) => preset.id !== confirmDelete.id));
    },
  } : null, [confirmDelete, presets, t]);

  return (
    <div className="commands-panel">
      <PanelTitle title={t("commands.title")} collapsed={collapsed} onToggle={onToggleCollapse}
        onContextMenu={openTitleMenu}>
        <button type="button" aria-label={t("commands.add")} title={t("commands.add")}
          onClick={() => setDraft(emptyDraft())}><Icon name="plus" /></button>
      </PanelTitle>
      {!collapsed && (
        <ul className="commands-list">
          {presets.map((preset) => (
            <li key={preset.id} title={`${preset.command}\n${t("commands.runHint")}`}
              onContextMenu={(event) => openEntryMenu(event, preset)}>
              <div className="commands-content" onDoubleClick={() => void runPreset(preset)}>
              <span className="commands-label">{preset.name || preset.command}</span>
              <span className="commands-meta">
                {preset.name && `${preset.command} · `}{preset.consoleMode}{preset.timeoutSecs > 0 ? ` · ${preset.timeoutSecs}s` : ""}
              </span>
              </div>
              <button type="button" className="command-action command-run" disabled={busy || !targetName}
                onMouseDown={preserveContentFocus}
                aria-label={t("commands.runOn", { name: preset.name || preset.command, device: targetName ?? t("run.selectDeviceFirst") })}
                title={targetName ? t("commands.runOn", { name: preset.name || preset.command, device: targetName }) : t("run.selectDeviceFirst")}
                onClick={(event) => { if (event.detail < 2) void runPreset(preset); }}><Icon name="play" /></button>
              <button type="button" className="command-action" aria-label={t("commands.more", { name: preset.name || preset.command })}
                title={t("commands.more", { name: preset.name || preset.command })} aria-haspopup="menu"
                onClick={(event) => openEntryMenu(event, preset)}><Icon name="more" /></button>
            </li>
          ))}
          {presets.length === 0 && <li className="empty">{t("commands.empty")}</li>}
        </ul>
      )}
      <PresetEditDialog draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
