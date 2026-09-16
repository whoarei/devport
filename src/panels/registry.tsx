import type { ReactNode } from "react";

/**
 * 面板注册表：界面所有功能模块（侧栏面板 + 中间区面板）的元数据。
 * 新增面板 = 在 PANELS 中加一项 + 在 ./components 的 PANEL_COMPONENTS 中关联组件，
 * App 的 dock 渲染、视图菜单、标题栏切换按钮、布局状态持久化全部自动适配。
 *
 * 本文件只含元数据（不 import 组件实现），保证 layoutState.ts 可以安全引用。
 */

export type PanelId = "workspace" | "commands" | "history" | "runtime" | "editor" | "console";

/** dock 槽位：sidebar 由 sidebarPosition 决定占据左/右，center 居中默认占主宽度 */
export type DockId = "sidebar" | "center";

export interface PanelDef {
  id: PanelId;
  dock: DockId;
  /** 菜单 / 面板标题的 i18n key */
  titleKey: string;
  /** 标题栏切换按钮的 i18n key（center 面板使用） */
  toggleKey?: string;
  /** 标题栏切换按钮图标（center 面板使用） */
  icon?: ReactNode;
  defaultVisible: boolean;
}

/** 数组顺序即侧栏堆叠顺序与标题栏按钮顺序 */
export const PANELS: PanelDef[] = [
  { id: "workspace", dock: "sidebar", titleKey: "menu.workspacePanel", defaultVisible: true },
  { id: "commands", dock: "sidebar", titleKey: "menu.commandsPanel", defaultVisible: true },
  { id: "history", dock: "sidebar", titleKey: "menu.historyPanel", defaultVisible: true },
  { id: "runtime", dock: "sidebar", titleKey: "menu.runtimePanel", defaultVisible: false },
  {
    id: "editor", dock: "center", titleKey: "menu.editorPanel", toggleKey: "titlebar.toggleEditor", defaultVisible: true,
    icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" />
        <rect x="2.2" y="2.7" width="7.6" height="2.9" rx="0.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "console", dock: "center", titleKey: "menu.consolePanel", toggleKey: "titlebar.toggleConsole", defaultVisible: true,
    icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" />
        <rect x="2.2" y="7" width="7.6" height="2.3" rx="0.6" fill="currentColor" />
      </svg>
    ),
  },
];

export function panelsInDock(dock: DockId): PanelDef[] {
  return PANELS.filter((panel) => panel.dock === dock);
}
