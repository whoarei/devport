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
import { editorFileSource, editorSourceCurrent } from "./editorSources";
import { INLINE_TRANSFER_NOTICE_MS, loadHiddenTransfers, rememberHiddenTransfers, transferOrigin, type WorkspaceTransferSelection } from "./workspaceTransfers";

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
  planOwner: "panel" | "workspace";
  workspaceTransfer: WorkspaceTransferSelection | null;
  inlinePlanOrigin: WorkspaceTransferSelection | null;
  inlineOrigins: Record<string, WorkspaceTransferSelection>;
  inlineHiddenIds: string[];
  inlineDetailsId: string | null;
  inlineActionError: { id: string; message: string } | null;
  directories: TransferDirectories;
  openDevice: (id: string) => Promise<void>;
  resetDeviceRoot: (id: string) => Promise<void>;
  restore: () => void;
  register: (id: string) => void;
  browse: (side: Side, endpoint: WorkspaceRef, selection?: string[]) => Promise<void>;
  select: (side: Side, paths: string[]) => void;
  prepare: (side: Side, excludeProjectFiles: boolean, paths?: string[]) => Promise<void>;
  retry: (id: string, owner?: "panel" | "workspace") => Promise<void>;
  requestWorkspaceTransfer: (workspace: WorkspaceRef, path: string, directory: boolean) => void;
  prepareWorkspaceTransfer: (target: WorkspaceRef) => Promise<void>;
  clearInlineTransfer: (id: string) => void;
  discard: () => void;
  refresh: () => Promise<void>;
  seed: (workspace?: WorkspaceRef, path?: string) => void;
}

