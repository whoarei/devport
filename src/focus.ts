/** Mouse-only utility actions leave the editing caret where it is; Tab and keyboard activation still work. */
export function preserveContentFocus(event: Pick<MouseEvent, "button" | "preventDefault">) {
  if (event.button === 0) event.preventDefault();
}

/** Keep layout-driven autofocus from moving the caret; recover if its work surface disappears. */
export function preserveLayoutFocus<T>(change: () => T): T {
  const previous = document.activeElement;
  const editor = previous instanceof HTMLElement && !!previous.closest(".cm-content");
  const terminal = previous instanceof HTMLElement && !!previous.closest(".xterm");
  const result = change();
  if (!editor && !terminal) return result;
  let interrupted = false;
  const cleanup = () => {
    document.removeEventListener("pointerdown", interrupt, true);
    document.removeEventListener("keydown", interrupt, true);
    window.removeEventListener("blur", interrupt);
  };
  const interrupt = () => { interrupted = true; cleanup(); };
  document.addEventListener("pointerdown", interrupt, true);
  document.addEventListener("keydown", interrupt, true);
  window.addEventListener("blur", interrupt);
  void Promise.resolve(result).then(() => requestAnimationFrame(() => {
    cleanup();
    if (interrupted) return;
    if (!document.hasFocus() || document.querySelector("dialog[open], [aria-modal='true']")) return;
    if (previous?.isConnected && previous.getClientRects().length) {
      // Revealing a mounted console can autofocus its textarea in a React effect.
      if (document.activeElement !== previous && document.activeElement?.closest(".xterm, .cm-content")) {
        (previous as HTMLElement).focus({ preventScroll: true });
      }
      return;
    }
    if (document.activeElement !== previous && document.activeElement !== document.body) return;
    const selectors = editor ? [".editor .cm-content", ".console-panel .xterm-helper-textarea"]
      : [".console-panel .xterm-helper-textarea", ".editor .cm-content"];
    for (const selector of selectors) {
      const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(element => element.getClientRects().length);
      if (target) { target.focus({ preventScroll: true }); break; }
    }
  }), cleanup);
  return result;
}
