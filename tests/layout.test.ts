import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LAYOUT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  SPLIT_MIN,
  SPLIT_MAX,
  clampSidebarWidth,
  clampSplit,
  normalizeLayout,
  toggleSidePanel,
  panelVisibilityPatch,
  panelCollapsePatch,
  loadLayout,
  saveLayout,
  centerPanelFractions,
  resizeCenterPanels,
  resetCenterPanels,
} from "../src/layoutState";
import { PANELS, panelsInDock } from "../src/panels/registry";
import { useAppStore } from "../src/store";

function mockLocalStorage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return data;
}

test("normalizeLayout falls back to defaults for garbage input", () => {
  assert.deepEqual(normalizeLayout(undefined), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout("broken"), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout(42), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout([]), DEFAULT_LAYOUT);
});

test("panel flags cover every registered panel and default to visible", () => {
  for (const panel of PANELS) {
    assert.equal(DEFAULT_LAYOUT.panelVisible[panel.id], panel.defaultVisible);
    assert.equal(DEFAULT_LAYOUT.panelCollapsed[panel.id], false);
  }
  assert.deepEqual(Object.keys(DEFAULT_LAYOUT.splits), ["center", "panels"]);
  assert.deepEqual(panelsInDock("center").map((panel) => panel.id), ["editor", "console", "transfer"]);
});

test("normalizeLayout keeps valid fields and fills missing ones", () => {
  const layout = normalizeLayout({
    sidebarWidth: 300,
    sidebarPosition: "right",
    panelVisible: { console: false },
    panelCollapsed: { workspace: true, editor: true },
  });
  assert.equal(layout.sidebarWidth, 300);
  assert.equal(layout.sidebarPosition, "right");
  assert.equal(layout.panelVisible.console, false);
  assert.equal(layout.panelCollapsed.workspace, true);
  assert.equal(layout.panelCollapsed.editor, true);
  assert.equal(layout.panelVisible.workspace, DEFAULT_LAYOUT.panelVisible.workspace);
  assert.equal(layout.panelCollapsed.runtime, false);
  assert.equal(layout.splits.center, DEFAULT_LAYOUT.splits.center);
});

test("device workspace visibility and collapse preferences persist and old layouts default to hidden", () => {
  const migrated = normalizeLayout({ panelVisible: { workspace: true } });
  assert.equal(migrated.panelVisible.deviceWorkspace, false);
  const saved = normalizeLayout({ panelVisible: { deviceWorkspace: true }, panelCollapsed: { deviceWorkspace: true } });
  assert.equal(saved.panelVisible.deviceWorkspace, true);
  assert.equal(saved.panelCollapsed.deviceWorkspace, true);
  assert.ok(panelsInDock("sidebar").some((panel) => panel.id === "deviceWorkspace"));
});

test("normalizeLayout migrates v1 legacy fields", () => {
  const layout = normalizeLayout({
    workspaceVisible: false,
    consoleVisible: false,
    editorCollapsed: true,
    consoleCollapsed: true,
    sideSplit: 0.7,
  });
  assert.equal(layout.panelVisible.workspace, false);
  assert.equal(layout.panelVisible.console, false);
  assert.equal(layout.panelCollapsed.editor, true);
  assert.equal(layout.panelCollapsed.console, true);
  // v1 没有编辑区显隐字段，回落默认值
  assert.equal(layout.panelVisible.editor, DEFAULT_LAYOUT.panelVisible.editor);
  // v1 的 consoleHeight 像素值无法换算为比例，回落默认值
  assert.equal(layout.splits.center, DEFAULT_LAYOUT.splits.center);
});

test("new-format panel flags take precedence over legacy fields", () => {
  const layout = normalizeLayout({ panelVisible: { workspace: true }, workspaceVisible: false });
  assert.equal(layout.panelVisible.workspace, true);
});

test("saved layouts restore history visibility and discard obsolete sidebar splits", (t) => {
  const data = mockLocalStorage(t);
  for (const oldFields of [
    { historyVisible: true, historyCollapsed: true, sideSplit: 0.7 },
    { panelVisible: { history: true, commands: false }, panelCollapsed: { history: true }, splits: { sidebar: 0.7, center: 0.4 } },
  ]) {
    data.set("remote-runner.layout.v1", JSON.stringify({ sidebarWidth: 320, sidebarPosition: "right", ...oldFields }));
    const layout = loadLayout();
    assert.equal(layout.panelVisible.history, oldFields.panelVisible?.history ?? oldFields.historyVisible ?? true);
    assert.equal(layout.panelCollapsed.history, oldFields.panelCollapsed?.history ?? oldFields.historyCollapsed ?? false);
    assert.equal("sidebar" in layout.splits, false);
    assert.equal(layout.sidebarWidth, 320);
    assert.equal(layout.sidebarPosition, "right");
    assert.equal(layout.panelVisible.commands, oldFields.panelVisible?.commands ?? true);
    assert.equal(layout.splits.center, oldFields.splits?.center ?? DEFAULT_LAYOUT.splits.center);
    saveLayout(layout);
    assert.deepEqual(loadLayout(), layout);
    assert.doesNotMatch(data.get("remote-runner.layout.v1")!, /sideSplit/);
  }
});