export const useTransferStore = create<State>((set, get) => ({
  options: { device_id: null, hidden: false, exclude: false },
  local: emptyBrowser(), device: emptyBrowser(), tasks: [], error: null, plan: null, planning: false, deviceMutating: false, registeredIds: [], completionNotices: {},
  planOwner: "panel", workspaceTransfer: null, inlinePlanOrigin: null, inlineOrigins: {}, inlineHiddenIds: loadHiddenTransfers(), inlineDetailsId: null, inlineActionError: null,
  directories: loadTransferDirectories(),
  register: (id) => set((s) => ({ registeredIds: [...s.registeredIds.filter((old) => old !== id), id].slice(-100),
    inlineOrigins: s.inlinePlanOrigin ? { ...s.inlineOrigins, [id]: s.inlinePlanOrigin } : s.inlineOrigins })),
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
    await prepareTransfer(source.directory.endpoint, target.directory.endpoint, selected, excludeProjectFiles, "panel", null);
  },
  requestWorkspaceTransfer: (workspace, path, directory) => {
    if (get().planning || get().plan || get().deviceMutating || get().workspaceTransfer || !path) return;
    set({ workspaceTransfer: { workspace, path, directory, revision: workspaceSourceRevision(workspace, useAppStore.getState().devices) }, error: null, planOwner: "workspace" });
  },
  prepareWorkspaceTransfer: async (target) => {
    const selection = get().workspaceTransfer;
    if (!selection || selection.revision !== workspaceSourceRevision(selection.workspace, useAppStore.getState().devices)) {
      set({ error: i18n.t("transfer.directoryChanged") }); return;
    }
    const parts = selection.path.split("/"), name = parts.pop()!;
    const source = parts.reduce(appendEndpoint, selection.workspace);
    await prepareTransfer(source, target, [name], get().options.exclude, "workspace", selection, true);
  },
  clearInlineTransfer: (id) => {
    const task = get().tasks.find((task) => task.id === id);
    if (!task || transferActive(task.state)) return;
    const ids = [...get().inlineHiddenIds.filter((old) => old !== id), id].slice(-100);
    rememberHiddenTransfers(ids);
    set({ inlineHiddenIds: ids, inlineDetailsId: get().inlineDetailsId === id ? null : get().inlineDetailsId });
  },
  discard: () => { const plan = get().plan; set({ plan: null, inlinePlanOrigin: null }); if (plan) void transferApi.discard(plan.id).catch(() => {}); },
  retry: async (id, owner = "panel") => {
    if (get().planning || get().plan || get().deviceMutating) return;
    const task = get().tasks.find((task) => task.id === id);
    set({ planning: true, error: null, planOwner: owner, inlineDetailsId: null, inlineActionError: null });
    try { set({ plan: await transferApi.retry(id), inlinePlanOrigin: owner === "workspace" && task ? transferOrigin(task, get().tasks, get().inlineOrigins) : null }); }
    catch (error) { set({ error: errorMessage(error), ...(owner === "workspace" ? { inlineDetailsId: id, inlineActionError: { id, message: errorMessage(error) } } : {}) }); }
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
      if (task.state === "completed" && ((old && transferActive(old.state)) || (!old && get().registeredIds.includes(task.id)))) notices[task.id] ??= now + INLINE_TRANSFER_NOTICE_MS;
    }
    set({ tasks: merged, completionNotices: notices, inlineOrigins: Object.fromEntries(Object.entries(get().inlineOrigins)
      .filter(([id]) => merged.some((task) => task.id === id) || get().registeredIds.includes(id))) });
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

/** Both entry points use identical unsaved-file and overwrite protection with frozen endpoints. */
async function prepareTransfer(source: WorkspaceRef, target: WorkspaceRef, paths: string[], exclude: boolean, owner: "panel" | "workspace", selection: WorkspaceTransferSelection | null, resolveTarget = false) {
  const store = useTransferStore.getState();
  if (store.planning || store.plan || store.deviceMutating) return;
  const sourceRevision = workspaceSourceRevision(source, useAppStore.getState().devices);
  const targetRevision = workspaceSourceRevision(target, useAppStore.getState().devices);
  const current = () => sourceRevision === workspaceSourceRevision(source, useAppStore.getState().devices)
    && targetRevision === workspaceSourceRevision(target, useAppStore.getState().devices)
    && (!selection || useTransferStore.getState().workspaceTransfer === selection);
  useTransferStore.setState({ planning: true, error: null, planOwner: owner, inlinePlanOrigin: null });
  try {
    if (resolveTarget) {
      const directory = await transferApi.list(target);
      if (!current()) throw new Error(i18n.t("transfer.directoryChanged"));
      if (directory.endpoint.type !== target.type || target.type === "device" && (directory.endpoint.type !== "device" || directory.endpoint.device_id !== target.device_id)) throw new Error(i18n.t("transfer.directoryChanged"));
      target = directory.endpoint;
      useTransferStore.setState((s) => ({ directories: rememberTransferDirectory(s.directories, target) }));
    }
    const editor = useAppStore.getState();
    const selectedDirty = editor.openTabs.some((tab) => {
      const origin = editorFileSource(tab, editor.workspace);
      const path = origin ? workspaceTransferPath(origin.workspace, origin.path, source) : null;
      return dirtyTab(tab) && path !== null && paths.some((entry) => path === entry || path.startsWith(`${entry}/`));
    });
    if (selectedDirty && !await editor.confirmAllUnsaved()) return;
    if (!current()) throw new Error(i18n.t("transfer.directoryChanged"));
    const app = useAppStore.getState();
    const protectedPaths = app.openTabs.map((tab) => { const origin = editorFileSource(tab, app.workspace); return origin ? workspaceTransferPath(origin.workspace, origin.path, target) : null; }).filter((path): path is string => path !== null);
    const plan = await transferApi.plan({ source, target, paths, exclude_project_files: exclude, protected_paths: protectedPaths });
    if (!current()) {
      await transferApi.discard(plan.id).catch(() => {});
      throw new Error(i18n.t("transfer.directoryChanged"));
    }
    useTransferStore.setState({ plan, inlinePlanOrigin: selection, ...(owner === "workspace" ? { workspaceTransfer: null } : {}) });
  } catch (error) { useTransferStore.setState({ error: errorMessage(error) }); }
  finally { useTransferStore.setState({ planning: false }); }
}

export function revealTransferPanel() {
  const state = useAppStore.getState();
  state.setLayout({ panelVisible: { ...state.layout.panelVisible, transfer: true }, panelCollapsed: { ...state.layout.panelCollapsed, transfer: false } });
}

async function refreshWorkspaceAfterTransfer(task: TransferSummary) {
  const state = useAppStore.getState();
  const workspace = state.workspace;
  const sameWorkspaceHost = workspace && workspace.type === task.target.type && (workspace.type !== "device" || task.target.type === "device" && workspace.device_id === task.target.device_id);
  const matches = state.openTabs.map((tab) => { const origin = editorFileSource(tab, workspace); return { tab, origin, path: origin ? workspaceTransferPath(origin.workspace, origin.path, task.target) : null }; }).filter((item) => item.origin && item.path !== null);
  if (!sameWorkspaceHost && !matches.length) return;
  const detail = await transferApi.task(task.id);
  for (const { tab, origin, path } of matches) {
    if (path === null || !detail.items.some((item) => item.state === "completed" && item.target_path !== null && sameTransferFilename(item.target_path, path, task.target))) continue;
    const document = await (tab.source && editorSourceCurrent(origin!, useAppStore.getState().devices)
      ? api.readDeviceEditorFile(origin!.workspace, origin!.path, origin!.device_revision)
      : tab.source ? Promise.resolve(null) : api.readWorkspaceFile(origin!.workspace, origin!.path)).catch(() => null);
    const current = useAppStore.getState();
    if ((!tab.source && !workspaceRefEquals(current.workspace, workspace)) || !current.openTabs.some((file) => file.name === tab.name && file.generation === tab.generation)) continue;
    useAppStore.setState((s) => ({ openTabs: withTab(s.openTabs, tab.name, (current) => {
      if (!document || dirtyTab(current)) return { ...current, conflict: true };
      return { ...current, fileContent: document.content, savedContent: document.content, revision: document.revision, eol: document.eol, bom: document.bom, conflict: false, generation: current.generation + 1 };
    }) }));
  }
  if (sameWorkspaceHost && workspaceRefEquals(useAppStore.getState().workspace, workspace)) {
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
