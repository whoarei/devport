import { create } from "zustand";

/** One-shot focus requests also survive a lazy panel's first mount. */
export const useCommandUiStore = create<{
  focus: "editor" | "console" | "workspace" | null;
  shortcutsOpen: boolean;
}>(() => ({ focus: null, shortcutsOpen: false }));
