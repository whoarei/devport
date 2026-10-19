import { create } from "zustand";
import { api, DeviceProfile, RunEvent, RunStatus, RunRequest, WorkspaceEntryKind, WorkspaceRef, errorMessage, workspaceRefEquals, AppUpdateInfo } from "./api";
import { anyDirty, ChangeChoice, dirtyTab, EditorLanguage, EditorTab, inferLanguage, neighborAfterClose, uploadBusy, withTab } from "./editorDocument";
import i18n from "./i18n";
import { appendOutput, MAX_TOTAL_OUTPUT_BYTES, OutputBuffer, trimOutput } from "./outputBuffer";
import { DEFAULT_RUN_DRAFT, isActiveRun, newestStatus, RunDraft } from "./runState";
import { loadWorkspaceHistory, rememberWorkspace, saveWorkspaceHistory } from "./workspaceHistory";
import { LayoutState, loadLayout, normalizeLayout, panelCollapsePatch, panelVisibilityPatch, saveLayout } from "./layoutState";
import { collectScripts, dropSubtree, isWithin, joinPath, nameOf, parentOf, rekeySubtree, rootTree, withNode, WORKSPACE_ROOT, WorkspacePath, WorkspaceTree } from "./workspaceTree";

interface AppState {
  updating: boolean;
  /** 启动时静默检查发现的可用更新（驱动标题栏「更新」按钮） */
  availableUpdate: AppUpdateInfo | null;
  devices: DeviceProfile[];
  selectedDeviceId: string | null;
  /** 正在添加 / 编辑的设备（驱动设备对话框）；null 表示对话框关闭 */
  editingDevice: DeviceProfile | null;
  /** 「打开设备工作区」对话框开关 */
  remoteWorkspaceDialogOpen: boolean;

  /** 当前工作区来源：本机目录或某台设备上的目录（00029） */
  workspace: WorkspaceRef | null;
  recentWorkspaces: WorkspaceRef[];
  /** 目录树缓存：键为相对目录路径，"" 为工作区根 */
  workspaceTree: WorkspaceTree;
  workspaceError: string | null;
  workspaceMutating: boolean;
  /** 打开的文件标签（打开顺序即标签顺序） */
  openTabs: EditorTab[];
  /** 活动标签名；null 表示没有打开的文件 */
  activeFile: string | null;
  loading: boolean;
  saving: boolean;
  starting: boolean;
  guarding: boolean;
  editorError: string | null;
  changePrompt: { name: string; resolve: (choice: ChangeChoice) => void } | null;

  runs: Record<string, RunStatus>;
  /** 每个 run 的输出缓冲（base64 拼接前的原始字节已转成 string 存储代价大，直接存字节数组） */
  outputBuffers: Record<string, OutputBuffer>;
  /** Managed Runtime 准备的最新进度消息（runtime_progress 事件；终态清除） */
  runProgress: Record<string, string>;
  activeRunId: string | null;
  consoleSize: { cols: number; rows: number };
  /** console 需要重绘的信号 */
  consoleSeq: number;

  history: RunStatus[];
  runDraft: RunDraft;
  setRunDraft: (patch: Partial<RunDraft>) => void;

  layout: LayoutState;
  setLayout: (patch: Partial<LayoutState>) => void;
  resetLayout: () => void;

