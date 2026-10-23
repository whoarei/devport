import { api, errorMessage, type WorkspaceCommand } from "./api";
import { useAppStore } from "./store";
import { anyDirty, dirtyTab, uploadBusy } from "./editorDocument";
import { useWorkspaceRunStore } from "./workspaceRunStore";
import { commandsFor } from "./workspaceRun";
import { useRunHistoryStore } from "./runHistoryStore";
import { useTerminalStore } from "./terminalStore";
import { isActiveRun } from "./runState";
import { openWorkspace } from "./workspacePicker";
import { revealConsolePanel } from "./consoleTabs";
import { panelCollapsePatch, panelVisibilityPatch } from "./layoutState";
import { useCommandUiStore } from "./commandUiStore";
import type { AppCommandId, ShortcutContext } from "./shortcuts";

const pending = new Set<string>();
export function defaultTerminalDevice() {
  const { devices } = useAppStore.getState();
  return devices.find(device => device.is_default) ?? devices[0];
}
export function scriptCommand(path: string | null | undefined): WorkspaceCommand | null {
  return path && /\.(py|sh)$/i.test(path)
    ? { entry: { type: /\.py$/i.test(path) ? "python_script" : "bash_script", path }, args: [] } : null;
}
export function commandRun(context: ShortcutContext) {
  return context.runId ? useAppStore.getState().runs[context.runId] : undefined;
}
const activeFile = () => useAppStore.getState().activeFile ?? undefined;

export function appCommandEnabled(id: AppCommandId, context: ShortcutContext = { area: "other" }): boolean {
  const app = useAppStore.getState(), terminals = useTerminalStore.getState(), history = useRunHistoryStore.getState();
  const defaultDevice = defaultTerminalDevice();
  const busy = app.updating || app.loading || app.saving || app.starting || app.guarding || app.workspaceMutating;
  const tab = app.openTabs.find(tab => tab.name === app.activeFile);
  switch (id) {
    case "openWorkspace": case "openRemoteWorkspace": return !busy;
    case "saveFile": return !busy && !uploadBusy(app) && !!app.workspace && !!tab && dirtyTab(tab);
    case "saveAll": return !busy && !uploadBusy(app) && !!app.workspace && anyDirty(app);
    case "closeFile": return !busy && !!tab;
    case "runFile": case "runWithArgs": return !busy && !!app.workspace && !!scriptCommand(context.filePath ?? (context.area === "editor" ? activeFile() : undefined));
    case "rerun": { const run = commandRun(context); return !busy && !history.busy && !!run?.replay && !isActiveRun(run); }
    case "stop": { const run = commandRun(context); return !app.updating && !!run && isActiveRun(run); }
    case "newTerminal": return !app.updating && !app.guarding && !terminals.shuttingDown && terminals.tabs.length < 8
      && !!defaultDevice && defaultDevice.transport !== "serial";
    case "focusEditor": return !app.guarding && !!tab;
    case "toggleConsole": case "toggleSidebar": return !app.guarding;
  }
}

const actions: Record<AppCommandId, (context: ShortcutContext) => unknown> = {
  openWorkspace: () => openWorkspace(),
  openRemoteWorkspace: () => useAppStore.getState().openRemoteWorkspaceDialog(),
  saveFile: () => useAppStore.getState().saveFile(),
  saveAll: () => useAppStore.getState().saveAllDirty(),
  closeFile: () => useAppStore.getState().closeFile(),
  runFile: context => {
    const path = (context.filePath ?? activeFile())!;
    useWorkspaceRunStore.getState().run(scriptCommand(path)!, { type: "file", path });
  },
  runWithArgs: context => {
    const path = (context.filePath ?? activeFile())!;
    const command = scriptCommand(path)!;
    const source = { type: "file" as const, path };
    const recent = commandsFor(useWorkspaceRunStore.getState().commands?.entries ?? [], source);
    command.args = recent.find(record => JSON.stringify(record.entry) === JSON.stringify(command.entry))?.args.slice() ?? [];
    useWorkspaceRunStore.setState({ args: { workspace: useAppStore.getState().workspace!, command, source, module: false } });
  },
  rerun: context => useRunHistoryStore.getState().rerun(commandRun(context)!, "original"),
  stop: context => api.stopRun(commandRun(context)!.run_id),
  newTerminal: () => {
    const device = defaultTerminalDevice();
    revealConsolePanel();
    useCommandUiStore.setState({ focus: "console" });
    return useTerminalStore.getState().open(device.id, device.name);
  },
  toggleConsole: context => {
    const app = useAppStore.getState();
    if (!app.layout.panelVisible.console || app.layout.panelCollapsed.console) {
      revealConsolePanel();
      useCommandUiStore.setState({ focus: "console" });
      return;
    }
    app.setLayout(panelVisibilityPatch(app.layout, "console", false));
    if (useCommandUiStore.getState().focus === "console") useCommandUiStore.setState({ focus: null });
    if (!context.console) return;
    if (app.openTabs.some(tab => tab.name === app.activeFile)) {
      actions.focusEditor(context);
    } else {
      const { layout, setLayout } = useAppStore.getState();
      setLayout({ ...panelVisibilityPatch(layout, "workspace", true), ...panelCollapsePatch(layout, "workspace", false), sidebarVisible: true });
      useCommandUiStore.setState({ focus: "workspace" });
    }
  },
  focusEditor: () => {
    const { layout, setLayout } = useAppStore.getState();
    setLayout({ ...panelVisibilityPatch(layout, "editor", true), ...panelCollapsePatch(layout, "editor", false) });
    useCommandUiStore.setState({ focus: "editor" });
  },
  toggleSidebar: () => { const app = useAppStore.getState(); app.setLayout({ sidebarVisible: !app.layout.sidebarVisible }); },
};

/** Menus, buttons and shortcuts share guards and existing save/run/replay paths. */
export async function executeAppCommand(id: AppCommandId, context: ShortcutContext = { area: "other" }): Promise<void> {
  const lock = id === "stop" ? `${id}:${context.runId}` : id;
  // A new terminal allocates its tab synchronously; its connection must not block opening another tab.
  const serialize = id !== "newTerminal";
  if ((serialize && pending.has(lock)) || (id === "openRemoteWorkspace" && pending.has("openWorkspace")) || !appCommandEnabled(id, context)) return;
  if (serialize) pending.add(lock);
  try { await actions[id](context); }
  catch (error) {
    if (id === "stop" && context.area === "history") useRunHistoryStore.setState({ error: errorMessage(error) });
    else if (id === "stop") useWorkspaceRunStore.getState().reportError(error);
    else useAppStore.setState({ editorError: errorMessage(error) });
  } finally { if (serialize) pending.delete(lock); }
}
