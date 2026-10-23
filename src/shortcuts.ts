/** Fixed application bindings. Terminal input only permits the explicitly listed navigation actions. */
export const APP_SHORTCUTS = {
  openWorkspace: { key: "o", mod: true, scope: "app" },
  openRemoteWorkspace: { key: "o", mod: true, shift: true, scope: "app" },
  saveFile: { key: "s", mod: true, scope: "files" },
  saveAll: { key: "s", mod: true, shift: true, scope: "files" },
  closeFile: { key: "w", mod: true, scope: "editor" },
  runFile: { key: "F5", scope: "script" },
  runWithArgs: { key: "F5", alt: true, scope: "script" },
  rerun: { key: "F5", ctrl: true, scope: "run" },
  stop: { key: "F5", shift: true, scope: "run" },
  newTerminal: { key: "t", mod: true, shift: true, scope: "app", terminal: true },
  toggleConsole: { key: "`", mod: true, scope: "app", terminal: true },
  focusEditor: { key: "1", mod: true, scope: "app", terminal: true },
  toggleSidebar: { key: "b", mod: true, scope: "app" },
} satisfies Record<string, ShortcutBinding>;

interface ShortcutBinding {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  terminal?: boolean;
  scope: "app" | "files" | "editor" | "script" | "run";
}
export type AppCommandId = keyof typeof APP_SHORTCUTS;
export type ShortcutArea = "editor" | "workspace" | "run" | "history" | "other";
export interface ShortcutContext {
  area: ShortcutArea;
  console?: boolean;
  terminal?: boolean;
  input?: boolean;
  modal?: boolean;
  filePath?: string;
  runId?: string;
}
export type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;
export const isMacPlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function shortcutLabel(id: AppCommandId, mac = isMacPlatform()): string {
  const binding: ShortcutBinding = APP_SHORTCUTS[id];
  return [binding.mod ? mac ? "⌘" : "Ctrl" : binding.ctrl ? "Ctrl" : "",
    binding.alt ? mac ? "⌥" : "Alt" : "", binding.shift ? "Shift" : "", binding.key.toUpperCase()].filter(Boolean).join("+");
}

export function shortcutTitle(label: string, id: AppCommandId): string {
  return `${label} (${shortcutLabel(id)})`;
}

export function shortcutScopeKey(id: AppCommandId): string {
  const binding: ShortcutBinding = APP_SHORTCUTS[id];
  return `shortcuts.scope_${binding.terminal ? "navigation" : binding.scope}`;
}

export function matchAppShortcut(event: ShortcutKeyEvent, mac = isMacPlatform()): AppCommandId | null {
  for (const [id, value] of Object.entries(APP_SHORTCUTS)) {
    const binding: ShortcutBinding = value;
    if (event.ctrlKey !== !!(binding.ctrl || binding.mod && !mac) || event.metaKey !== !!(binding.mod && mac)
      || event.altKey !== !!binding.alt || event.shiftKey !== !!binding.shift) continue;
    // Backquote stays reachable on layouts where its unshifted character is not `.
    if (event.key.toLowerCase() === binding.key.toLowerCase() || binding.key === "`" && event.code === "Backquote") return id as AppCommandId;
  }
  return null;
}

export function shortcutApplies(id: AppCommandId, context: ShortcutContext): boolean {
  const binding: ShortcutBinding = APP_SHORTCUTS[id];
  if (context.modal || context.input || context.terminal && !binding.terminal) return false;
  switch (binding.scope) {
    case "app": return true;
    case "files": case "script": return context.area === "editor" || context.area === "workspace";
    case "editor": return context.area === "editor";
    case "run": return context.area === "run" || context.area === "history";
  }
}
