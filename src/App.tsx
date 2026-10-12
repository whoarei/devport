import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { onRunEvents, api } from "./api";
import { useAppStore } from "./store";
import { DeviceDialog } from "./components/DeviceDialog";
import { UsbDialog } from "./components/UsbDialog";
import { RemoteWorkspaceDialog } from "./components/RemoteWorkspaceDialog";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { TitleBar } from "./components/TitleBar";
import { AboutDialog } from "./components/AboutDialog";
import { SplitHandle } from "./components/SplitHandle";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { anyDirty } from "./editorDocument";
import { errorMessage } from "./api";
import i18n from "./i18n";
import { requestQuit } from "./appLifecycle";
import { clampSidebarWidth, clampSplit, panelCollapsePatch, DEFAULT_LAYOUT } from "./layoutState";
import { panelsInDock, type PanelId } from "./panels/registry";
import { PANEL_COMPONENTS } from "./panels/components";
import { checkForAvailableUpdate } from "./updateStatus";
import { endConsoleTabCycle, handleConsoleTabKeyDown, handleConsoleTabKeyUp } from "./consoleTabs";
import { applyUiZoom, changeUiZoom, loadUiZoom, saveUiZoom, uiZoomShortcut, type UiZoomAction } from "./uiZoom";

export default function App() {
  const { t } = useTranslation();
  const loadDevices = useAppStore((s) => s.loadDevices);
  const loadRuns = useAppStore((s) => s.loadRuns);
  const handleRunEvents = useAppStore((s) => s.handleRunEvents);
  const [closeReady, setCloseReady] = useState(false);
  const aboutDialog = useRef<HTMLDialogElement>(null);
  const [aboutAutoCheck, setAboutAutoCheck] = useState(0);
  const initialUiZoom = useRef(loadUiZoom());
  const uiZoomRef = useRef(initialUiZoom.current);
  const [uiZoom, setUiZoom] = useState(initialUiZoom.current);

  const updateUiZoom = useCallback((action: UiZoomAction) => {
    const next = changeUiZoom(uiZoomRef.current, action);
    if (next === uiZoomRef.current) return;
    uiZoomRef.current = next;
    setUiZoom(next);
    saveUiZoom(next);
    void applyUiZoom(next).catch((error) => {
      useAppStore.setState({ editorError: i18n.t("app.zoomFailed", { message: errorMessage(error) }) });
    });
  }, []);

  useEffect(() => {
    void applyUiZoom(initialUiZoom.current).catch((error) => {
      useAppStore.setState({ editorError: i18n.t("app.zoomFailed", { message: errorMessage(error) }) });
    });
  }, []);

  useEffect(() => {
    const report = (error: unknown) => useAppStore.setState({ editorError: errorMessage(error) });
    void loadDevices().catch(report);
    void loadRuns().catch(report);
    return onRunEvents(handleRunEvents, report);
  }, [loadDevices, loadRuns, handleRunEvents]);

  // 启动后静默检查一次更新；发现新版本时点亮标题栏「更新」按钮，失败不打扰用户。
  useEffect(() => {
    if (!isTauri()) return;
    void checkForAvailableUpdate(api.checkAppUpdate, (info) => useAppStore.setState({ availableUpdate: info }));
  }, []);

  useEffect(() => {
    // capture 阶段统一接管，确保事件不会先后被 xterm 与 window 处理两次。
    const onKeyDown = (event: KeyboardEvent) => {
      const zoomAction = uiZoomShortcut(event);
      if (zoomAction) {
        event.preventDefault();
        event.stopPropagation();
        updateUiZoom(zoomAction);
        return;
      }
      handleConsoleTabKeyDown(event);
    };
    const onKeyUp = (event: KeyboardEvent) => { handleConsoleTabKeyUp(event); };
    const onBlur = () => endConsoleTabCycle();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      endConsoleTabCycle();
    };
  }, [updateUiZoom]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (anyDirty(useAppStore.getState())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    // 关闭窗口 = 最小化到托盘：隐藏不丢任何状态，无需未保存守卫。
    // 真正的退出由托盘「退出」/ 菜单「文件 → 退出」经 requestQuit() 走守卫流程。
    const unlisten = isTauri() ? getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void getCurrentWindow().hide().catch((error) => {
        useAppStore.setState({ editorError: i18n.t("app.windowError", { message: errorMessage(error) }) });
      });
    }) : Promise.resolve(() => {});
    const unlistenQuit = isTauri()
      ? listen("tray://quit-requested", () => void requestQuit())
      : Promise.resolve(() => {});
    void Promise.all([unlisten, unlistenQuit])
      .then(() => { if (!disposed) setCloseReady(true); })
      .catch((error) => useAppStore.setState({ editorError: i18n.t("app.closeGuardFailed", { message: errorMessage(error) }) }));
    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", beforeUnload);
      void unlisten.then((fn) => fn()).catch(() => {});
      void unlistenQuit.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const sideRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);

  const visible = (id: PanelId) => layout.panelVisible[id];
  const collapsed = (id: PanelId) => layout.panelCollapsed[id];
  const toggleCollapse = (id: PanelId) => () => setLayout(panelCollapsePatch(layout, id, !layout.panelCollapsed[id]));
  const setSplit = (dock: keyof typeof layout.splits, ratio: number) =>
    setLayout({ splits: { ...layout.splits, [dock]: clampSplit(ratio, DEFAULT_LAYOUT.splits[dock]) } });

  // ---- 侧栏 dock：面板按注册表顺序堆叠；高度分配沿用既有语义 ----
  // Workspace 与 History 同时展开时按 splits.sidebar 分比例并显示分割条；
  // 预置命令面板不参与比例分配：有其他展开面板时限制最大高度，独占侧栏时占满。
  const sidebarPanels = panelsInDock("sidebar");
  const sidebarShown = layout.sidebarVisible && sidebarPanels.some((panel) => visible(panel.id));
  const bothSideExpanded = visible("workspace") && visible("history") && !collapsed("workspace") && !collapsed("history");
  const otherSideExpanded =
    (visible("workspace") && !collapsed("workspace")) ||
    (visible("history") && !collapsed("history"));

  const sideSectionStyle = (id: PanelId): CSSProperties | undefined => {
    if (collapsed(id)) return { flex: "0 0 auto" };
    if (id === "workspace" && bothSideExpanded) return { flexGrow: layout.splits.sidebar, flexBasis: 0 };
    if (id === "history" && bothSideExpanded) return { flexGrow: 1 - layout.splits.sidebar, flexBasis: 0 };
    if (id === "commands" && !otherSideExpanded) return { flex: 1, maxHeight: "none" };
    return undefined;
  };

  const sidebarHandle = (
    <SplitHandle
      direction="vertical"
      label={t("app.resizeSidebar")}
      onDelta={(delta) => setLayout({ sidebarWidth: clampSidebarWidth(layout.sidebarWidth + (layout.sidebarPosition === "left" ? delta : -delta)) })}
      onReset={() => setLayout({ sidebarWidth: DEFAULT_LAYOUT.sidebarWidth })}
    />
  );

  const sidebarDock = sidebarShown && (
    <>
      {layout.sidebarPosition === "right" && sidebarHandle}
      <aside className="dock dock-side" style={{ width: layout.sidebarWidth }} ref={sideRef}>
        {sidebarPanels.map((panel) => {
          const Component = PANEL_COMPONENTS[panel.id];
          return (
            <Fragment key={panel.id}>
              {panel.id === "history" && bothSideExpanded && (
                <SplitHandle
                  direction="horizontal"
                  label={t("app.resizeSideSplit")}
                  onDelta={(delta) => {
                    const height = sideRef.current?.clientHeight ?? 0;
                    if (height > 0) setSplit("sidebar", layout.splits.sidebar + delta / height);
                  }}
                  onReset={() => setLayout({ splits: { ...layout.splits, sidebar: DEFAULT_LAYOUT.splits.sidebar } })}
                />
              )}
              {visible(panel.id) && (
                <div className={`dock-section${panel.id === "commands" ? " commands-section" : ""}`} style={sideSectionStyle(panel.id)}>
                  <Suspense fallback={null}>
                    <Component visible collapsed={collapsed(panel.id)} onToggleCollapse={toggleCollapse(panel.id)} />
                  </Suspense>
                </div>
              )}
            </Fragment>
          );
        })}
      </aside>
      {layout.sidebarPosition === "left" && sidebarHandle}
    </>
  );

  // ---- 中间 dock：文件编辑区与控制面板区为平等结构，按 splits.center 分配高度 ----
  // 两区都允许隐藏：dock 以 hidden 属性隐藏（不卸载），编辑器与终端实例保持存活。
  const centerPanels = panelsInDock("center");
  const centerShown = centerPanels.some((panel) => visible(panel.id));
  const bothCenterExpanded = visible("editor") && visible("console") && !collapsed("editor") && !collapsed("console");

  const centerSectionStyle = (id: PanelId): CSSProperties | undefined => {
    if (collapsed(id)) return { flex: "0 0 auto" };
    if (bothCenterExpanded) return { flexGrow: id === "editor" ? layout.splits.center : 1 - layout.splits.center, flexBasis: 0 };
    return undefined;
  };

  const centerDock = (
    <div className="dock dock-center" ref={centerRef} hidden={!centerShown}>
      {centerPanels.map((panel, index) => {
        const Component = PANEL_COMPONENTS[panel.id];
        return (
          <Fragment key={panel.id}>
            {index > 0 && bothCenterExpanded && (
              <SplitHandle
                direction="horizontal"
                label={t("app.resizeCenter")}
                onDelta={(delta) => {
                  const height = centerRef.current?.clientHeight ?? 0;
                  if (height > 0) setSplit("center", layout.splits.center + delta / height);
                }}
                onReset={() => setLayout({ splits: { ...layout.splits, center: DEFAULT_LAYOUT.splits.center } })}
              />
            )}
            <section
              className={`dock-section ${panel.id}-section`}
              hidden={!visible(panel.id)}
              style={visible(panel.id) ? centerSectionStyle(panel.id) : undefined}
            >
              <Suspense fallback={panel.id === "editor" ? <div className="editor empty">{t("app.loadingEditor")}</div> : null}>
                <Component visible={visible(panel.id)} collapsed={collapsed(panel.id)} onToggleCollapse={toggleCollapse(panel.id)} />
              </Suspense>
            </section>
          </Fragment>
        );
      })}
    </div>
  );

  return (
    <div className="app">
      <UnsavedDialog />
      <AboutDialog dialogRef={aboutDialog} autoCheckNonce={aboutAutoCheck} />
      <DeviceDialog />
      <UsbDialog />
      <RemoteWorkspaceDialog />
      <TitleBar
        closeReady={closeReady}
        uiZoom={uiZoom}
        onUiZoom={updateUiZoom}
        onAbout={() => aboutDialog.current?.showModal()}
        onCheckUpdate={() => {
          setAboutAutoCheck((nonce) => nonce + 1);
          aboutDialog.current?.showModal();
        }}
      />
      <main className="app-main">
        {layout.sidebarPosition === "left" && sidebarDock}
        {centerDock}
        {layout.sidebarPosition === "right" && sidebarDock}
      </main>
    </div>
  );
}
