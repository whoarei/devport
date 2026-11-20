import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, onRunEvents } from "./api";
import { useAppStore } from "./store";
import { DeviceManager } from "./components/DeviceManager";
import { QuickSshDialog } from "./components/QuickSshDialog";
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
import { Workbench } from "./components/Workbench";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { anyDirty } from "./editorDocument";
import i18n from "./i18n";
import { requestQuit } from "./appLifecycle";
import { pollTransfers } from "./transferStore";
import { checkForAvailableUpdate } from "./updateStatus";
import { trackEditorTabUsage } from "./editorTabCycle";
import { applyUiZoom, changeUiZoom, loadUiZoom, saveUiZoom, type UiZoomAction } from "./uiZoom";
import { restoreWorkEnvironment } from "./workEnvironment";
import { listenForWorkspaceLaunches } from "./workspaceLaunch";
import { loadDeletedDeviceEvents } from "./deviceActions";
import { loadDeletedRunHistoryEvents } from "./runHistoryStore";
import { endAppTabCycle, handleAppKeyDown, handleAppKeyUp } from "./appShortcuts";
import { ShortcutsDialog } from "./components/ShortcutsDialog";

export default function App() {
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

  const environmentError = useAppStore((state) => state.environmentError);

  return (
    <div className="app">
      <UnsavedDialog />
      <ShortcutsDialog />
      <WorkspaceRunDialogs />
      <RunHistoryDialogs />
      <AboutDialog dialogRef={aboutDialog} autoCheckNonce={aboutAutoCheck} />
      <UpdateConfirmDialog />
      <DeviceManager />
      <QuickSshDialog />
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
      <Workbench />
      {environmentError && <div className="environment-notice" role="alert">{environmentError}</div>}
    </div>
  );
}