test("normalizeLayout clamps out-of-range values and rejects wrong types", () => {
  const layout = normalizeLayout({
    sidebarWidth: 99999,
    sidebarPosition: "up",
    splits: { sidebar: 0, center: 99 },
    panelVisible: { workspace: "yes", nope: true },
    panelCollapsed: { editor: 1 },
  });
  assert.equal(layout.sidebarWidth, SIDEBAR_MAX);
  assert.equal(layout.sidebarPosition, "left");
  assert.equal(layout.splits.center, SPLIT_MAX);
  assert.equal(layout.panelVisible.workspace, DEFAULT_LAYOUT.panelVisible.workspace);
  assert.equal(layout.panelCollapsed.editor, false);
  // 注册表之外的未知面板 id 被丢弃
  assert.equal("nope" in layout.panelVisible, false);
});

test("center panels may all be hidden (no minimum-visibility guard)", () => {
  const layout = normalizeLayout({ panelVisible: { editor: false, console: false } });
  assert.equal(layout.panelVisible.editor, false);
  assert.equal(layout.panelVisible.console, false);
});

test("clamp helpers bound values and fall back on non-finite input", () => {
  assert.equal(clampSidebarWidth(SIDEBAR_MIN - 1), SIDEBAR_MIN);
  assert.equal(clampSidebarWidth(SIDEBAR_MAX + 1), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(NaN), DEFAULT_LAYOUT.sidebarWidth);
  assert.equal(clampSplit(SPLIT_MIN - 0.1, 0.6), SPLIT_MIN);
  assert.equal(clampSplit(SPLIT_MAX + 0.1, 0.6), SPLIT_MAX);
  assert.equal(clampSplit(NaN, 0.6), 0.6);
});

test("normalizeLayout falls back sidebarVisible to default on missing/invalid input", () => {
  assert.equal(normalizeLayout({}).sidebarVisible, DEFAULT_LAYOUT.sidebarVisible);
  assert.equal(normalizeLayout({ sidebarVisible: "yes" }).sidebarVisible, DEFAULT_LAYOUT.sidebarVisible);
  assert.equal(normalizeLayout({ sidebarVisible: false }).sidebarVisible, false);
});

test("toggleSidePanel hides, moves, and shows the sidebar", () => {
  const shownLeft = { ...DEFAULT_LAYOUT, sidebarVisible: true, sidebarPosition: "left" as const };
  // 同侧 → 隐藏，位置保留
  assert.deepEqual(toggleSidePanel(shownLeft, "left"), { sidebarVisible: false });
  // 对侧 → 移到右侧
  assert.deepEqual(toggleSidePanel(shownLeft, "right"), { sidebarVisible: true, sidebarPosition: "right" });
  // 右侧再按 → 隐藏
  const shownRight = { ...shownLeft, sidebarPosition: "right" as const };
  assert.deepEqual(toggleSidePanel(shownRight, "right"), { sidebarVisible: false });
  // 隐藏 → 在指定侧显示
  const hidden = { ...shownLeft, sidebarVisible: false };
  assert.deepEqual(toggleSidePanel(hidden, "left"), { sidebarVisible: true, sidebarPosition: "left" });
  assert.deepEqual(toggleSidePanel(hidden, "right"), { sidebarVisible: true, sidebarPosition: "right" });
});

test("panel patch helpers update only the targeted panel", () => {
  const visiblePatch = panelVisibilityPatch(DEFAULT_LAYOUT, "editor", false);
  assert.equal(visiblePatch.panelVisible?.editor, false);
  assert.equal(visiblePatch.panelVisible?.console, DEFAULT_LAYOUT.panelVisible.console);
  const collapsePatch = panelCollapsePatch(DEFAULT_LAYOUT, "console", true);
  assert.equal(collapsePatch.panelCollapsed?.console, true);
  assert.equal(collapsePatch.panelCollapsed?.editor, false);
});

