import { create } from "zustand";
import { api, errorMessage, workspaceRefEquals, type DeletedRunHistory, type RunStatus } from "./api";
import { anyDirty } from "./editorDocument";
import { getWorkspaceGeneration, useAppStore } from "./store";
import { useWorkspaceRunStore } from "./workspaceRunStore";
import { useTerminalStore } from "./terminalStore";
import { revealConsolePanel } from "./consoleTabs";
import { historyDraft, historySettings, historyWorkspace, type HistoryRunDraft } from "./runHistory";
import { isActiveRun, latestExecution } from "./runState";
import { workspaceSourceRevision } from "./workspaceRun";
import { useEventStore } from "./eventStore";
import i18n from "./i18n";

interface State {
  detailId: string | null;
  draft: HistoryRunDraft | null;
  error: string | null;
  busy: boolean;
  historyBusy: boolean;
  view: (id: string | null) => void;
  edit: (run: RunStatus, notice?: string) => void;
  rerun: (run: RunStatus, target: "original" | "current") => Promise<void>;
  submit: (draft: HistoryRunDraft) => Promise<void>;
  remove: (run: RunStatus) => Promise<void>;
  clear: (runs: RunStatus[]) => Promise<void>;
}

let historyOperations: Promise<unknown> = Promise.resolve();
const deletedEventId = (id: string) => `history-deleted:${id}`;

function serializeHistory<T>(action: () => Promise<T>): Promise<T> {
  const result = historyOperations.then(async () => {
    useRunHistoryStore.setState({ historyBusy: true });
    try { return await action(); }
    finally { useRunHistoryStore.setState({ historyBusy: false }); }
  });
  historyOperations = result.catch(() => {});
  return result;
}

function hideHistory(ids: string[]) {
  const deleted = new Set(ids);
  useAppStore.setState(s => {
    const runs = Object.fromEntries(Object.entries(s.runs).filter(([id]) => !deleted.has(id)));
    return {
      runs,
      deletedRunIds: new Set([...s.deletedRunIds, ...ids]),
      outputBuffers: Object.fromEntries(Object.entries(s.outputBuffers).filter(([id]) => !deleted.has(id))),
      runProgress: Object.fromEntries(Object.entries(s.runProgress).filter(([id]) => !deleted.has(id))),
      history: s.history.filter(r => !deleted.has(r.run_id)),
      activeRunId: s.activeRunId && deleted.has(s.activeRunId) ? latestExecution(runs)?.run_id ?? null : s.activeRunId,
      consoleSeq: s.consoleSeq + 1,
    };
  });
  useRunHistoryStore.setState(s => ({ detailId: s.detailId && deleted.has(s.detailId) ? null : s.detailId }));
}

function addDeletedHistoryEvent(batch: DeletedRunHistory) {
  useEventStore.getState().add({
    id: deletedEventId(batch.id), timestamp: Date.parse(batch.deleted_at),
    remove: () => serializeHistory(() => api.purgeDeletedRunHistory(batch.id)),
    title: () => i18n.t("runHistory.deleted", { count: batch.run_ids.length }),
    action: { label: () => i18n.t("runHistory.undoDelete"), run: () => serializeHistory(async () => {
      const restored = await api.restoreRunHistory(batch.id);
      useRunHistoryStore.setState({ error: null });
      const ids = new Set(batch.run_ids);
      useAppStore.setState(s => {
        const runs = { ...Object.fromEntries(restored.map(r => [r.run_id, r])), ...s.runs };
        return {
          runs, deletedRunIds: new Set([...s.deletedRunIds].filter(id => !ids.has(id))),
          history: Object.values(runs).filter(r => !isActiveRun(r)).sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? "")).slice(0, 200),
          activeRunId: s.activeRunId ?? latestExecution(runs)?.run_id ?? null,
          consoleSeq: s.consoleSeq + 1,
        };
      });
      // The restore has committed; a refresh failure must not leave a stale Undo action.
      try { await useAppStore.getState().loadRuns(); }
      catch (error) { reportHistoryError("refreshFailed", error); }
    }) },
  });
}

function reportHistoryError(key: "deleteFailed" | "refreshFailed" | "loadDeletedFailed", error: unknown) {
  const message = errorMessage(error);
  useRunHistoryStore.setState({ error: message });
  useEventStore.getState().add({ id: `history-error:${key}`, timestamp: Date.now(), title: () => i18n.t(`runHistory.${key}`), message, level: "error" });
}

export function loadDeletedRunHistoryEvents(): Promise<void> {
  return serializeHistory(async () => {
    try {
      const batches = await api.listDeletedRunHistory();
      const ids = new Set(batches.map(b => deletedEventId(b.id)));
      for (const event of useEventStore.getState().events) {
        if (event.id.startsWith("history-deleted:") && !ids.has(event.id)) useEventStore.getState().dismiss(event.id);
      }
      const newlyHidden = batches.flatMap(b => b.run_ids).filter(id => !useAppStore.getState().deletedRunIds.has(id));
      if (newlyHidden.length) hideHistory(newlyHidden);
      // Keep existing action errors and in-flight action identities during periodic refreshes.
      const existing = new Set(useEventStore.getState().events.map(event => event.id));
      batches.filter(batch => !existing.has(deletedEventId(batch.id))).forEach(addDeletedHistoryEvent);
    } catch (error) { reportHistoryError("loadDeletedFailed", error); }
  });
}

function archiveHistory(records: RunStatus[]): Promise<void> {
  const ids = records.filter(r => !isActiveRun(useAppStore.getState().runs[r.run_id] ?? r)).map(r => r.run_id);
  if (!ids.length) return Promise.resolve();
  return serializeHistory(async () => {
    try {
      const batch = await api.archiveRunHistory(ids);
      if (!batch) return;
      addDeletedHistoryEvent(batch);
      hideHistory(batch.run_ids);
      useRunHistoryStore.setState({ error: null });
    } catch (error) { reportHistoryError("deleteFailed", error); }
  });
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
  detailId: null, draft: null, error: null, busy: false, historyBusy: false,
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
  remove: run => archiveHistory([run]),
  clear: archiveHistory,
}));
