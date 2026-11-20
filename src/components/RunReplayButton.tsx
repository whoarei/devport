import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { RunStatus } from "../api";
import { useAppStore } from "../store";
import { useRunHistoryStore } from "../runHistoryStore";
import { ContextMenu } from "./ContextMenu";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";
import { Icon } from "./Icon";
import { preserveContentFocus } from "../focus";

export function RunReplayButton({ run, compact = false, standalone = false, showShortcut = true }: {
  run: RunStatus | null; compact?: boolean; standalone?: boolean; showShortcut?: boolean;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const { devices, selectedDeviceId, starting, updating } = useAppStore(useShallow(s => ({ devices: s.devices, selectedDeviceId: s.selectedDeviceId,
    starting: s.starting, updating: s.updating, loading: s.loading, saving: s.saving, guarding: s.guarding, workspaceMutating: s.workspaceMutating })));
  const state = useRunHistoryStore();
  const current = devices.find(d => d.id === selectedDeviceId);
  const context = { area: compact ? "history" as const : "run" as const, runId: run?.run_id };
  const disabled = !appCommandEnabled("rerun", context);
  const menuDisabled = !run?.replay || starting || updating || state.busy;
  const original = t("runHistory.originalTooltip", { device: run?.device_name ?? "" });
  let title = t("runHistory.legacy");
  if (run?.replay) title = standalone ? `${t("runHistory.restart")} · ${original}` : `${original} · ${run.label}`;
  const hint = standalone && !disabled ? `\n${t("console.runOptionsHint")}` : "";
  return <div className={`run-replay-button${compact ? " compact" : ""}${standalone ? " standalone" : ""}`}>
    <button type="button" disabled={disabled} title={(showShortcut ? shortcutTitle(title, "rerun") : title) + hint}
      onMouseDown={preserveContentFocus}
      aria-label={original} onClick={() => void executeAppCommand("rerun", context)}
      onContextMenu={standalone ? (event) => {
        event.preventDefault();
        if (!menuDisabled) setAnchor(event.currentTarget);
      } : undefined}>
      <Icon name="play" />{!compact && !standalone && <span>{t("runHistory.restart")}</span>}
    </button>
    {!standalone && <button type="button" disabled={menuDisabled} title={t("runHistory.more")} aria-label={t("runHistory.more")} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}><Icon name="chevronDown" /></button>}
    {anchor && <ContextMenu menu={{ anchor, x: 0, y: 0, entries: [
        { label: t("runHistory.current"), detail: current?.name ?? "—", disabled: disabled || !current, onSelect: () => run && void state.rerun(run, "current") },
        { label: t("runHistory.edit"), disabled: disabled, onSelect: () => run && state.edit(run) },
      ] }} onClose={() => setAnchor(null)} />}
  </div>;
}
