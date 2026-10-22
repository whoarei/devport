import { create } from "zustand";
import { api, errorMessage, workspaceRefEquals, type RunStatus } from "./api";
import { anyDirty } from "./editorDocument";
import { getWorkspaceGeneration, useAppStore } from "./store";
import { useWorkspaceRunStore } from "./workspaceRunStore";
import { useTerminalStore } from "./terminalStore";
import { revealConsolePanel } from "./consoleTabs";
import { historyDraft, historySettings, historyWorkspace, type HistoryRunDraft } from "./runHistory";
import { isActiveRun, latestExecution } from "./runState";
import { workspaceSourceRevision } from "./workspaceRun";
import i18n from "./i18n";

interface State {
  detailId: string | null;
  draft: HistoryRunDraft | null;
  error: string | null;
  busy: boolean;
  view: (id: string | null) => void;
  edit: (run: RunStatus, notice?: string) => void;
  rerun: (run: RunStatus, target: "original" | "current") => Promise<void>;
  submit: (draft: HistoryRunDraft) => Promise<void>;
  remove: (run: RunStatus) => Promise<void>;
}

/** Replays bypass mutable toolbar preferences; all inputs are validated again by Rust. */
export async function submitHistoryRun(draft: HistoryRunDraft): Promise<string | null> {
  const initial = useAppStore.getState();
  if (initial.updating) throw new Error(i18n.t("run.errorUpdating"));
  if (initial.loading || initial.saving || initial.starting || initial.guarding || initial.workspaceMutating) throw new Error(i18n.t("run.errorFileBusy"));
  const workspace = historyWorkspace(draft.replay);
  const validateDevices = () => {
    const app = useAppStore.getState(), device = app.devices.find(d => d.id === draft.deviceId);
    if (!device?.revision || device.revision !== draft.deviceRevision) throw new Error(i18n.t("runHistory.deviceChanged"));
    if (workspaceSourceRevision(workspace, app.devices) !== draft.sourceRevision) throw new Error(i18n.t("runHistory.sourceChanged"));
    return device;
  };
  validateDevices();
  if (!workspaceRefEquals(workspace, initial.workspace)) {
    await initial.setWorkspace(workspace);
    if (!workspaceRefEquals(workspace, useAppStore.getState().workspace)) return null;
  }
  const ready = useAppStore.getState();
  if (ready.updating || ready.loading || ready.saving || ready.starting || ready.guarding || ready.workspaceMutating) throw new Error(i18n.t("run.errorFileBusy"));
  const generation = getWorkspaceGeneration();
  useAppStore.setState({ starting: true });
  try {
    if (!await useAppStore.getState().saveAllDirty() || anyDirty(useAppStore.getState())) throw new Error(i18n.t("run.errorSaveIncomplete"));
    if (generation !== getWorkspaceGeneration() || !workspaceRefEquals(workspace, useAppStore.getState().workspace)) throw new Error(i18n.t("run.errorWorkspaceChanged"));
    const device = validateDevices(), replay = structuredClone(draft.replay);
    const settings = historySettings(replay);
    if (device.transport === "serial" && settings.console_mode !== "pty") throw new Error(i18n.t("runHistory.serialMode"));
    const size = useAppStore.getState().consoleSize;
    let id: string;
    if (replay.workspace_request) {
      const request = { ...replay.workspace_request, device_id: device.id, device_revision: device.revision!, config_revision: undefined,
        operation: "run" as const, settings: { ...replay.workspace_request.settings, ...size } };
      id = await api.runWorkspace(request, draft.sourceRevision);
      useWorkspaceRunStore.setState(s => ({ sessions: { ...s.sessions, [id]: { request, launch: s.sessions[id]?.launch ?? null, warning: null } } }));
    } else {
      id = await api.runScript({ ...replay.request, device_id: device.id, ...size }, device.revision, draft.sourceRevision);
    }
    const status = await api.getRunStatus(id).catch(() => null);
    if (status) useAppStore.getState().handleRunEvent({ type: "status", status });
    useAppStore.getState().setActiveRun(id);
    revealConsolePanel(); useTerminalStore.getState().select("run");
    return id;
  } finally { useAppStore.setState({ starting: false }); }
}

export const useRunHistoryStore = create<State>((set, get) => ({
  detailId: null, draft: null, error: null, busy: false,
  view: detailId => set({ detailId, error: null }),
  edit: (run, notice) => {
    const draft = historyDraft(run, useAppStore.getState().devices);
    if (!draft) { set({ error: i18n.t("runHistory.legacy") }); return; }
    set({ draft: { ...draft, notice }, error: null });
  },
  rerun: async (run, target) => {
    if (get().busy || isActiveRun(run)) return;
    if (!run.replay) { set({ error: i18n.t("runHistory.legacy") }); return; }
    const app = useAppStore.getState();
    const id = target === "current" ? app.selectedDeviceId ?? "" : run.replay?.request.device_id;
    if (!id) { set({ error: i18n.t("run.selectDeviceFirst") }); return; }
    const draft = historyDraft(run, app.devices, id);
    if (!draft) { set({ error: i18n.t("runHistory.legacy") }); return; }
    if (!draft.deviceRevision || target === "original" && draft.deviceRevision !== run.replay?.device_revision) {
      set({ draft: { ...draft, notice: i18n.t("runHistory.deviceChanged") }, error: null }); return;
    }
    if (draft.sourceRevision !== run.replay?.source_revision) {
      set({ draft: { ...draft, notice: i18n.t("runHistory.sourceChanged") }, error: null }); return;
    }
    await get().submit(draft);
  },
  submit: async draft => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try { const id = await submitHistoryRun(draft); if (id) set({ draft: null, detailId: null }); }
    catch (e) { set({ draft: { ...draft, notice: errorMessage(e) }, error: errorMessage(e) }); }
    finally { set({ busy: false }); }
  },
  remove: async run => {
    if (isActiveRun(useAppStore.getState().runs[run.run_id] ?? run)) return;
    try {
      await api.deleteRunHistory(run.run_id);
      useAppStore.setState(s => {
        const runs = { ...s.runs }, outputBuffers = { ...s.outputBuffers };
        delete runs[run.run_id]; delete outputBuffers[run.run_id];
        return { runs, outputBuffers, history: s.history.filter(r => r.run_id !== run.run_id),
          activeRunId: s.activeRunId === run.run_id ? latestExecution(runs)?.run_id ?? null : s.activeRunId, consoleSeq: s.consoleSeq + 1 };
      });
      set(s => ({ detailId: s.detailId === run.run_id ? null : s.detailId, error: null }));
    } catch (e) { set({ error: errorMessage(e) }); }
  },
}));