test("loadLayout/saveLayout round-trip and survive corrupted storage", (t) => {
  const data = mockLocalStorage(t);
  // 无存储 → 默认布局
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);

  const custom = {
    ...DEFAULT_LAYOUT,
    sidebarWidth: 333,
    sidebarPosition: "right" as const,
    panelVisible: { ...DEFAULT_LAYOUT.panelVisible, console: false },
    splits: { ...DEFAULT_LAYOUT.splits, center: 0.4 },
  };
  saveLayout(custom);
  assert.deepEqual(loadLayout(), custom);

  // 损坏的 JSON → 默认布局
  data.set("remote-runner.layout.v1", "{not json");
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);

  // 合法 JSON 但字段越界 → normalize 后回落
  data.set("remote-runner.layout.v1", JSON.stringify({ sidebarWidth: -100 }));
  assert.equal(loadLayout().sidebarWidth, SIDEBAR_MIN);
});

test("store setLayout merges patches, normalizes, and persists", (t) => {
  mockLocalStorage(t);
  const original = useAppStore.getState().layout;
  t.after(() => useAppStore.setState({ layout: original }));

  const { setLayout, resetLayout } = useAppStore.getState();
  setLayout({ sidebarWidth: 280, ...panelVisibilityPatch(useAppStore.getState().layout, "commands", false) });
  let layout = useAppStore.getState().layout;
  assert.equal(layout.sidebarWidth, 280);
  assert.equal(layout.panelVisible.commands, false);
  assert.equal(layout.panelVisible.workspace, DEFAULT_LAYOUT.panelVisible.workspace);
  assert.deepEqual(loadLayout(), layout);

  // 越界 patch 会被 clamp
  setLayout({ sidebarWidth: 1 });
  layout = useAppStore.getState().layout;
  assert.equal(layout.sidebarWidth, SIDEBAR_MIN);

  resetLayout();
  assert.deepEqual(useAppStore.getState().layout, DEFAULT_LAYOUT);
  assert.deepEqual(loadLayout(), DEFAULT_LAYOUT);
});

test("legacy split ratios migrate to independent center panel weights", () => {
  const migrated = normalizeLayout({ splits: { center: 0.3 } });
  assert.deepEqual(centerPanelFractions(migrated, ["editor", "console"]), [0.3, 0.7]);
  const invalid = normalizeLayout({ splits: { panels: { editor: NaN, console: -3, transfer: Infinity, unknown: 1 } } });
  assert.equal(invalid.splits.panels.editor, 0.6);
  assert.equal(invalid.splits.panels.console, 0.001);
  assert.equal(invalid.splits.panels.transfer, 0.5);
  assert.equal("unknown" in invalid.splits.panels, false);
});

test("three-panel resize conserves adjacent space and hidden-panel preferences", () => {
  const ids = ["editor", "console", "transfer"] as const;
  const resized = normalizeLayout({ ...DEFAULT_LAYOUT, ...resizeCenterPanels(DEFAULT_LAYOUT, [...ids], 1, 0.1) });
  const before = centerPanelFractions(DEFAULT_LAYOUT, [...ids]), after = centerPanelFractions(resized, [...ids]);
  assert.ok(Math.abs(after[0] - before[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(after[1] - before[1] + 0.1) < 1e-9);
  assert.equal(resized.splits.panels.transfer, DEFAULT_LAYOUT.splits.panels.transfer);
  const extreme = normalizeLayout({ ...resized, ...resizeCenterPanels(resized, [...ids], 2, -999) });
  assert.ok(centerPanelFractions(extreme, [...ids])[1] >= 0.12 - 1e-9);
  const hidden = normalizeLayout({ ...resized, ...resizeCenterPanels(resized, ["editor", "transfer"], 1, 0.05) });
  assert.equal(hidden.splits.panels.console, resized.splits.panels.console);
  assert.deepEqual(resizeCenterPanels(resized, [...ids], 0, 1), {});
});

test("center split reset restores proportions without moving the third panel", () => {
  const ids = ["editor", "console", "transfer"] as const;
  const moved = normalizeLayout({ ...DEFAULT_LAYOUT, ...resizeCenterPanels(DEFAULT_LAYOUT, [...ids], 1, -0.1) });
  const reset = normalizeLayout({ ...moved, ...resetCenterPanels(moved, [...ids], 1) });
  const fractions = centerPanelFractions(reset, [...ids]);
  assert.ok(Math.abs(fractions[0] / (fractions[0] + fractions[1]) - 0.6) < 1e-9);
  assert.equal(reset.splits.panels.transfer, DEFAULT_LAYOUT.splits.panels.transfer);
});
