import { Fragment, Suspense, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";
import { centerPanelFractions, panelCollapsePatch, resetCenterPanels, resizeCenterPanels } from "../layoutState";
import { panelsInDock } from "../panels/registry";
import { PANEL_COMPONENTS } from "../panels/components";
import { SplitHandle } from "./SplitHandle";

/** Sections stay mounted while hidden so editors and terminal sessions retain their state. */
export function CenterDock() {
  const { t } = useTranslation();
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const dock = useRef<HTMLDivElement>(null);
  const panels = panelsInDock("center");
  const expanded = panels.filter((p) => layout.panelVisible[p.id] && !layout.panelCollapsed[p.id]);
  const ids = expanded.map((p) => p.id);
  const fractions = centerPanelFractions(layout, ids);
  return <div className="dock dock-center" ref={dock} hidden={!panels.some((p) => layout.panelVisible[p.id])}>
    {panels.map((panel) => {
      const Component = PANEL_COMPONENTS[panel.id];
      const visible = layout.panelVisible[panel.id];
      const collapsed = layout.panelCollapsed[panel.id];
      const index = ids.indexOf(panel.id);
      return <Fragment key={panel.id}>
        {index > 0 && <SplitHandle direction="horizontal"
          label={t("app.resizePanels", { first: t(expanded[index - 1].titleKey), second: t(panel.titleKey) })}
          value={Math.round(fractions[index - 1] / (fractions[index - 1] + fractions[index]) * 100)}
          onDelta={(delta) => {
            const height = Array.from(dock.current?.querySelectorAll<HTMLElement>("[data-expanded-panel='true']") ?? [])
              .reduce((sum, section) => sum + section.offsetHeight, 0);
            if (height > 0) setLayout(resizeCenterPanels(useAppStore.getState().layout, ids, index, delta / height));
          }}
          onReset={() => setLayout(resetCenterPanels(useAppStore.getState().layout, ids, index))} />}
        <section className={`dock-section ${panel.id}-section`} hidden={!visible}
          data-expanded-panel={visible && !collapsed}
          style={collapsed ? { flex: "0 0 auto" } : { flexGrow: fractions[index] ?? 1, flexBasis: 0 }}>
          <Suspense fallback={panel.id === "editor" ? <div className="editor empty">{t("app.loadingEditor")}</div> : null}>
            <Component visible={visible} collapsed={collapsed}
              onToggleCollapse={() => setLayout(panelCollapsePatch(layout, panel.id, !collapsed))} />
          </Suspense>
        </section>
      </Fragment>;
    })}
  </div>;
}
