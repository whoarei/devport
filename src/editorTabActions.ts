import { dirtyTab, type EditorTab } from "./editorDocument";

export type EditorCloseScope = "current" | "others" | "left" | "right" | "saved" | "all";

/** Resolve close targets in visual order, relative to the context-menu tab. */
export function editorCloseTargets(tabs: EditorTab[], target: string, scope: EditorCloseScope): string[] {
  const index = tabs.findIndex((tab) => tab.name === target);
  if (index < 0) return [];
  switch (scope) {
    case "current": return [target];
    case "others": return tabs.filter((tab) => tab.name !== target).map((tab) => tab.name);
    case "left": return tabs.slice(0, index).map((tab) => tab.name);
    case "right": return tabs.slice(index + 1).map((tab) => tab.name);
    case "saved": return tabs.filter((tab) => !dirtyTab(tab)).map((tab) => tab.name);
    case "all": return tabs.map((tab) => tab.name);
  }
}
