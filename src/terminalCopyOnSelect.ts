import type { Terminal } from "@xterm/xterm";

const STORAGE_KEY = "remote-runner.copy-on-select.v1";

export function loadCopyOnSelect(): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function saveCopyOnSelect(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); }
  catch { /* Keep the session preference if storage is unavailable. */ }
}

interface CopyOptions {
  enabled: () => boolean;
  /** Capture the displayed session/run so a tab switch cannot copy a stale selection. */
  context: () => unknown;
  copy: (text: string) => Promise<void>;
  onResult?: (error: unknown | null) => void;
}

/** Bind after term.open(). Copy once after xterm finishes a primary mouse selection,
 * including word/line and rectangular selections, even when released outside the view.
 * No selection-change listener: programmatic selections and background output are inert. */
export function attachTerminalCopyOnSelect(
  term: Pick<Terminal, "element" | "getSelection" | "modes" | "options">,
  options: CopyOptions,
): { dispose: () => void } {
  const element = term.element;
  if (!element) return { dispose() {} };
  const document = element.ownerDocument;
  const window = document.defaultView;
  const screen = element.querySelector(".xterm-screen");
  let disposed = false;
  let finish: ((event: MouseEvent) => void) | undefined;
  let attempt = 0;
  const cancel = () => {
    if (finish) document.removeEventListener("mouseup", finish);
    finish = undefined;
  };
  const start = (event: MouseEvent) => {
    cancel();
    if (event.button !== 0 || !options.enabled() || !screen?.contains(event.target as Node)) return;
    // Mouse-reporting applications own their clicks unless xterm's selection modifier is held.
    const mac = /Mac|iPhone|iPad/.test(window?.navigator.platform ?? "");
    const forceSelection = mac ? event.altKey && term.options.macOptionClickForcesSelection : event.shiftKey;
    if (term.modes.mouseTrackingMode !== "none" && !forceSelection) return;
    const context = options.context();
    const current = () => !disposed && options.enabled() && options.context() === context;
    // xterm registered its document mouseup during this same mousedown, before us.
    // Reading here sees the final selection and retains the clipboard user gesture.
    finish = (event) => {
      cancel();
      if (event.button !== 0 || !current()) return;
      const text = term.getSelection();
      if (!text) return;
      const id = ++attempt;
      const report = (error: unknown | null) => {
        if (current() && id === attempt) options.onResult?.(error);
      };
      try { void options.copy(text).then(() => report(null), report); }
      catch (error) { report(error); }
    };
    document.addEventListener("mouseup", finish);
  };
  const visibility = () => { if (document.hidden) cancel(); };
  element.addEventListener("mousedown", start);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("visibilitychange", visibility);
  window?.addEventListener("blur", cancel);
  return { dispose() {
    disposed = true;
    cancel();
    element.removeEventListener("mousedown", start);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("visibilitychange", visibility);
    window?.removeEventListener("blur", cancel);
  } };
}
