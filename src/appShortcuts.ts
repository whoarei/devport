import { useAppStore } from "./store";
import { executeAppCommand } from "./appCommands";
import { matchAppShortcut, shortcutApplies, type AppCommandId, type ShortcutContext } from "./shortcuts";
import { handleConsoleTabKeyDown } from "./consoleTabs";
import { uiZoomShortcut, type UiZoomAction } from "./uiZoom";

export function shortcutContext(target: EventTarget | null): ShortcutContext {
  const element = target instanceof Element ? target : null;
  const editor = !!element?.closest(".editor");
  const treeFile = element?.closest<HTMLElement>("[data-workspace-file]")?.dataset.workspaceFile;
  const runRow = element?.closest<HTMLElement>("[data-shortcut-run-id]");
  const runPage = !!element?.closest(".run-page");
  const terminal = !!element?.closest(".xterm");
  const form = !!element?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  return {
    area: editor ? "editor" : element?.closest(".workspace-panel") ? "workspace" : runPage ? "run" : element?.closest(".run-history-panel") ? "history" : "other",
    terminal,
    input: form && !terminal && !element?.closest(".cm-content"),
    modal: !!document.querySelector("dialog[open], [aria-modal='true']"),
    filePath: editor ? useAppStore.getState().activeFile ?? undefined : treeFile,
    runId: runRow?.dataset.shortcutRunId ?? (runPage ? useAppStore.getState().activeRunId ?? undefined : undefined),
  };
}

export function shortcutInputBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 || !!event.getModifierState?.("AltGraph");
}

export function handleAppShortcut(event: KeyboardEvent, context: ShortcutContext,
  execute: (id: AppCommandId, context: ShortcutContext) => unknown = executeAppCommand, mac?: boolean): boolean {
  if (shortcutInputBlocked(event)) return false;
  const id = matchAppShortcut(event, mac);
  if (!id) return false;
  // Never consume terminal keys outside the explicit navigation allowlist, including F5 and Ctrl+S/W/B.
  if (context.terminal && !shortcutApplies(id, context)) return false;
  if (context.modal || context.input) {
    // F5 must not reload the WebView while a form or confirmation dialog is open.
    if (event.key !== "F5" || context.terminal) return false;
  }
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat && shortcutApplies(id, context)) void execute(id, context);
  return true;
}

/** The sole capture-stage route, including the pre-existing zoom and console tab bindings. */
export function handleAppKeyDown(event: KeyboardEvent, updateUiZoom: (action: UiZoomAction) => void,
  context = shortcutContext(event.target)): boolean {
  if (shortcutInputBlocked(event)) return false;
  if (handleAppShortcut(event, context)) return true;
  if (context.modal) return false;
  const zoom = uiZoomShortcut(event);
  if (zoom) {
    event.preventDefault();
    event.stopPropagation();
    updateUiZoom(zoom);
    return true;
  }
  return handleConsoleTabKeyDown(event);
}
