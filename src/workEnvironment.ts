import { api, errorMessage, workspaceRefEquals } from "./api";
import { useAppStore, getWorkspaceGeneration } from "./store";
import { useTerminalStore } from "./terminalStore";
import { useTransferStore } from "./transferStore";
import { panelVisibilityPatch } from "./layoutState";
import { captureFile, captureWorkspace, emptyEnvironment, environmentKey, restoredTab, type WorkspaceSession } from "./environmentState";
import { flushWindowGeometry, trackWindow } from "./windowState";
import i18n from "./i18n";

/** Separate controller instances make restart/crash behavior testable without a WebView. */
export function createEnvironmentController(storage = { read: api.readWorkEnvironment, write: api.saveWorkEnvironment }) {
  let environment = emptyEnvironment(), enabled = false, stopped = false, restoring = false;
  let revision = 0, written = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  const unlisten: (() => void)[] = [];
  const report = (error: unknown) => useAppStore.setState({ environmentError: i18n.t("environment.saveFailed", { message: errorMessage(error) }) });
  const schedule = () => {
    if (!enabled || stopped) return;
    ++revision;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(report); }, 500);
  };
  const remember = (state: ReturnType<typeof useAppStore.getState>) => {
    const view = captureWorkspace(state);
    if (view) environment.workspaces = [view, ...environment.workspaces.filter((w) => environmentKey(w.workspace) !== environmentKey(view.workspace))].slice(0, 10);
    environment.current = state.workspace;
    const deviceFiles = state.openTabs.filter((tab) => tab.source);
    if (deviceFiles.length || environment.device_files) {
      environment.device_files = deviceFiles.map(captureFile);
      environment.active_device_file = deviceFiles.some((tab) => tab.name === state.activeFile) ? state.activeFile : null;
    }
  };
  async function flush(): Promise<void> {
    clearTimeout(timer);
    if (!enabled || stopped || revision === written) return;
    if (saving) { await saving; return flush(); }
    const target = revision, snapshot = structuredClone(environment);
    saving = storage.write(snapshot).then(() => { written = target; useAppStore.setState({ environmentError: null }); });
    try { await saving; } finally { saving = undefined; }
    if (revision !== written) await flush();
  }
  async function installWorkspace(saved: WorkspaceSession, expectedGeneration: number): Promise<void> {
    if (stopped || getWorkspaceGeneration() !== expectedGeneration || !workspaceRefEquals(useAppStore.getState().workspace, saved.workspace)) return;
    if (useAppStore.getState().openTabs.some((tab) => !tab.source)) return;
    restoring = true;
    const state = useAppStore.getState(), tree = { ...state.workspaceTree };
    tree[""] ??= { entries: [], expanded: true, loaded: false };
    for (const dir of saved.expanded) tree[dir] = { entries: [], expanded: true, loaded: false };
    const independent = state.openTabs.filter((tab) => tab.source);
    const active = independent.some((tab) => tab.name === state.activeFile) ? state.activeFile
      : saved.files.some((f) => f.name === saved.active_file) ? saved.active_file : saved.files[0]?.name ?? independent[0]?.name ?? null;
    useAppStore.setState({ openTabs: [...saved.files.map(restoredTab), ...independent], activeFile: active, workspaceTree: tree,
      workspaceScroll: saved.tree_scroll, layout: { ...state.layout, ...panelVisibilityPatch(state.layout, "editor", saved.files.length + independent.length > 0) } });
    restoring = false;
    remember(useAppStore.getState());
    schedule();
    // Content reads have priority over restoring the expanded tree. Other tabs
    // keep their descriptors/drafts and read only after explicit activation.
    if (active) await useAppStore.getState().openWorkspaceFile(active, { reveal: false });
    const current = () => !stopped && getWorkspaceGeneration() === expectedGeneration && workspaceRefEquals(useAppStore.getState().workspace, saved.workspace);
    if (!current()) return;
    if (!useAppStore.getState().workspaceTree[""]?.loaded) await useAppStore.getState().loadWorkspaceDir("");
    for (const dir of saved.expanded.slice().sort((a, b) => a.split("/").length - b.split("/").length)) {
      if (!current()) return;
      const pieces = dir.split("/");
      const visible = pieces.slice(0, -1).every((_, index) => useAppStore.getState().workspaceTree[pieces.slice(0, index + 1).join("/")]?.expanded);
      const parent = useAppStore.getState().workspaceTree[pieces.slice(0, -1).join("/")];
      const exists = parent?.loaded && parent.entries.some((entry) => entry.name === pieces[pieces.length - 1] && entry.is_dir);
      if (visible && exists && useAppStore.getState().workspaceTree[dir]?.expanded && !useAppStore.getState().workspaceTree[dir]?.loaded) await useAppStore.getState().loadWorkspaceDir(dir);
    }
  }
  async function start(devicesReady: Promise<unknown> = Promise.resolve()): Promise<void> {
    const generation = getWorkspaceGeneration();
    const initialFiles = useAppStore.getState().openTabs;
    const initialTerminals = useTerminalStore.getState().tabs;
    const initialTerminalSelection = useTerminalStore.getState().activeTab;
    const initialTransfer = useTransferStore.getState().options;
    try { environment = await storage.read() ?? emptyEnvironment(); }
    catch (error) {
      useAppStore.setState({ environmentReady: true, environmentError: i18n.t("environment.restoreFailed", { message: errorMessage(error) }) });
      return; // Preserve unreadable/unsupported snapshots, including their drafts.
    }
    await devicesReady;
    if (stopped) return;
    const canRestore = getWorkspaceGeneration() === generation && !useAppStore.getState().workspace && !initialFiles.length && useAppStore.getState().openTabs === initialFiles && !useAppStore.getState().loading;
    if (useTransferStore.getState().options === initialTransfer) useTransferStore.setState({ options: environment.transfer });
    else environment.transfer = useTransferStore.getState().options;
    if (canRestore) {
      const devices = useAppStore.getState().devices;
      if (useTerminalStore.getState().tabs === initialTerminals && useTerminalStore.getState().activeTab === initialTerminalSelection) useTerminalStore.setState({ tabs: environment.terminals.map((tab) => ({ id: tab.id, deviceId: tab.device_id,
        deviceName: devices.find((device) => device.id === tab.device_id)?.name ?? tab.device_id,
        workspace: tab.workspace, busy: false })), activeTab: environment.active_terminal ?? "run",
        mru: [environment.active_terminal ?? "run", ...environment.terminals.map((tab) => tab.id).filter((id) => id !== environment.active_terminal)] });
      if (environment.current) useAppStore.setState({ workspace: environment.current, workspaceTree: {}, workspaceScroll: 0 });
    }
    // Restore independent drafts even when the user has already chosen a local workspace.
    // Existing live buffers and the user's active selection take precedence.
    const app = useAppStore.getState();
    const deviceFiles = (environment.device_files ?? []).map(restoredTab).filter((tab) => !app.openTabs.some((current) => current.name === tab.name));
    if (deviceFiles.length) {
      const active = canRestore ? deviceFiles.find((tab) => tab.name === environment.active_device_file)?.name ?? null : app.activeFile;
      useAppStore.setState({ openTabs: [...app.openTabs, ...deviceFiles], activeFile: active, layout: { ...app.layout, ...panelVisibilityPatch(app.layout, "editor", true) } });
    }
    const terminalState = useTerminalStore.getState();
    environment.terminals = terminalState.tabs.map((tab) => ({ id: tab.id, device_id: tab.deviceId, workspace: tab.workspace }));
    environment.active_terminal = terminalState.activeTab === "run" ? null : terminalState.activeTab;
    enabled = true;
    unlisten.push(useAppStore.subscribe((state, previous) => {
      if (restoring || stopped || (state.workspace === previous.workspace && state.openTabs === previous.openTabs
        && state.workspaceTree === previous.workspaceTree && state.workspaceScroll === previous.workspaceScroll)) return;
      const changed = !workspaceRefEquals(state.workspace, previous.workspace);
      const saved = changed && state.workspace ? environment.workspaces.find((w) => environmentKey(w.workspace) === environmentKey(state.workspace!)) : undefined;
      if (saved && !state.openTabs.some((tab) => !tab.source)) {
        environment.current = state.workspace;
        const generation = getWorkspaceGeneration();
        queueMicrotask(() => { void installWorkspace(saved, generation).catch(report); });
      } else remember(state);
      schedule();
    }));
    unlisten.push(useTerminalStore.subscribe((state, previous) => {
      if (state.shuttingDown || previous.shuttingDown) return;
      const terminals = state.tabs.map((tab) => ({ id: tab.id, device_id: tab.deviceId, workspace: tab.workspace }));
      const active = state.activeTab === "run" ? null : state.activeTab;
      if (JSON.stringify(terminals) === JSON.stringify(environment.terminals) && active === environment.active_terminal) return;
      environment.terminals = terminals;
      environment.active_terminal = active;
      schedule();
    }));
    unlisten.push(useTransferStore.subscribe((state, previous) => {
      if (state.options === previous.options) return;
      environment.transfer = state.options;
      schedule();
    }));
    useAppStore.setState({ environmentReady: true });
    if (typeof window !== "undefined") {
      const save = () => { void flush().catch(report); };
      window.addEventListener("pagehide", save);
      window.addEventListener("blur", save);
      unlisten.push(() => { window.removeEventListener("pagehide", save); window.removeEventListener("blur", save); });
      try { unlisten.push(await trackWindow(environment.window, (geometry) => { environment.window = geometry; schedule(); })); }
      catch (error) { useAppStore.setState({ environmentError: i18n.t("environment.windowFailed", { message: errorMessage(error) }) }); }
    }
    const saved = canRestore && environment.current ? environment.workspaces.find((w) => environmentKey(w.workspace) === environmentKey(environment.current!)) : undefined;
    if (saved) await installWorkspace(saved, getWorkspaceGeneration());
    else if (canRestore && environment.current) await useAppStore.getState().loadWorkspaceDir("");
    else remember(useAppStore.getState());
    const active = useAppStore.getState().openTabs.find((tab) => tab.name === useAppStore.getState().activeFile);
    if (canRestore && active?.source && active.loaded === false) await useAppStore.getState().openWorkspaceFile(active.name, { reveal: false });
    schedule();
  }
  return { start, flush, stop: () => { stopped = true; clearTimeout(timer); unlisten.forEach((off) => off()); } };
}

let controller: ReturnType<typeof createEnvironmentController> | undefined;
let restoration: Promise<void> | undefined;
export function restoreWorkEnvironment(devicesReady: Promise<unknown>): Promise<void> {
  if (restoration) return restoration;
  controller = createEnvironmentController();
  restoration = controller.start(devicesReady).catch((error) => { useAppStore.setState({ environmentError: errorMessage(error) }); });
  return restoration;
}
export async function flushWorkEnvironment(): Promise<void> {
  try {
    await flushWindowGeometry().catch((error) => useAppStore.setState({ environmentError: i18n.t("environment.windowFailed", { message: errorMessage(error) }) }));
    await controller?.flush();
  } catch (error) {
    useAppStore.setState({ environmentError: i18n.t("environment.saveFailed", { message: errorMessage(error) }) });
    throw error;
  }
}
