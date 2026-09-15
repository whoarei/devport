import type { TerminalTab } from "./terminalStore";

export type TerminalCloseScope = "current" | "others" | "right" | "all";

/** Return terminal ids in visual order for a tab context-menu close action. */
export function terminalCloseTargets(tabs: TerminalTab[], targetId: string, scope: TerminalCloseScope): string[] {
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (targetIndex < 0) return [];
  switch (scope) {
    case "current": return [targetId];
    case "others": return tabs.filter((tab) => tab.id !== targetId).map((tab) => tab.id);
    case "right": return tabs.slice(targetIndex + 1).map((tab) => tab.id);
    case "all": return tabs.map((tab) => tab.id);
  }
}
