import { PANELS, type DockId, type PanelId } from "./panels/registry";

const STORAGE_KEY = "remote-runner.layout.v1";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

export interface LayoutState {
  /** 各面板显隐，键为注册表面板 id；中间区面板允许全部隐藏 */
  panelVisible: Record<PanelId, boolean>;
  /** 各面板折叠状态：折叠后只显示标题条，独立于显隐 */
  panelCollapsed: Record<PanelId, boolean>;
  /** 侧栏 dock 宽度 px */
  sidebarWidth: number;
  /** 侧栏 dock 占据的槽位（左 / 右） */
  sidebarPosition: "left" | "right";
  /** 侧栏 dock 整体显隐：隐藏时保留各面板自身的显隐设置，恢复时原样展示 */
  sidebarVisible: boolean;
  /**
   * 各 dock 内主分割比例（0..1）：
   * - sidebar：Workspace 面板占侧栏高度的比例（剩余部分归 History）
   * - center：文件编辑区占中间区高度的比例（剩余部分归控制面板区）
   */
  splits: Record<DockId, number>;
}

function defaultPanelVisible(): Record<PanelId, boolean> {
  return Object.fromEntries(PANELS.map((panel) => [panel.id, panel.defaultVisible])) as Record<PanelId, boolean>;
}

function defaultPanelCollapsed(): Record<PanelId, boolean> {
  return Object.fromEntries(PANELS.map((panel) => [panel.id, false])) as Record<PanelId, boolean>;
}

export const DEFAULT_LAYOUT: LayoutState = {
  panelVisible: defaultPanelVisible(),
  panelCollapsed: defaultPanelCollapsed(),
  sidebarWidth: 260,
  sidebarPosition: "left",
  sidebarVisible: true,
  splits: { sidebar: 0.6, center: 0.6 },
};

/** v1 旧字段名 → 面板 id，用于迁移已持久化的布局数据 */
const LEGACY_VISIBLE_KEYS: Record<PanelId, string> = {
  transfer: "transferVisible",
  workspace: "workspaceVisible",
  commands: "commandsVisible",
  history: "historyVisible",
  runtime: "runtimeVisible",
  editor: "editorVisible",
  console: "consoleVisible",
};

const LEGACY_COLLAPSED_KEYS: Record<PanelId, string> = {
  transfer: "transferCollapsed",
  workspace: "workspaceCollapsed",
  commands: "commandsCollapsed",
  history: "historyCollapsed",
  runtime: "runtimeCollapsed",
  editor: "editorCollapsed",
  console: "consoleCollapsed",
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function clampSidebarWidth(value: number): number {
  return clampNumber(value, SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_LAYOUT.sidebarWidth);
}

export function clampSplit(value: number, fallback: number): number {
  return clampNumber(value, SPLIT_MIN, SPLIT_MAX, fallback);
}

/**
 * 侧栏 dock 整体显隐/换侧的切换逻辑（对应标题栏的左/右侧栏图标）：
 * - 侧栏显示在同侧 → 隐藏（保留各面板显隐设置）
 * - 侧栏显示在对侧 → 移到本侧
 * - 侧栏隐藏 → 在本侧显示
 */
export function toggleSidePanel(layout: LayoutState, side: "left" | "right"): Partial<LayoutState> {
  if (layout.sidebarVisible && layout.sidebarPosition === side) {
    return { sidebarVisible: false };
  }
  return { sidebarVisible: true, sidebarPosition: side };
}

/** 生成单个面板显隐的 setLayout patch */
export function panelVisibilityPatch(layout: LayoutState, id: PanelId, visible: boolean): Partial<LayoutState> {
  return { panelVisible: { ...layout.panelVisible, [id]: visible } };
}

/** 生成单个面板折叠状态的 setLayout patch */
export function panelCollapsePatch(layout: LayoutState, id: PanelId, collapsed: boolean): Partial<LayoutState> {
  return { panelCollapsed: { ...layout.panelCollapsed, [id]: collapsed } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/**
 * 逐面板解析布尔标志：优先取新格式的 per-panel map，缺失时迁移 v1 顶层旧字段，
 * 再缺失/类型错误时回落默认值。注册表之外的未知 id 直接丢弃。
 */
function normalizePanelFlags(
  map: unknown,
  legacySource: Record<string, unknown>,
  legacyKeys: Record<PanelId, string>,
  fallback: (id: PanelId) => boolean,
): Record<PanelId, boolean> {
  const bag = asRecord(map);
  const result = {} as Record<PanelId, boolean>;
  for (const panel of PANELS) {
    result[panel.id] = clampBoolean(bag[panel.id] ?? legacySource[legacyKeys[panel.id]], fallback(panel.id));
  }
  return result;
}

/** 任意输入（坏 JSON、缺字段、越界值、v1 旧格式）逐字段回落默认值并约束到合法范围。 */
export function normalizeLayout(value: unknown): LayoutState {
  const source = asRecord(value);
  const splits = asRecord(source.splits);
  return {
    panelVisible: normalizePanelFlags(source.panelVisible, source, LEGACY_VISIBLE_KEYS, (id) => DEFAULT_LAYOUT.panelVisible[id]),
    panelCollapsed: normalizePanelFlags(source.panelCollapsed, source, LEGACY_COLLAPSED_KEYS, () => false),
    sidebarWidth: clampSidebarWidth(source.sidebarWidth as number),
    sidebarPosition: source.sidebarPosition === "right" ? "right" : "left",
    sidebarVisible: clampBoolean(source.sidebarVisible, DEFAULT_LAYOUT.sidebarVisible),
    splits: {
      // v1 的 sideSplit 迁移为 sidebar dock 比例；v1 的 consoleHeight（像素）无法换算为比例，回落默认值
      sidebar: clampSplit((splits.sidebar ?? source.sideSplit) as number, DEFAULT_LAYOUT.splits.sidebar),
      center: clampSplit(splits.center as number, DEFAULT_LAYOUT.splits.center),
    },
  };
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeLayout(raw === null ? undefined : JSON.parse(raw));
  } catch {
    return normalizeLayout(undefined);
  }
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLayout(layout)));
  } catch (error) {
    console.warn("Unable to save layout", error);
  }
}
