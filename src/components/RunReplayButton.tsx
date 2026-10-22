import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { RunStatus } from "../api";
import { useAppStore } from "../store";
import { isActiveRun } from "../runState";
import { useRunHistoryStore } from "../runHistoryStore";
import { ContextMenu, type MenuState } from "./ContextMenu";

export function RunReplayButton({ run, compact = false }: { run: RunStatus | null; compact?: boolean }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<Pick<MenuState, "x" | "y"> | null>(null);
  const { devices, selectedDeviceId, starting, updating } = useAppStore(useShallow(s => ({ devices: s.devices, selectedDeviceId: s.selectedDeviceId, starting: s.starting, updating: s.updating })));
  const state = useRunHistoryStore();
  const current = devices.find(d => d.id === selectedDeviceId);
  const disabled = !run?.replay || !!run && isActiveRun(run) || starting || updating || state.busy;
  return <div className={`run-replay-button${compact ? " compact" : ""}`}>
    <button type="button" disabled={disabled} title={run?.replay ? t("runHistory.originalTooltip", { device: run.device_name }) : t("runHistory.legacy")}
      aria-label={t("runHistory.originalTooltip", { device: run?.device_name ?? "" })} onClick={() => run && void state.rerun(run, "original")}>
      {compact ? "▶" : t("runHistory.restart")}
    </button>
    <button type="button" disabled={!run?.replay || starting || updating || state.busy} title={t("runHistory.more")} aria-label={t("runHistory.more")} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setAnchor(anchor ? null : { x: rect.left, y: rect.bottom + 3 }); }}>▾</button>
    {anchor && <ContextMenu menu={{ ...anchor, entries: [
        { label: t("runHistory.current"), detail: current?.name ?? "—", disabled: disabled || !current, onSelect: () => run && void state.rerun(run, "current") },
        { label: t("runHistory.edit"), disabled: disabled, onSelect: () => run && state.edit(run) },
      ] }} onClose={() => setAnchor(null)} />}
  </div>;
}