  loadDevices: () => Promise<void>;
  selectDevice: (id: string | null) => void;
  /** 打开设备对话框：传入空模板表示添加新设备，传入已有设备表示编辑 */
  openDeviceDialog: (device: DeviceProfile) => void;
  closeDeviceDialog: () => void;
  openRemoteWorkspaceDialog: () => void;
  closeRemoteWorkspaceDialog: () => void;
  setWorkspace: (workspace: WorkspaceRef | null) => Promise<void>;
  loadWorkspaceDir: (dir: WorkspacePath) => Promise<void>;
  toggleWorkspaceDir: (dir: WorkspacePath) => Promise<void>;
  createWorkspaceEntry: (dir: WorkspacePath, name: string, kind: WorkspaceEntryKind) => Promise<boolean>;
  /** 在工作区根生成 pyproject.toml 配置模板（已存在时后端拒绝），成功后打开 */
  generateWorkspaceConfig: () => Promise<boolean>;
  renameWorkspaceEntry: (path: WorkspacePath, newName: string) => Promise<boolean>;
  deleteWorkspaceEntry: (path: WorkspacePath) => Promise<boolean>;
  dismissWorkspaceError: () => void;
  openWorkspaceFile: (name: string) => Promise<void>;
  activateFile: (name: string) => void;
  editContent: (name: string, content: string) => void;
  setLanguage: (language: EditorLanguage) => void;
  saveFile: (name?: string) => Promise<boolean>;
  /** 顺序保存所有脏标签；任一失败即中止并返回 false */
  saveAllDirty: () => Promise<boolean>;
  confirmUnsaved: (name?: string) => Promise<boolean>;
  /** 对所有脏标签逐个确认（窗口关闭 / 切换工作区前使用） */
  confirmAllUnsaved: () => Promise<boolean>;
  reloadFile: () => Promise<void>;
  closeFile: (name?: string) => Promise<void>;
  startRun: (request: RunRequest) => Promise<string>;
  handleRunEvent: (ev: RunEvent) => void;
  handleRunEvents: (events: RunEvent[]) => void;
  loadRuns: () => Promise<void>;
  setActiveRun: (id: string | null) => void;
  setConsoleSize: (cols: number, rows: number) => void;
}

let loadSequence = 0;
/** 工作区被替换后作废仍在进行的目录加载与变更响应 */
let workspaceSequence = 0;
export const getWorkspaceGeneration = () => workspaceSequence;
/** Session-only preset context. Never reconstructed from the old run history. */
export const presetRunSessions = new Map<string, RunRequest>();

/** Preserve an explicit current choice; otherwise prefer the configured default. */
export function selectedDeviceAfterLoad(devices: DeviceProfile[], current: string | null): string | null {
  if (current && devices.some((device) => device.id === current)) return current;
  return devices.find((device) => device.is_default)?.id ?? devices[0]?.id ?? null;
}

/** 工作区变更（新建 / 重命名 / 删除）的前置检查，返回可见提示或 null */
function workspaceChangeBlocker(
  state: Pick<AppState, "workspace" | "workspaceMutating" | "saving" | "starting" | "guarding" | "runs">,
): string | null {
  if (!state.workspace) return i18n.t("workspace.selectFirst");
  if (state.workspaceMutating || state.saving || state.starting || state.guarding) return i18n.t("workspace.busy");
  if (uploadBusy(state)) return i18n.t("workspace.uploadBusy");
  return null;
}

/** 标题栏 / 面板标题用的工作区显示名：本机显示路径，远端显示 设备名:/path */
export function workspaceLabel(workspace: WorkspaceRef | null, devices: DeviceProfile[]): string | null {
  if (!workspace) return null;
  if (workspace.type === "local") return workspace.dir;
  const device = devices.find((d) => d.id === workspace.device_id);
  return `${device?.name ?? workspace.device_id}:${workspace.path}`;
}

/** 离开设备工作区时释放后端编辑会话（尽力而为，不阻塞切换） */
function releaseRemoteSession(workspace: WorkspaceRef | null) {
  if (workspace?.type === "device") void api.closeWorkspaceSession().catch(() => {});
}

/** 打开 / 激活文件意味着要看内容：编辑区隐藏或折叠时自动恢复 */
function revealEditor(get: () => AppState) {
  const layout = get().layout;
  if (!layout.panelVisible.editor || layout.panelCollapsed.editor) {
    get().setLayout({ ...panelVisibilityPatch(layout, "editor", true), ...panelCollapsePatch(layout, "editor", false) });
  }
}

/** 关闭 / 删除文件或切换工作区后，没有标签的编辑区自动隐藏。 */
function hideEmptyEditor(get: () => AppState) {
  const state = get();
  if (state.openTabs.length === 0 && state.layout.panelVisible.editor) {
    state.setLayout(panelVisibilityPatch(state.layout, "editor", false));
  }
}

