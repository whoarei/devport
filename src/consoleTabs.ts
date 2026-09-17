import { useAppStore } from "./store";
import { useTerminalStore } from "./terminalStore";
import { panelCollapsePatch, panelVisibilityPatch } from "./layoutState";
import { mruCycleOrder, nextMruId, nextSequentialId } from "./tabCycle";

interface MruCycleSession {
  /** Ctrl 按下期间保持不变；切换过程中只按现存标签过滤。 */
  order: string[];
}

let mruSession: MruCycleSession | undefined;

/** 打开终端或切换标签后，确保控制面板区可见且未折叠。 */
export function revealConsolePanel(): void {
  const { layout, setLayout } = useAppStore.getState();
  if (!layout.panelVisible.console || layout.panelCollapsed.console) {
    setLayout({ ...panelVisibilityPatch(layout, "console", true), ...panelCollapsePatch(layout, "console", false) });
  }
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab 循环切换控制面板区标签（运行控制台 + 终端）。
 * 无终端标签时 no-op；切换后确保控制面板区可见且未折叠（与打开终端时自动展开一致）。
 */
export function cycleConsoleTab(reverse = false): void {
  const { tabs, activeTab, mru, tabCycleOrder, select, previewSelect } = useTerminalStore.getState();
  if (tabs.length === 0) {
    endConsoleTabCycle();
    return;
  }
  const ids = ["run", ...tabs.map((tab) => tab.id)];
  if (tabCycleOrder !== "mru") {
    endConsoleTabCycle();
    const next = nextSequentialId(ids, activeTab, reverse);
    if (next !== activeTab) select(next);
    revealConsolePanel();
    return;
  }

  if (!mruSession) mruSession = { order: mruCycleOrder(ids, mru, activeTab) };
  const order = mruSession.order.filter((id) => ids.includes(id));
  for (const id of ids) {
    if (!order.includes(id)) order.push(id);
  }
  mruSession.order = order;
  const next = nextMruId(order, activeTab, reverse);
  if (next === activeTab) return;
  previewSelect(next);
  revealConsolePanel();
}

/** Ctrl 松开或窗口失焦时提交最终选择，结束稳定 MRU 快照。 */
export function endConsoleTabCycle(): void {
  if (!mruSession) return;
  mruSession = undefined;
  const { activeTab, select } = useTerminalStore.getState();
  select(activeTab);
}

/** 唯一的 Ctrl+Tab DOM 入口；capture 阶段阻止事件到达 xterm。 */
export function handleConsoleTabKeyDown(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab") return false;
  event.preventDefault();
  event.stopPropagation();
  cycleConsoleTab(event.shiftKey);
  return true;
}

export function handleConsoleTabKeyUp(event: KeyboardEvent): boolean {
  if (event.key !== "Control") return false;
  endConsoleTabCycle();
  return true;
}
