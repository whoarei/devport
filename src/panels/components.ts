import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { PanelId } from "./registry";

/** 面板组件统一 props：visible 由 dock 的 hidden 属性体现，仅供需要保持存活的组件（控制台终端）做 refit */
export interface PanelComponentProps {
  visible: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * 面板 id → 组件。全部懒加载：既避免 registry → 组件 → store → layoutState → registry 的
 * 模块循环，也让编辑器 / 终端等重组件按需载入。
 */
export const PANEL_COMPONENTS: Record<PanelId, LazyExoticComponent<ComponentType<PanelComponentProps>>> = {
  workspace: lazy(() => import("../components/WorkspacePanel").then((m) => ({ default: m.WorkspacePanel }))),
  commands: lazy(() => import("../components/CommandsPanel").then((m) => ({ default: m.CommandsPanel }))),
  history: lazy(() => import("../components/HistoryPanel").then((m) => ({ default: m.HistoryPanel }))),
  runtime: lazy(() => import("../components/RuntimePanel").then((m) => ({ default: m.RuntimePanel }))),
  editor: lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor }))),
  console: lazy(() => import("../components/ConsolePanel").then((m) => ({ default: m.ConsolePanel }))),
};
