import type { Terminal } from "@xterm/xterm";

export interface TerminalClipboardPreferences {
  copyOnCtrlC: boolean;
  pasteOnCtrlV: boolean;
}

const STORAGE_KEYS = {
  copyOnCtrlC: "devport.copy-on-ctrl-c.v1",
  pasteOnCtrlV: "devport.paste-on-ctrl-v.v1",
};

export function loadTerminalClipboardPreference(name: keyof TerminalClipboardPreferences): boolean {
  try { return typeof localStorage === "undefined" || localStorage.getItem(STORAGE_KEYS[name]) !== "false"; }
  catch { return true; }
}

export function saveTerminalClipboardPreference(name: keyof TerminalClipboardPreferences, enabled: boolean): void {
  try { localStorage.setItem(STORAGE_KEYS[name], String(enabled)); }
  catch { /* Keep the session preference if storage is unavailable. */ }
}

export type TerminalClipboardAction = "copy" | "paste";
type ClipboardKey = Pick<KeyboardEvent, "type" | "key" | "repeat" | "ctrlKey" | "shiftKey" | "altKey"
  | "metaKey" | "isComposing" | "keyCode" | "defaultPrevented" | "getModifierState" | "preventDefault">;

interface ClipboardOptions {
  preferences: () => TerminalClipboardPreferences;
  enabled: () => boolean;
  /** Undefined when input is unavailable; copying scrollback is still allowed. */
  context: () => unknown;
  send: (data: string) => void;
  clipboard: Pick<Clipboard, "readText" | "writeText">;
  onResult?: (action: TerminalClipboardAction, error: unknown | null) => void;
}

/** Shared keyboard/menu clipboard behavior. Read preferences on every key and bind
 * asynchronous clipboard results to the original view and session/run. */
export function createTerminalClipboard(
  term: Pick<Terminal, "getSelection" | "focus" | "paste">,
  options: ClipboardOptions,
) {
  let disposed = false;
  const attempts = { copy: 0, paste: 0 };
  const active = () => !disposed && options.enabled();
  const reporter = (action: TerminalClipboardAction, context: unknown) => {
    const attempt = ++attempts[action];
    return (error: unknown | null) => {
      if (active() && options.context() === context && attempts[action] === attempt) options.onResult?.(action, error);
    };
  };
  const copy = () => {
    if (!active()) return;
    const text = term.getSelection();
    if (!text) return;
    const report = reporter("copy", options.context());
    try { void options.clipboard.writeText(text).then(() => report(null), report); }
    catch (error) { report(error); }
  };
  const paste = () => {
    if (!active()) return;
    // Focus during the user action, never after the asynchronous clipboard read.
    term.focus();
    const context = options.context();
    if (context === undefined) return;
    const report = reporter("paste", context);
    try {
      void options.clipboard.readText().then(text => {
        if (active() && options.context() === context) term.paste(text);
        report(null);
      }).catch(report);
    } catch (error) { report(error); }
  };
  return {
    copy,
    paste,
    handleKey(event: ClipboardKey): boolean {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")
        || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "v") return true;
      const preferences = options.preferences();
      if (key === "v" && !event.shiftKey && !preferences.pasteOnCtrlV) return true;
      // Consume all phases and repeats so neither xterm nor the WebView duplicates the action.
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat && active()) {
        if (key === "v") paste();
        else if (event.shiftKey || preferences.copyOnCtrlC && term.getSelection()) copy();
        else options.send("\x03");
      }
      return false;
    },
    dispose() { disposed = true; },
  };
}