/** Retain live runs and the selected history entry; bound output across all runs. */
function pruneRuns(state: Pick<AppState, "runs" | "history" | "outputBuffers" | "activeRunId">, pending: string[] = []) {
  const keep = new Set(state.history.map((h) => h.run_id));
  pending.slice(-32).forEach((id) => keep.add(id));
  Object.values(state.runs).filter(isActiveRun).forEach((r) => keep.add(r.run_id));
  if (state.activeRunId) keep.add(state.activeRunId);
  for (const id of presetRunSessions.keys()) if (!keep.has(id)) presetRunSessions.delete(id);
  const entries = Object.entries(state.runs).filter(([id]) => keep.has(id));
  const runs = entries.length === Object.keys(state.runs).length ? state.runs : Object.fromEntries(entries);
  const outputBuffers = Object.fromEntries(Object.entries(state.outputBuffers).filter(([id]) => keep.has(id)));
  let excess = Object.values(outputBuffers).reduce((sum, b) => sum + b.bytes, 0) - MAX_TOTAL_OUTPUT_BYTES;
  // Old completed runs are trimmed first, then live runs, with the selected run last.
  const ids = Object.keys(outputBuffers).sort((a, b) =>
    Number(a === state.activeRunId) - Number(b === state.activeRunId) ||
    Number(!!runs[a] && isActiveRun(runs[a])) - Number(!!runs[b] && isActiveRun(runs[b])));
  for (const id of ids) {
    if (excess <= 0) break;
    const old = outputBuffers[id];
    outputBuffers[id] = trimOutput(old, Math.max(0, old.bytes - excess));
    excess -= old.bytes - outputBuffers[id].bytes;
  }
  return { runs, outputBuffers };
}

// 文件标签不持久化，启动时即使上次编辑区可见，也从隐藏状态开始。
const initialLayout = loadLayout();

