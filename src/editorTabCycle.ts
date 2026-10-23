import { workspaceRefEquals } from "./api";
import { useAppStore } from "./store";
import { useTerminalStore } from "./terminalStore";
import { useCommandUiStore } from "./commandUiStore";
import { mruCycleOrder, nextMruId, nextSequentialId } from "./tabCycle";

let mru: string[] = [];
let session: string[] | undefined;
let previewing = false;

const touch = (id: string) => { mru = [id, ...mru.filter((name) => name !== id)]; };

/** Track mouse, tree and keyboard selections for this window's lifetime. */
export function trackEditorTabUsage(): () => void {
  const { activeFile } = useAppStore.getState();
  mru = activeFile ? [activeFile] : [];
  session = undefined;
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const changedWorkspace = !workspaceRefEquals(state.workspace, previous.workspace);
    if (!changedWorkspace && state.openTabs === previous.openTabs && state.activeFile === previous.activeFile) return;
    if (changedWorkspace) { mru = []; session = undefined; }
    const names = new Set(state.openTabs.map((tab) => tab.name));
    mru = mru.filter((name) => names.has(name));
    if (!previewing && state.activeFile && (changedWorkspace || state.activeFile !== previous.activeFile)) {
      session = undefined;
      touch(state.activeFile);
    }
  });
  return () => { endEditorTabCycle(); unsubscribe(); };
}

/** Commit only the final file when Control is released or the window loses focus. */
export function endEditorTabCycle(): void {
  if (!session) return;
  session = undefined;
  const { activeFile } = useAppStore.getState();
  if (activeFile) touch(activeFile);
}

export function cycleEditorTab(reverse = false): void {
  const { openTabs, activeFile, guarding, activateFile } = useAppStore.getState();
  if (guarding || openTabs.length < 2 || !activeFile) { endEditorTabCycle(); return; }
  const ids = openTabs.map((tab) => tab.name);
  const recent = useTerminalStore.getState().tabCycleOrder === "mru";
  let next: string;
  if (recent) {
    session ??= mruCycleOrder(ids, mru, activeFile);
    session = mruCycleOrder(ids, session, session[0] ?? activeFile);
    next = nextMruId(session, activeFile, reverse);
  } else {
    endEditorTabCycle();
    next = nextSequentialId(ids, activeFile, reverse);
  }
  if (next === activeFile) return;
  previewing = recent;
  try {
    // Reuse lazy file loading and cancellation; loaded documents keep their edit state.
    activateFile(next);
    useCommandUiStore.setState({ focus: "editor" });
  } finally { previewing = false; }
}

export function handleEditorTabKeyDown(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab") return false;
  event.preventDefault();
  event.stopPropagation();
  cycleEditorTab(event.shiftKey);
  return true;
}
