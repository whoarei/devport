import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { api, errorMessage, workspaceRefEquals, type WorkspaceRef } from "./api";
import { dirtyTab, withTab } from "./editorDocument";
import { useAppStore } from "./store";
import { loadTransferDirectories, rememberTransferDirectory, rememberedDeviceDirectory, type TransferDirectories } from "./transferDirectories";
import { appendEndpoint, sameTransferFilename, transferActive, transferApi, workspaceTransferPath, type TransferDirectory, type TransferSummary, type TransferPlan } from "./transferApi";
import type { TransferOptions } from "./environmentState";
import { workspaceSourceRevision } from "./workspaceRun";
import i18n from "./i18n";

interface BrowserState { endpoint: WorkspaceRef | null; directory: TransferDirectory | null; selected: string[]; loading: boolean; error: string | null; generation: number; sourceRevision: string | null }
type Side = "local" | "device";
const emptyBrowser = (): BrowserState => ({ endpoint: null, directory: null, selected: [], loading: false, error: null, generation: 0, sourceRevision: null });
interface State {
  options: TransferOptions;
  local: BrowserState; device: BrowserState; tasks: TransferSummary[]; error: string | null;
  plan: TransferPlan | null; planning: boolean;
  deviceMutating: boolean;
  registeredIds: string[];
  completionNotices: Record<string, number>;
  directories: TransferDirectories;
  openDevice: (id: string) => Promise<void>;
  resetDeviceRoot: (id: string) => Promise<void>;
  restore: () => void;
  register: (id: string) => void;
  browse: (side: Side, endpoint: WorkspaceRef, selection?: string[]) => Promise<void>;
  select: (side: Side, paths: string[]) => void;
  prepare: (side: Side, excludeProjectFiles: boolean, paths?: string[]) => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: () => void;
  refresh: () => Promise<void>;
  seed: (workspace?: WorkspaceRef, path?: string) => void;
}

export const useTransferStore = create<State>((set, get) => ({
  options: { device_id: null, hidden: false, exclude: false },
  local: emptyBrowser(), device: emptyBrowser(), tasks: [], error: null, plan: null, planning: false, deviceMutating: false, registeredIds: [], completionNotices: {},
  directories: loadTransferDirectories(),
  register: (id) => set((s) => ({ registeredIds: [...s.registeredIds.filter((old) => old !== id), id].slice(-100) })),
  browse: async (side, endpoint, selection = []) => {
    const generation = get()[side].generation + 1;
    const sourceRevision = workspaceSourceRevision(endpoint, useAppStore.getState().devices);
    set({ [side]: { ...get()[side], endpoint, directory: null, selected: [], loading: true, error: null, generation } });
    try {
      const directory = await transferApi.list(endpoint);
      if (get()[side].generation !== generation) return;
      if (workspaceSourceRevision(endpoint, useAppStore.getState().devices) !== sourceRevision) throw new Error(i18n.t("transfer.directoryChanged"));
      const directories = rememberTransferDirectory(get().directories, directory.endpoint);
      set({ directories, [side]: { endpoint: directory.endpoint, directory, selected: selection.filter((name) => directory.entries.some((entry) => entry.name === name)), loading: false, error: null, generation, sourceRevision } });
      if (side === "device" && directory.endpoint.type === "device") set({ options: { ...get().options, device_id: directory.endpoint.device_id } });
    } catch (error) {
      if (get()[side].generation === generation) set({ [side]: { ...get()[side], loading: false, error: errorMessage(error) } });
    }
  },
  openDevice: async (id) => {
    set({ options: { ...get().options, device_id: id || null } });
    const device = useAppStore.getState().devices.find((d) => d.id === id && ["ssh", "wsl"].includes(d.transport));
    if (device) await get().browse("device", { type: "device", device_id: id, path: rememberedDeviceDirectory(get().directories, id) ?? device.workspace_root });
    else set({ device: { ...emptyBrowser(), generation: get().device.generation + 1 } });
  },
  resetDeviceRoot: async (id) => {
    if (get().deviceMutating || get().device.loading) return;
    const device = useAppStore.getState().devices.find((d) => d.id === id && ["ssh", "wsl"].includes(d.transport));
    if (device?.workspace_root.trim()) await get().browse("device", { type: "device", device_id: id, path: device.workspace_root });
  },
  restore: () => {
    const state = useAppStore.getState();
    const workspace = state.workspace;
    if (!get().local.endpoint && get().local.generation === 0) {
      const dir = get().directories.local ?? (workspace?.type === "local" ? workspace.dir : null);
      if (dir) void get().browse("local", { type: "local", dir });
    }
    if (!get().device.endpoint && get().device.generation === 0) {
      const hosts = state.devices.filter((d) => ["ssh", "wsl"].includes(d.transport));
      const device = hosts.find((d) => d.id === get().options.device_id)
        ?? hosts.find((d) => workspace?.type === "device" && d.id === workspace.device_id)
        ?? hosts.find((d) => d.id === state.selectedDeviceId) ?? hosts[0];
      if (device) {
        const path = rememberedDeviceDirectory(get().directories, device.id)
          ?? (workspace?.type === "device" && workspace.device_id === device.id ? workspace.path : device.workspace_root);
        void get().browse("device", { type: "device", device_id: device.id, path });
      }
    }
  },
  select: (side, selected) => set({ [side]: { ...get()[side], selected } }),
  prepare: async (side, excludeProjectFiles, paths) => {
    const state = get();
    if (state.planning || state.plan || state.deviceMutating) return;
    const source = state[side], target = state[side === "local" ? "device" : "local"];
    const selected = (paths ?? source.selected).slice();
    if (source.loading || target.loading || !source.directory || !target.directory || !selected.length) return;
    set({ planning: true, error: null });
    try {
      const editor = useAppStore.getState();
      const selectedDirty = editor.workspace && editor.openTabs.some((tab) => {
        const path = workspaceTransferPath(editor.workspace!, tab.name, source.directory!.endpoint);
        return dirtyTab(tab) && path !== null && selected.some((entry) => path === entry || path.startsWith(`${entry}/`));
      });
      if (selectedDirty && !await editor.confirmAllUnsaved()) return;
      const current = useAppStore.getState();
      const protectedPaths = current.workspace ? current.openTabs.map((tab) => workspaceTransferPath(current.workspace!, tab.name, target.directory!.endpoint)).filter((p): p is string => p !== null) : [];
      const plan = await transferApi.plan({ source: source.directory.endpoint, target: target.directory.endpoint, paths: selected, exclude_project_files: excludeProjectFiles, protected_paths: protectedPaths });
      set({ plan });
    } catch (error) { set({ error: errorMessage(error) }); }
    finally { set({ planning: false }); }
  },
  discard: () => { const plan = get().plan; set({ plan: null }); if (plan) void transferApi.discard(plan.id).catch(() => {}); },
  retry: async (id) => {
    if (get().planning || get().plan || get().deviceMutating) return;
    set({ planning: true, error: null });
    try { set({ plan: await transferApi.retry(id) }); }
    catch (error) { set({ error: errorMessage(error) }); }
    finally { set({ planning: false }); }
  },
  refresh: async () => {
    const before = get().tasks;
    const tasks = await transferApi.snapshot();
    const previous = get().tasks;
    const merged = tasks.map((task) => {
      const existing = previous.find((old) => old.id === task.id);
      return existing && existing.sequence > task.sequence ? existing : task;
    });
    merged.push(...previous.filter((task) => !tasks.some((old) => old.id === task.id) && before.find((old) => old.id === task.id)?.sequence !== task.sequence));
    const now = Date.now();
    const notices = Object.fromEntries(Object.entries(get().completionNotices).filter(([id, until]) => until > now && merged.some((task) => task.id === id)));
    for (const task of merged) {
      const old = previous.find((item) => item.id === task.id);
      if (task.state === "completed" && ((old && transferActive(old.state)) || (!old && get().registeredIds.includes(task.id)))) notices[task.id] ??= now + 5000;
    }
    set({ tasks: merged, completionNotices: notices });
    for (const task of merged) {
      if (transferActive(task.state)) continue;
      const old = previous.find((t) => t.id === task.id);
      if ((!old || !transferActive(old.state)) && !get().registeredIds.includes(task.id)) continue;
      for (const side of ["local", "device"] as const) {
        const browser = get()[side];
        if (browser.endpoint && workspaceRefEquals(browser.endpoint, task.target)) void get().browse(side, browser.endpoint);
      }
      await refreshWorkspaceAfterTransfer(task);
      set((s) => ({ registeredIds: s.registeredIds.filter((id) => id !== task.id) }));
    }
  },
  seed: (workspace, path) => {
    if (workspace) {
      const side = workspace.type === "local" ? "local" : "device";
      const slash = path?.lastIndexOf("/") ?? -1;
      const parent = slash >= 0 ? path!.slice(0, slash) : "";
      const selection = path ? [path.slice(slash + 1)] : [];
      const endpoint = parent ? parent.split("/").reduce(appendEndpoint, workspace) : workspace;
      void get().browse(side, endpoint, selection);
    }
    // Set the explicit source before mounting the panel can restore remembered directories.
    revealTransferPanel();
    get().restore();
  },
}));

