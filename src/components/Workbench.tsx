import { Fragment, Suspense, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { isRemoteWorkspaceHost } from "../api";
import { preserveContentFocus, preserveLayoutFocus } from "../focus";
import { clampSidebarWidth, DEFAULT_LAYOUT, panelCollapsePatch, panelVisibilityPatch } from "../layoutState";
import { PANEL_COMPONENTS } from "../panels/components";
import { panelsInDock, type PanelId } from "../panels/registry";
import { isExecutionRun } from "../runState";
import { useAppStore } from "../store";
import { CenterDock } from "./CenterDock";
import { Icon } from "./Icon";
import { SplitHandle } from "./SplitHandle";

const sidebarPanels = panelsInDock("sidebar");

export function Workbench() {
  const { t } = useTranslation();
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const hasRunHistory = useAppStore((state) => Object.values(state.runs).some(isExecutionRun));
  const hasDeviceWorkspace = useAppStore((state) => state.devices.some((device) => device.id === state.selectedDeviceId && isRemoteWorkspaceHost(device)));
  const availablePanels = sidebarPanels.filter(({ id }) => (id !== "history" || hasRunHistory) && (id !== "deviceWorkspace" || hasDeviceWorkspace));
  const visiblePanels = availablePanels.filter(({ id }) => layout.panelVisible[id]);
  const expandedPanels = visiblePanels.filter(({ id }) => !layout.panelCollapsed[id]);

  const sectionStyle = (id: PanelId): CSSProperties | undefined => {
    if (layout.panelCollapsed[id]) return { flex: "0 0 auto" };
    if (id === "history" && expandedPanels.some((panel) => panel.id !== "history")) {
      return { flex: `0 1 ${layout.historyHeight}px`, minHeight: 120, maxHeight: "65%" };
    }
    if (id === "commands" && expandedPanels.every((panel) => panel.id === "commands")) {
      return { flex: 1, maxHeight: "none" };
    }
  };

  const toggleSidebarPanel = (id: PanelId) => {
    const active = layout.sidebarVisible && layout.panelVisible[id] && !layout.panelCollapsed[id];
    preserveLayoutFocus(() => setLayout(active
      ? panelVisibilityPatch(layout, id, false)
      : { ...panelVisibilityPatch(layout, id, true), ...panelCollapsePatch(layout, id, false), sidebarVisible: true }));
  };

  const sidebarHandle = (
    <SplitHandle
      direction="vertical"
      label={t("app.resizeSidebar")}
      onDelta={(delta) => setLayout({ sidebarWidth: clampSidebarWidth(layout.sidebarWidth + (layout.sidebarPosition === "left" ? delta : -delta)) })}
      onReset={() => setLayout({ sidebarWidth: DEFAULT_LAYOUT.sidebarWidth })}
    />
  );

  const sidebarDock = layout.sidebarVisible && visiblePanels.length > 0 && (
    <>
      {layout.sidebarPosition === "right" && sidebarHandle}
      <aside className={`dock dock-side dock-side-${layout.sidebarPosition}`} style={{ width: layout.sidebarWidth }}>
        <header className="dock-side-header">DevPort</header>
        {visiblePanels.map(({ id }) => {
          const Component = PANEL_COMPONENTS[id];
          const collapsed = layout.panelCollapsed[id];
          return <Fragment key={id}>
            {id === "history" && !collapsed && (
              <SplitHandle direction="horizontal" label={t("runHistory.resize")}
                onDelta={(delta) => setLayout({ historyHeight: Math.max(120, Math.min(600, layout.historyHeight - delta)) })}
                onReset={() => setLayout({ historyHeight: DEFAULT_LAYOUT.historyHeight })} />
            )}
            <div className={`dock-section${id === "commands" ? " commands-section" : ""}`} style={sectionStyle(id)}>
              <Suspense fallback={null}>
                <Component visible collapsed={collapsed} onToggleCollapse={() => setLayout(panelCollapsePatch(layout, id, !collapsed))} />
              </Suspense>
            </div>
          </Fragment>;
        })}
      </aside>
      {layout.sidebarPosition === "left" && sidebarHandle}
    </>
  );

  return <div className="app-body">
    <nav className="activity-rail" aria-label={t("app.navigation")}>
      {availablePanels.map(({ id, icon, titleKey }) => (
        <button type="button" key={id} title={t(titleKey)} aria-label={t(titleKey)}
          aria-pressed={layout.sidebarVisible && layout.panelVisible[id] && !layout.panelCollapsed[id]}
          onMouseDown={preserveContentFocus} onClick={() => toggleSidebarPanel(id)}>{icon}</button>
      ))}
      <button type="button" className="activity-devices" title={t("menu.manageDevices")} aria-label={t("menu.manageDevices")}
        onClick={() => useAppStore.getState().openDeviceManager()}><Icon name="monitor" /></button>
    </nav>
    <main className="app-main">
      {layout.sidebarPosition === "left" && sidebarDock}
      <CenterDock />
      {layout.sidebarPosition === "right" && sidebarDock}
    </main>
  </div>;
}