export const useAppStore = create<AppState>((set, get) => ({
  updating: false,
  availableUpdate: null,
  devices: [],
  selectedDeviceId: null,
  editingDevice: null,
  remoteWorkspaceDialogOpen: false,

  workspace: null,
  recentWorkspaces: loadWorkspaceHistory(),
  workspaceTree: {},
  workspaceError: null,
  workspaceMutating: false,
  openTabs: [],
  activeFile: null,
  loading: false,
  saving: false,
  starting: false,
  guarding: false,
  editorError: null,
  changePrompt: null,

  runs: {},
  outputBuffers: {},
  runProgress: {},
  activeRunId: null,
  consoleSize: { cols: 80, rows: 24 },
  consoleSeq: 0,

  history: [],
  runDraft: { ...DEFAULT_RUN_DRAFT },
  setRunDraft: (patch) => set((s) => ({ runDraft: { ...s.runDraft, ...patch } })),

  layout: { ...initialLayout, ...panelVisibilityPatch(initialLayout, "editor", false) },

  setLayout: (patch) => {
    const layout = normalizeLayout({ ...get().layout, ...patch });
    saveLayout(layout);
    set({ layout });
  },

  resetLayout: () => {
    const layout = normalizeLayout(undefined);
    saveLayout(layout);
    set({ layout });
  },

  loadDevices: async () => {
    const devices = await api.listDevices();
    set((s) => ({
      devices,
      selectedDeviceId: selectedDeviceAfterLoad(devices, s.selectedDeviceId),
    }));
  },

  selectDevice: (id) => set({ selectedDeviceId: id }),

  openDeviceDialog: (device) => set({ editingDevice: device }),
  closeDeviceDialog: () => set({ editingDevice: null }),
  openRemoteWorkspaceDialog: () => set({ remoteWorkspaceDialogOpen: true }),
  closeRemoteWorkspaceDialog: () => set({ remoteWorkspaceDialogOpen: false }),

  setWorkspace: async (workspace) => {
    if (get().saving || get().starting || get().guarding) return;
    const sequence = ++loadSequence;
    ++workspaceSequence;
    // This selection owns loading cleanup as soon as it invalidates the old read.
    set({ loading: false });
    if (!await get().confirmAllUnsaved() || sequence !== loadSequence) return;
    set({ loading: true, editorError: null, workspaceError: null });
    const previous = get().workspace;
    try {
      const workspaceTree = workspace ? rootTree(await api.listWorkspaceDir(workspace, WORKSPACE_ROOT)) : {};
      if (sequence !== loadSequence) return;
      releaseRemoteSession(previous);
      const recentWorkspaces = workspace ? rememberWorkspace(get().recentWorkspaces, workspace) : get().recentWorkspaces;
      if (workspace) saveWorkspaceHistory(recentWorkspaces);
      set((s) => ({ workspace, workspaceTree, recentWorkspaces,
        openTabs: [], activeFile: null,
        runDraft: { ...s.runDraft, entry: "" } }));
      hideEmptyEditor(get);
    } catch (error) {
      if (sequence === loadSequence) set({ editorError: errorMessage(error) });
      throw error;
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  loadWorkspaceDir: async (dir) => {
    const root = get().workspace;
    if (!root) return;
    const sequence = workspaceSequence;
    try {
      const entries = await api.listWorkspaceDir(root, dir);
      if (sequence !== workspaceSequence || !workspaceRefEquals(get().workspace, root)) return;
      set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (node) =>
        ({ entries, expanded: node?.expanded ?? false, loaded: true })) }));
    } catch (error) {
      if (sequence === workspaceSequence && workspaceRefEquals(get().workspace, root)) set({ workspaceError: errorMessage(error) });
    }
  },

  toggleWorkspaceDir: async (dir) => {
    const node = get().workspaceTree[dir];
    // 从未展开过的目录还没有缓存节点，首次展开时建立并按需加载
    const expanded = !node?.expanded;
    set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (current) =>
      ({ entries: current?.entries ?? [], expanded, loaded: current?.loaded ?? false })) }));
    if (expanded && !node?.loaded) await get().loadWorkspaceDir(dir);
  },

  createWorkspaceEntry: async (dir, name, kind) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspace!;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.createWorkspaceEntry(root, joinPath(dir, name), kind);
      if (sequence !== workspaceSequence) return false;
      // 展开父目录，让新条目立刻可见
      set((s) => ({ workspaceTree: withNode(s.workspaceTree, dir, (node) =>
        ({ entries: node?.entries ?? [], expanded: true, loaded: node?.loaded ?? false })) }));
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  generateWorkspaceConfig: async () => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspace!;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.generateWorkspaceConfig(root);
      if (sequence !== workspaceSequence) return false;
      await get().loadWorkspaceDir(WORKSPACE_ROOT);
      await get().openWorkspaceFile("pyproject.toml");
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  renameWorkspaceEntry: async (path, newName) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspace!;
    const dir = parentOf(path);
    const target = joinPath(dir, newName);
    if (target === path) return true;
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.renameWorkspaceEntry(root, path, target);
      await api.renameWorkspaceCommands(root, path, target).catch((error) => {
        if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      });
      if (sequence !== workspaceSequence) return false;
      // 同一个条目换了路径：缓存子树改键，所有受影响的标签与入口草稿跟随移动
      set((s) => {
        const moved = (value: string | null) =>
          value && isWithin(value, path) ? target + value.slice(path.length) : value;
        const openTabs = s.openTabs.map((tab) => {
          const name = moved(tab.name);
          return name && name !== tab.name ? { ...tab, name, language: inferLanguage(nameOf(name)) } : tab;
        });
        return { workspaceTree: rekeySubtree(s.workspaceTree, path, target), openTabs,
          activeFile: moved(s.activeFile),
          runDraft: { ...s.runDraft, entry: moved(s.runDraft.entry) ?? "" } };
      });
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  deleteWorkspaceEntry: async (path) => {
    const state = get();
    const blocked = workspaceChangeBlocker(state);
    if (blocked) { set({ workspaceError: blocked }); return false; }
    const root = state.workspace!;
    const dir = parentOf(path);
    // 删除会连带丢掉受影响标签的未保存修改，逐个复用既有的保存 / 放弃 / 取消确认
    for (const tab of state.openTabs.filter((t) => isWithin(t.name, path))) {
      if (!await get().confirmUnsaved(tab.name)) return false;
    }
    const sequence = workspaceSequence;
    set({ workspaceMutating: true, workspaceError: null });
    try {
      await api.deleteWorkspaceEntry(root, path);
      if (sequence !== workspaceSequence) return false;
      set((s) => {
        const openTabs = s.openTabs.filter((t) => !isWithin(t.name, path));
        // 入口草稿无论是否打开都要跟随删除，否则下拉框会指向已删除的文件
        const entry = s.runDraft.entry && isWithin(s.runDraft.entry, path) ? "" : s.runDraft.entry;
        const runDraft = entry === s.runDraft.entry ? s.runDraft : { ...s.runDraft, entry };
        const activeRemoved = !!s.activeFile && isWithin(s.activeFile, path);
        return { workspaceTree: dropSubtree(s.workspaceTree, path), runDraft, openTabs,
          activeFile: activeRemoved ? openTabs[0]?.name ?? null : s.activeFile,
          ...(activeRemoved ? { editorError: null } : {}) };
      });
      hideEmptyEditor(get);
      await get().loadWorkspaceDir(dir);
      return true;
    } catch (error) {
      if (sequence === workspaceSequence) set({ workspaceError: errorMessage(error) });
      return false;
    } finally {
      set({ workspaceMutating: false });
    }
  },

  dismissWorkspaceError: () => set({ workspaceError: null }),

  openWorkspaceFile: async (name) => {
    const workspace = get().workspace;
    if (!workspace || get().saving || get().starting || get().guarding) return;
    // 已打开的文件只激活标签，不重新读盘
    if (get().openTabs.some((tab) => tab.name === name)) {
      get().activateFile(name);
      return;
    }
    const sequence = ++loadSequence;
    set({ loading: true, editorError: null });
    try {
      const doc = await api.readWorkspaceFile(workspace, name);
      if (sequence === loadSequence && workspaceRefEquals(get().workspace, workspace)) {
        set((s) => ({ openTabs: [...s.openTabs, { name, fileContent: doc.content, savedContent: doc.content,
          revision: doc.revision, eol: doc.eol, bom: doc.bom, language: inferLanguage(name),
          conflict: false, generation: 1 }], activeFile: name }));
        revealEditor(get);
      }
    } catch (e) {
      if (sequence === loadSequence) set({ editorError: errorMessage(e) });
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  activateFile: (name) => {
    if (get().openTabs.some((tab) => tab.name === name)) {
      set({ activeFile: name });
      revealEditor(get);
    }
  },

  editContent: (name, content) => {
    if (get().loading || get().starting || get().guarding) return;
    set((s) => ({ openTabs: withTab(s.openTabs, name, (tab) => ({ ...tab, fileContent: content })) }));
  },
  setLanguage: (language) => {
    const active = get().activeFile;
    if (active) set((s) => ({ openTabs: withTab(s.openTabs, active, (tab) => ({ ...tab, language })) }));
  },

  saveFile: async (name) => {
    const state = get();
    if (state.saving || state.loading) return false;
    const tab = state.openTabs.find((t) => t.name === (name ?? state.activeFile));
    if (!tab) return false;
    if (!dirtyTab(tab)) return true;
    if (!state.workspace) return false;
    if (uploadBusy(state)) {
      set({ editorError: i18n.t("run.saveBlocked") });
      return false;
    }
    set({ saving: true, editorError: null });
    try {
      const saved = await api.writeWorkspaceFile({ workspace: state.workspace!, name: tab.name,
        content: tab.fileContent, expectedRevision: tab.revision, eol: tab.eol, bom: tab.bom });
      // 标签被关闭或重读后，旧响应不得覆盖新文档
      const current = get().openTabs.find((t) => t.name === tab.name);
      if (!current || current.generation !== tab.generation) return false;
      set((s) => ({ openTabs: withTab(s.openTabs, tab.name, (t) =>
        ({ ...t, savedContent: tab.fileContent, revision: saved.revision, conflict: false })) }));
      return true;
    } catch (error) {
      const conflict = typeof error === "object" && error !== null && "code" in error && error.code === "conflict";
      set((s) => ({ editorError: errorMessage(error),
        openTabs: withTab(s.openTabs, tab.name, (t) => ({ ...t, conflict })) }));
      return false;
    } finally {
      set({ saving: false });
    }
  },

  saveAllDirty: async () => {
    for (const tab of get().openTabs) {
      if (dirtyTab(tab) && !await get().saveFile(tab.name)) return false;
    }
    return !anyDirty(get());
  },

  confirmUnsaved: async (name) => {
    if (get().saving || get().starting || get().guarding) return false;
    const tab = get().openTabs.find((t) => t.name === (name ?? get().activeFile));
    if (!tab || !dirtyTab(tab)) return true;
    // Freeze input while the choice is pending, so the approved content is stable.
    set({ guarding: true });
    try {
      const choice = await new Promise<ChangeChoice>((resolve) => set({ changePrompt: { name: tab.name, resolve } }));
      set({ changePrompt: null });
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      return await get().saveFile(tab.name)
        && !dirtyTab(get().openTabs.find((t) => t.name === tab.name) ?? tab);
    } finally {
      set({ guarding: false, changePrompt: null });
    }
  },

  confirmAllUnsaved: async () => {
    for (const tab of get().openTabs) {
      if (!await get().confirmUnsaved(tab.name)) return false;
    }
    return true;
  },

  reloadFile: async () => {
    const state = get();
    const tab = state.openTabs.find((t) => t.name === state.activeFile);
    if (!tab || !state.workspace || state.loading || state.saving || state.starting || state.guarding) return;
    // Reuse the same save/discard/cancel choice, preserving the buffer on read failure.
    if (!await get().confirmUnsaved(tab.name)) return;
    const sequence = ++loadSequence;
    set({ loading: true, editorError: null });
    try {
      const doc = await api.readWorkspaceFile(state.workspace, tab.name);
      if (sequence === loadSequence) set((s) => ({ openTabs: withTab(s.openTabs, tab.name, (t) =>
        ({ ...t, fileContent: doc.content, savedContent: doc.content, revision: doc.revision,
          eol: doc.eol, bom: doc.bom, conflict: false, generation: t.generation + 1 })) }));
    } catch (error) {
      if (sequence === loadSequence) set({ editorError: errorMessage(error) });
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  },

  closeFile: async (name) => {
    const state = get();
    if (state.loading || state.saving || state.starting || state.guarding) return;
    const tab = state.openTabs.find((t) => t.name === (name ?? state.activeFile));
    if (!tab) return;
    // 关闭会丢掉未保存修改，复用保存 / 放弃 / 取消确认
    if (!await get().confirmUnsaved(tab.name)) return;
    set((s) => {
      const openTabs = s.openTabs.filter((t) => t.name !== tab.name);
      return { openTabs, editorError: null,
        activeFile: s.activeFile === tab.name ? neighborAfterClose(s.openTabs, tab.name, openTabs) : s.activeFile };
    });
    hideEmptyEditor(get);
  },

  startRun: async (request) => {
    const state = get();
    if (state.updating) throw new Error(i18n.t("run.errorUpdating"));
    if (state.loading || state.saving || state.starting || state.guarding) throw new Error(i18n.t("run.errorFileBusy"));
    if (!workspaceRefEquals(request.workspace ?? null, state.workspace)) throw new Error(i18n.t("run.errorWorkspaceChanged"));
    if (!request.device_id || (request.kind === "command" ? !request.command?.trim() : !request.entry)) throw new Error(i18n.t("run.errorMissingTarget"));
    set({ starting: true });
    const generation = workspaceSequence;
    try {
      if (!await get().saveAllDirty() || anyDirty(get())) throw new Error(get().editorError ?? i18n.t("run.errorSaveIncomplete"));
      if (generation !== workspaceSequence || !workspaceRefEquals(request.workspace ?? null, get().workspace)) throw new Error(i18n.t("run.errorWorkspaceChanged"));
      const target = get().selectedDeviceId ?? request.device_id;
      const submitted = { ...request, device_id: target, console_mode: get().devices.find((device) => device.id === target)?.transport === "serial" ? "pty" as const : request.console_mode, ...get().consoleSize };
      const runId = await api.runScript(submitted);
      if (request.kind === "command") presetRunSessions.set(runId, submitted);
      // Events may arrive before invoke returns. Fetch status only when missing;
      // use preparing as a fallback so no save slips through before the first event.
      if (!get().runs[runId]) {
        const status = await api.getRunStatus(runId).catch(() => null);
        if (!get().runs[runId]) set((s) => ({ runs: { ...s.runs, [runId]: status ?? {
          run_id: runId, device_name: "", label: request.entry ?? request.command ?? "",
          state: "preparing", exit_code: null, error: null, started_at: "", ended_at: null,
        } } }));
      }
      get().setActiveRun(runId);
      return runId;
    } finally { set({ starting: false }); }
  },

  handleRunEvent: (ev) => get().handleRunEvents([ev]),

  handleRunEvents: (events) => {
    if (!events.length) return;
    set((s) => {
      let runs = s.runs;
      let history = s.history;
      let outputBuffers = { ...s.outputBuffers };
      let runProgress = s.runProgress;
      for (const ev of events) {
        if (ev.type === "output") {
          const bytes = Uint8Array.from(atob(ev.data), (c) => c.charCodeAt(0));
          outputBuffers[ev.run_id] = appendOutput(outputBuffers[ev.run_id], bytes);
        } else if (ev.type === "runtime_progress") {
          // 字节级进度可丢弃，只保留每个 run 的最新一条消息
          runProgress = { ...runProgress, [ev.run_id]: ev.message };
        } else if (ev.type === "resync") {
          runs = Object.fromEntries(ev.statuses.map((r) => [r.run_id, r]));
          history = ev.statuses.filter((r) => !isActiveRun(r)).slice(0, 200);
          runProgress = {};
          // Do not concatenate bytes across a missing interval (including UTF-8/ANSI).
          for (const id of new Set([...Object.keys(outputBuffers), ...Object.keys(runs)])) {
            const buffer = outputBuffers[id] ?? { chunks: [], bytes: 0, start: 0 };
            outputBuffers[id] = { chunks: [], bytes: 0, start: buffer.start + buffer.chunks.length, gaps: (buffer.gaps ?? 0) + 1 };
          }
        } else if (ev.type === "status") {
          const status = newestStatus(runs[ev.status.run_id], ev.status);
          runs = { ...runs, [status.run_id]: status };
          if (!isActiveRun(status)) {
            history = [status, ...history.filter((h) => h.run_id !== status.run_id)].slice(0, 200);
            if (runProgress[status.run_id] != null) {
              runProgress = { ...runProgress };
              delete runProgress[status.run_id];
            }
          }
        }
      }
      // Output can precede its first status in tests or after a late attachment.
      // Keep those buffers until reconciliation, but still enforce the total budget.
      const pending = Object.keys(outputBuffers).filter((id) => !runs[id]);
      const retained = pruneRuns({ runs, history, outputBuffers, activeRunId: s.activeRunId }, pending);
      return { ...retained, history, runProgress, consoleSeq: s.consoleSeq + 1 };
    });
  },

  setActiveRun: (id) => set((s) => ({ activeRunId: id, ...pruneRuns({ ...s, activeRunId: id }), consoleSeq: s.consoleSeq + 1 })),
  setConsoleSize: (cols, rows) => set({ consoleSize: { cols, rows } }),

  loadRuns: async () => {
    const before = get().runs;
    const [live, saved] = await Promise.all([api.listRunningRuns(), api.getRunHistory()]);
    set((s) => {
      const runs = { ...Object.fromEntries([...saved, ...live].map((r) => [r.run_id, r])) };
      // Preserve events delivered while this snapshot was being fetched.
      for (const [id, run] of Object.entries(s.runs)) if (run !== before[id]) runs[id] = newestStatus(runs[id], run);
      const history = Object.values(runs).filter((r) => !isActiveRun(r)).sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? "")).slice(0, 200);
      const activeRunId = s.activeRunId ?? live.find(isActiveRun)?.run_id ?? null;
      return { ...pruneRuns({ ...s, runs, history, activeRunId }), history, activeRunId };
    });
  },
}));