export function revealTransferPanel() {
  const state = useAppStore.getState();
  state.setLayout({ panelVisible: { ...state.layout.panelVisible, transfer: true }, panelCollapsed: { ...state.layout.panelCollapsed, transfer: false } });
}

async function refreshWorkspaceAfterTransfer(task: TransferSummary) {
  const state = useAppStore.getState();
  const workspace = state.workspace;
  if (!workspace || workspace.type !== task.target.type || (workspace.type === "device" && (task.target.type !== "device" || workspace.device_id !== task.target.device_id))) return;
  const detail = await transferApi.task(task.id);
  for (const tab of state.openTabs) {
    const path = workspaceTransferPath(workspace, tab.name, task.target);
    if (path === null || !detail.items.some((item) => item.state === "completed" && item.target_path !== null && sameTransferFilename(item.target_path, path, task.target))) continue;
    const document = await api.readWorkspaceFile(workspace, tab.name).catch(() => null);
    if (!workspaceRefEquals(useAppStore.getState().workspace, workspace)) return;
    useAppStore.setState((s) => ({ openTabs: withTab(s.openTabs, tab.name, (current) => {
      if (!document || dirtyTab(current)) return { ...current, conflict: true };
      return { ...current, fileContent: document.content, savedContent: document.content, revision: document.revision, eol: document.eol, bom: document.bom, conflict: false, generation: current.generation + 1 };
    }) }));
  }
  if (workspaceRefEquals(useAppStore.getState().workspace, workspace)) {
    const dirs = Object.keys(useAppStore.getState().workspaceTree);
    for (const dir of dirs) void useAppStore.getState().loadWorkspaceDir(dir);
  }
}

/** One snapshot at a time; owned by App, so hiding the panel never stops tasks. */
export function pollTransfers() {
  if (!isTauri()) return () => {};
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try { await useTransferStore.getState().refresh(); }
    catch (error) { if (!disposed) useTransferStore.setState({ error: errorMessage(error) }); }
    if (!disposed) timer = setTimeout(poll, useTransferStore.getState().tasks.some((t) => transferActive(t.state)) ? 500 : 2000);
  };
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}
