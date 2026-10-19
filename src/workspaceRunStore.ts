import { create } from "zustand";
import { api, errorMessage, workspaceRefEquals, type CommandSource, type PythonSelection, type RunEvent, type RunStatus, type RunnerConfigState, type WorkspaceCommand, type WorkspaceCommands, type WorkspaceExecutionSettings, type WorkspacePythonInfo, type WorkspaceRef, type WorkspaceRunRequest, type WorkspaceRunSession } from "./api";
import { getWorkspaceGeneration, presetRunSessions, useAppStore } from "./store";
import { anyDirty } from "./editorDocument";
import { workspaceKey, workspaceSourceRevision, commandLabel, pythonVersionMatches } from "./workspaceRun";
import { revealConsolePanel } from "./consoleTabs";
import { useTerminalStore } from "./terminalStore";
import i18n from "./i18n";
import { isActiveRun, newestStatus } from "./runState";

type Preferences = { target?: string; python: Record<string, PythonSelection>; bash: Record<string, string>; console_mode: "pty" | "pipe"; timeout_secs: number; env: Record<string, string> };
const defaults = (): Preferences => ({ python: {}, bash: {}, console_mode: "pty", timeout_secs: 0, env: {} });
function readPreferences(key: string): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem(`runner.settings.v1:${key}`) ?? "null");
    const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
    return { target: typeof p?.target === "string" ? p.target : undefined,
      python: Object.fromEntries(Object.entries(object(p?.python)).filter(([,v]) => v === "project" || v === "device_default")) as Preferences["python"],
      bash: Object.fromEntries(Object.entries(object(p?.bash)).filter(([,v]) => typeof v === "string" && ["bash","gitbash","msys2"].includes(v))) as Record<string,string>,
      env: Object.fromEntries(Object.entries(object(p?.env)).filter(([k,v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("\0"))) as Record<string,string>,
      console_mode: p?.console_mode === "pipe" ? "pipe" : "pty", timeout_secs: Number.isSafeInteger(p?.timeout_secs) && p.timeout_secs >= 0 ? p.timeout_secs : 0 };
  } catch { return defaults(); }
}
export type ArgsDraft = { workspace: WorkspaceRef; command: WorkspaceCommand; source?: CommandSource; module: boolean; editingId?: string };
export type EnvironmentPreparation = { token: number; workspace: WorkspaceRef; sourceRevision: string | null; deviceId: string; deviceRevision?: string; deviceName: string; rebuild: boolean; runId: string | null; status: RunStatus | null; stopping: boolean; error: string | null };
export const preparationActive = (p: EnvironmentPreparation | null) => !!p && (p.runId ? !p.status || isActiveRun(p.status) : !p.error);
interface State {
  key: string; sourceRevision: string | null; config: RunnerConfigState | null; configError: string | null; commands: WorkspaceCommands | null; historyError: string | null;
  preferences: Preferences; info: WorkspacePythonInfo | null; infoError: string | null; checking: boolean; cached: boolean;
  settingsOpen: boolean; args: ArgsDraft | null; history: { workspace: WorkspaceRef; source?: CommandSource } | null;
  sessions: Record<string, WorkspaceRunSession>; warnings: Record<string, string | null>; launchError: string | null;
  preparation: EnvironmentPreparation | null;
  load: () => Promise<void>; refreshCommands: () => Promise<void>; refreshConfig: () => Promise<boolean>; check: () => Promise<void>;
  reportError: (error: unknown) => void;
  preference: (patch: Partial<Preferences>) => void; selectTarget: (id: string | null) => void; selectPython: (python: PythonSelection) => void;
  start: (command: WorkspaceCommand, source?: CommandSource, workspace?: WorkspaceRef, operation?: WorkspaceRunRequest["operation"]) => Promise<string>;
  run: (command: WorkspaceCommand, source?: CommandSource, workspace?: WorkspaceRef) => void;
  prepare: (rebuild?: boolean) => Promise<void>; cancelPreparation: () => Promise<void>; syncPreparation: () => void;
  events: (events: RunEvent[]) => void; recover: (id: string) => Promise<void>; rerun: (id: string) => void;
}
let loadEpoch = 0, checkEpoch = 0, historyEpoch = 0, configEpoch = 0, preparationToken = 0;
export function workspaceSourceCurrent(workspace: WorkspaceRef, revision: string | null): boolean {
  const app = useAppStore.getState(), state = useWorkspaceRunStore.getState();
  return workspaceRefEquals(workspace, app.workspace) && state.key === workspaceKey(workspace)
    && state.sourceRevision === revision && workspaceSourceRevision(workspace, app.devices) === revision;
}
export const useWorkspaceRunStore = create<State>((set, get) => ({
  key: "none", sourceRevision: null, config: null, configError: null, commands: null, historyError: null, preferences: defaults(), info: null, infoError: null, checking: false, cached: false,
  settingsOpen: false, args: null, history: null, sessions: {}, warnings: {}, launchError: null, preparation: null,
  reportError: (error) => { set({ launchError: errorMessage(error) }); revealConsolePanel(); useTerminalStore.getState().select("run"); },
  load: async () => {
    const app = useAppStore.getState(), workspace = app.workspace, key = workspaceKey(workspace), epoch = ++loadEpoch;
    const sourceRevision = workspaceSourceRevision(workspace, app.devices);
    const previousSource = get().sourceRevision;
    const sourceChanged = key === get().key && previousSource !== null && previousSource !== "missing" && sourceRevision !== previousSource;
    ++checkEpoch;
    ++configEpoch;
    ++historyEpoch;
    const preferences = sourceChanged ? get().preferences : readPreferences(key);
    set({ key, sourceRevision, preferences, config: null, configError: null, commands: null, historyError: null, info: null, infoError: null, checking: false, args: null, history: null, launchError: null });
    if (!workspace) return;
    const { devices, selectedDeviceId } = useAppStore.getState();
    const target = sourceChanged ? (devices.some((d) => d.id === selectedDeviceId) ? selectedDeviceId : null)
      : devices.find((d) => d.id === preferences.target)?.id ?? (workspace.type === "device" ? devices.find((d) => d.id === workspace.device_id)?.id : undefined) ?? devices.find((d) => d.is_default)?.id ?? selectedDeviceId;
    useAppStore.getState().selectDevice(target ?? null);
    await Promise.all([get().refreshConfig(), get().refreshCommands()]);
    if (epoch !== loadEpoch || !workspaceSourceCurrent(workspace, sourceRevision)) return;
    void get().check();
  },
  refreshCommands: async () => {
    const app = useAppStore.getState(), w = app.workspace, epoch = ++historyEpoch;
    const sourceRevision = workspaceSourceRevision(w, app.devices), previous = get().commands;
    if (!w) return;
    const current = () => epoch === historyEpoch && workspaceSourceCurrent(w, sourceRevision) && previous === get().commands;
    try { const commands = await api.listWorkspaceCommands(w); if (current()) set({ commands, historyError: null }); }
    catch (e) { if (current()) set({ historyError: errorMessage(e) }); }
  },
  refreshConfig: async () => {
    const app = useAppStore.getState(), workspace = app.workspace, epoch = ++configEpoch, previous = get().config;
    const sourceRevision = workspaceSourceRevision(workspace, app.devices);
    if (!workspace) return false;
    const current = () => epoch === configEpoch && workspaceSourceCurrent(workspace, sourceRevision) && previous === get().config;
    try {
      const config = await api.readRunnerConfig(workspace);
      if (!current()) return false;
      set({ config, configError: null });
      return true;
    } catch (error) {
      if (current()) set({ configError: errorMessage(error) });
      return false;
    }
  },
  check: async () => {
    const { workspace, selectedDeviceId, devices } = useAppStore.getState(), epoch = ++checkEpoch;
    const key = workspaceKey(workspace), device = devices.find((d) => d.id === selectedDeviceId), revision = device?.revision;
    const sourceRevision = workspaceSourceRevision(workspace, devices);
    set({ info: null, infoError: null, checking: true, cached: false });
    if (!workspace) { set({ checking: false }); return; }
    try {
      const info = await api.inspectWorkspacePython(workspace, !!selectedDeviceId && get().preferences.python[selectedDeviceId] === "project");
      let cached = false;
      if (info.project && selectedDeviceId && epoch === checkEpoch) {
        const environments = await api.listProjectEnvironments(selectedDeviceId).catch(() => []);
        cached = environments.some((e) => e.ready && e.manifest && pythonVersionMatches(info.project!.python_version, e.manifest.python_version) && e.manifest.lock_sha256 === info.project!.lock_sha256 && JSON.stringify(e.manifest.groups) === JSON.stringify(info.project!.groups) && JSON.stringify(e.manifest.extras) === JSON.stringify(info.project!.extras));
      }
      if (epoch === checkEpoch && key === get().key && workspaceSourceCurrent(workspace, sourceRevision) && selectedDeviceId === useAppStore.getState().selectedDeviceId && revision === useAppStore.getState().devices.find((d) => d.id === selectedDeviceId)?.revision) set({ info, checking: false, cached });
    } catch (e) { if (epoch === checkEpoch && key === get().key && workspaceSourceCurrent(workspace, sourceRevision) && selectedDeviceId === useAppStore.getState().selectedDeviceId && revision === useAppStore.getState().devices.find((d) => d.id === selectedDeviceId)?.revision) set({ infoError: errorMessage(e), checking: false }); }
  },
  preference: (patch) => { const preferences = { ...get().preferences, ...patch }; set({ preferences }); try { localStorage.setItem(`runner.settings.v1:${get().key}`, JSON.stringify(preferences)); } catch { /* Session settings remain usable. */ } },
  selectTarget: (id) => { useAppStore.getState().selectDevice(id); get().preference({ target: id ?? undefined }); set({ info: null, infoError: null }); void get().check(); },
  selectPython: (python) => { const id = useAppStore.getState().selectedDeviceId; if (id) { get().preference({ python: { ...get().preferences.python, [id]: python } }); void get().check(); } },
  start: async (command, source, origin, operation = "run") => {
    set({ launchError: null });
    const initial = useAppStore.getState(), workspace = origin ?? initial.workspace, generation = getWorkspaceGeneration(), sourceRevision = get().sourceRevision;
    if (!workspace || !workspaceRefEquals(workspace, initial.workspace)) throw new Error(i18n.t("run.errorWorkspaceChanged"));
    if (initial.updating) throw new Error(i18n.t("run.errorUpdating"));
    if (initial.loading || initial.saving || initial.starting || initial.guarding || initial.workspaceMutating) throw new Error(i18n.t("run.errorFileBusy"));
    if (!initial.selectedDeviceId) { set({ settingsOpen: true }); throw new Error(i18n.t("run.selectDeviceFirst")); }
    useAppStore.setState({ starting: true });
    try {
      if (!await initial.saveAllDirty() || anyDirty(useAppStore.getState())) throw new Error(i18n.t("run.errorSaveIncomplete"));
      const app = useAppStore.getState(), state = get();
      if (generation !== getWorkspaceGeneration() || !workspaceSourceCurrent(workspace, sourceRevision)) throw new Error(i18n.t("run.errorWorkspaceChanged"));
      if (state.configError || !state.config) throw new Error(state.configError ?? i18n.t("workspaceRun.loading"));
      const device = app.devices.find((d) => d.id === app.selectedDeviceId);
      if (!device?.revision) throw new Error(i18n.t("run.selectDeviceFirst"));
      const p = state.preferences;
      const settings: WorkspaceExecutionSettings = { cwd: state.config.config.run_defaults.cwd, env: { ...p.env }, console_mode: device.transport === "serial" ? "pty" : p.console_mode, timeout_secs: p.timeout_secs, ...app.consoleSize, bash: p.bash[device.id] || undefined };
      const request: WorkspaceRunRequest = { workspace: structuredClone(workspace), config_revision: state.config.revision === "session" ? undefined : state.config.revision, device_id: device.id, device_revision: device.revision, command: { entry: structuredClone(command.entry), args: command.args.slice() }, source, python: operation !== "run" ? "project" : p.python[device.id] ?? "device_default", settings, operation };
      if (operation !== "run") set((s) => ({ preparation: s.preparation ? { ...s.preparation, deviceId: device.id, deviceRevision: device.revision, deviceName: device.name } : null }));
      const id = await api.runWorkspace(request);
      set((s) => ({ sessions: { ...s.sessions, [id]: { request, launch: s.sessions[id]?.launch ?? null, warning: s.warnings[id] ?? null } } }));
      if (operation !== "run") set((s) => ({ preparation: s.preparation ? { ...s.preparation, runId: id } : null }));
      if (!useAppStore.getState().runs[id]) {
        const status = await api.getRunStatus(id).catch(() => null);
        if (status) useAppStore.getState().handleRunEvent({ type: "status", status });
      }
      if (operation === "run") { useAppStore.getState().setActiveRun(id); revealConsolePanel(); useTerminalStore.getState().select("run"); }
      else get().syncPreparation();
      void get().recover(id);
      return id;
    } finally { useAppStore.setState({ starting: false }); }
  },
  run: (command, source, workspace) => { void get().start(command, source, workspace).catch((e) => get().reportError(e)); },
  prepare: async (rebuild = false) => {
    if (preparationActive(get().preparation) || useAppStore.getState().starting) return;
    const app = useAppStore.getState(), workspace = app.workspace;
    if (!workspace) return;
    const device = app.devices.find((d) => d.id === app.selectedDeviceId), token = ++preparationToken;
    set({ settingsOpen: true, launchError: null, preparation: { token, workspace: structuredClone(workspace), sourceRevision: get().sourceRevision, deviceId: device?.id ?? "", deviceRevision: device?.revision, deviceName: device?.name ?? "", rebuild, runId: null, status: null, stopping: false, error: null } });
    try { await get().start({ entry: { type: "python_module", name: "__runner_prepare__" }, args: [] }, undefined, workspace, rebuild ? "rebuild" : "prepare"); }
    catch (e) { set((s) => ({ preparation: s.preparation?.token === token ? { ...s.preparation, error: errorMessage(e) } : s.preparation })); }
  },
  cancelPreparation: async () => {
    const p = get().preparation;
    if (!p?.runId || !preparationActive(p) || p.stopping || p.status?.state === "stopping") return;
    set({ preparation: { ...p, stopping: true, error: null } });
    try { await api.stopRun(p.runId); }
    catch (e) { set((s) => ({ preparation: s.preparation?.token === p.token && preparationActive(s.preparation) ? { ...s.preparation, stopping: false, error: errorMessage(e) } : s.preparation })); }
  },
  syncPreparation: () => {
    const p = get().preparation, app = useAppStore.getState();
    if (!p?.runId || !app.runs[p.runId]) return;
    const status = newestStatus(p.status ?? undefined, app.runs[p.runId]);
    if (status === p.status) return;
    set({ preparation: { ...p, status, stopping: isActiveRun(status) && p.stopping, error: isActiveRun(status) ? p.error : null } });
    if ((!p.status || isActiveRun(p.status)) && !isActiveRun(status)
      && workspaceSourceCurrent(p.workspace, p.sourceRevision) && app.selectedDeviceId === p.deviceId
      && app.devices.find((d) => d.id === p.deviceId)?.revision === p.deviceRevision) void get().check();
  },
  events: (events) => {
    for (const e of events) {
      if (e.type === "launch") set((s) => ({ sessions: { ...s.sessions, [e.run_id]: { ...s.sessions[e.run_id], launch: e.launch } } }));
      if (e.type === "workspace_state") {
        set((s) => ({ warnings: { ...s.warnings, [e.run_id]: e.warning } }));
        if (workspaceRefEquals(e.workspace, useAppStore.getState().workspace)) void get().refreshCommands();
      }
      if (e.type === "resync") { const id = useAppStore.getState().activeRunId; if (id) void get().recover(id); }
    }
    if (events.some((e) => e.type === "status" || e.type === "resync")) {
      get().syncPreparation();
      const keep = new Set(Object.keys(useAppStore.getState().runs));
      set((s) => ({ sessions: Object.fromEntries(Object.entries(s.sessions).filter(([id]) => keep.has(id))), warnings: Object.fromEntries(Object.entries(s.warnings).filter(([id]) => keep.has(id))) }));
    }
  },
  recover: async (id) => { try { const session = await api.getWorkspaceRun(id); if (session) set((s) => ({ sessions: { ...s.sessions, [id]: session }, warnings: { ...s.warnings, [id]: session.warning } })); } catch { /* Legacy run has no workspace session. */ } },
  rerun: (id) => {
    const session = get().sessions[id], preset = presetRunSessions.get(id);
    if (session?.request && (!session.request.operation || session.request.operation === "run") && workspaceRefEquals(session.request.workspace, useAppStore.getState().workspace)) get().run(session.request.command, session.request.source ?? undefined, session.request.workspace);
    else if (preset && workspaceRefEquals(preset.workspace ?? null, useAppStore.getState().workspace)) void useAppStore.getState().startRun(preset).catch((e) => get().reportError(e));
  },
}));
