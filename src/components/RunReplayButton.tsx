import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { RunStatus } from "../api";
import { useAppStore } from "../store";
import { useRunHistoryStore } from "../runHistoryStore";
import { ContextMenu, type MenuState } from "./ContextMenu";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";
import { Icon } from "./Icon";

export function RunReplayButton({ run, compact = false, showShortcut = true }: {
  run: RunStatus | null; compact?: boolean; showShortcut?: boolean;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<Pick<MenuState, "x" | "y"> | null>(null);
  const { devices, selectedDeviceId, starting, updating } = useAppStore(useShallow(s => ({ devices: s.devices, selectedDeviceId: s.selectedDeviceId,
    starting: s.starting, updating: s.updating, loading: s.loading, saving: s.saving, guarding: s.guarding, workspaceMutating: s.workspaceMutating })));
  const state = useRunHistoryStore();
  const current = devices.find(d => d.id === selectedDeviceId);
  const context = { area: compact ? "history" as const : "run" as const, runId: run?.run_id };
  const disabled = !appCommandEnabled("rerun", context);
  const title = run?.replay ? `${t("runHistory.originalTooltip", { device: run.device_name })} · ${run.label}` : t("runHistory.legacy");
  return <div className={`run-replay-button${compact ? " compact" : ""}`}>
    <button type="button" disabled={disabled} title={showShortcut ? shortcutTitle(title, "rerun") : title}
      aria-label={t("runHistory.originalTooltip", { device: run?.device_name ?? "" })} onClick={() => void executeAppCommand("rerun", context)}>
      {compact ? <Icon name="play" /> : <><Icon name="play" />{t("runHistory.restart")}</>}
    </button>
    <button type="button" disabled={!run?.replay || starting || updating || state.busy} title={t("runHistory.more")} aria-label={t("runHistory.more")} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 3 }); }}><Icon name="chevronDown" /></button>
    {anchor && <ContextMenu menu={{ ...anchor, entries: [
        { label: t("runHistory.current"), detail: current?.name ?? "—", disabled: disabled || !current, onSelect: () => run && void state.rerun(run, "current") },
        { label: t("runHistory.edit"), disabled: disabled, onSelect: () => run && state.edit(run) },
      ] }} onClose={() => setAnchor(null)} />}
  </div>;
}
