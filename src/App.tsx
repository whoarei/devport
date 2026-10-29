import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { onRunEvents, api } from "./api";
import { useAppStore } from "./store";
import { DeviceManager } from "./components/DeviceManager";
import { UsbDialog } from "./components/UsbDialog";
import { RemoteWorkspaceDialog } from "./components/RemoteWorkspaceDialog";
import { WorkspaceTransferDialogs } from "./components/WorkspaceTransferDialogs";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { WorkspaceRunDialogs } from "./components/WorkspaceRunDialogs";
import { RunHistoryDialogs } from "./components/RunHistoryDialogs";
import { useWorkspaceRunStore } from "./workspaceRunStore";
import { TitleBar } from "./components/TitleBar";
import { AboutDialog } from "./components/AboutDialog";
import { UpdateConfirmDialog } from "./components/UpdateConfirmDialog";
import { SplitHandle } from "./components/SplitHandle";
import { CenterDock } from "./components/CenterDock";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { anyDirty } from "./editorDocument";
import { errorMessage, isRemoteWorkspaceHost } from "./api";
import i18n from "./i18n";
import { requestQuit } from "./appLifecycle";
import { pollTransfers } from "./transferStore";
import { clampSidebarWidth, panelCollapsePatch, DEFAULT_LAYOUT } from "./layoutState";
import { panelsInDock, type PanelId } from "./panels/registry";
import { PANEL_COMPONENTS } from "./panels/components";
import { checkForAvailableUpdate } from "./updateStatus";
import { trackEditorTabUsage } from "./editorTabCycle";
import { applyUiZoom, changeUiZoom, loadUiZoom, saveUiZoom, type UiZoomAction } from "./uiZoom";
import { restoreWorkEnvironment } from "./workEnvironment";
import { listenForWorkspaceLaunches } from "./workspaceLaunch";
import { loadDeletedDeviceEvents } from "./deviceActions";
import { loadDeletedRunHistoryEvents } from "./runHistoryStore";
import { endAppTabCycle, handleAppKeyDown, handleAppKeyUp } from "./appShortcuts";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { isExecutionRun } from "./runState";

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
  useEffect(() => pollTransfers(), []);

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
    const devicesReady = loadDevices().catch(report);
    void loadDeletedDeviceEvents();
    const restored = restoreWorkEnvironment(devicesReady);
    const stopWorkspaceLaunches = isTauri() ? listenForWorkspaceLaunches(restored) : () => {};
    void loadRuns().catch(report);
    const stopRunEvents = onRunEvents((events) => { handleRunEvents(events); useWorkspaceRunStore.getState().events(events); }, report);
    return () => { stopWorkspaceLaunches(); stopRunEvents(); };
  }, [loadDevices, loadRuns, handleRunEvents]);

  useEffect(() => {
    void loadDeletedRunHistoryEvents();
  }, []);

  // 启动后静默检查一次更新；发现新版本时点亮标题栏「更新」按钮，失败不打扰用户。
  useEffect(() => {
    if (!isTauri()) return;
    void checkForAvailableUpdate(api.checkAppUpdate, (info) => useAppStore.setState({ availableUpdate: info }));
  }, []);

  useEffect(() => {
    // capture 阶段统一接管，确保事件不会先后被 xterm 与 window 处理两次。
    const stopTracking = trackEditorTabUsage();
    const onKeyDown = (event: KeyboardEvent) => { handleAppKeyDown(event, updateUiZoom); };
    const onKeyUp = (event: KeyboardEvent) => { handleAppKeyUp(event); };
    const onBlur = () => endAppTabCycle();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      endAppTabCycle();
      stopTracking();
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
  const hasRunHistory = useAppStore((state) => Object.values(state.runs).some(isExecutionRun));
  const hasDeviceWorkspace = useAppStore((state) => state.devices.some((device) => device.id === state.selectedDeviceId && isRemoteWorkspaceHost(device)));
  const environmentError = useAppStore((state) => state.environmentError);
  const setLayout = useAppStore((state) => state.setLayout);

  const visible = (id: PanelId) => layout.panelVisible[id] && (id !== "history" || hasRunHistory) && (id !== "deviceWorkspace" || hasDeviceWorkspace);
  const collapsed = (id: PanelId) => layout.panelCollapsed[id];
  const toggleCollapse = (id: PanelId) => () => setLayout(panelCollapsePatch(layout, id, !layout.panelCollapsed[id]));
  // ---- 侧栏 dock：面板按注册表顺序堆叠，展开面板分配可用高度 ----
  // 预置命令面板不参与比例分配：有其他展开面板时限制最大高度，独占侧栏时占满。
  const sidebarPanels = panelsInDock("sidebar");
  const sidebarShown = layout.sidebarVisible && sidebarPanels.some((panel) => visible(panel.id));
  const otherSideExpanded = sidebarPanels.some((panel) => panel.id !== "commands" && visible(panel.id) && !collapsed(panel.id));

  const sideSectionStyle = (id: PanelId): CSSProperties | undefined => {
    if (collapsed(id)) return { flex: "0 0 auto" };
    if (id === "history" && sidebarPanels.some(p => p.id !== "history" && visible(p.id) && !collapsed(p.id))) {
      return { flex: `0 1 ${layout.historyHeight}px`, minHeight: 120, maxHeight: "65%" };
    }
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
      <aside className="dock dock-side" style={{ width: layout.sidebarWidth }}>
        {sidebarPanels.map((panel) => {
          const Component = PANEL_COMPONENTS[panel.id];
          return (
            visible(panel.id) && (
              <Fragment key={panel.id}>
                {panel.id === "history" && !collapsed(panel.id) && (
                  <SplitHandle direction="horizontal" label={t("runHistory.resize")}
                    onDelta={delta => setLayout({ historyHeight: Math.max(120, Math.min(600, layout.historyHeight - delta)) })}
                    onReset={() => setLayout({ historyHeight: DEFAULT_LAYOUT.historyHeight })} />
                )}
                <div className={`dock-section${panel.id === "commands" ? " commands-section" : ""}`} style={sideSectionStyle(panel.id)}>
                  <Suspense fallback={null}>
                    <Component visible collapsed={collapsed(panel.id)} onToggleCollapse={toggleCollapse(panel.id)} />
                  </Suspense>
                </div>
              </Fragment>
            )
          );
        })}
      </aside>
      {layout.sidebarPosition === "left" && sidebarHandle}
    </>
  );

  return (
    <div className="app">
      <UnsavedDialog />
      <ShortcutsDialog />
      <WorkspaceRunDialogs />
      <RunHistoryDialogs />
      <AboutDialog dialogRef={aboutDialog} autoCheckNonce={aboutAutoCheck} />
      <UpdateConfirmDialog />
      <DeviceManager />
      <UsbDialog />
      <RemoteWorkspaceDialog />
      <WorkspaceTransferDialogs />
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
        <CenterDock />
        {layout.sidebarPosition === "right" && sidebarDock}
      </main>
      {environmentError && <div className="environment-notice" role="alert">{environmentError}</div>}
    </div>
  );
}
