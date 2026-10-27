import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorMessage } from "../api";
import { anyDirty } from "../editorDocument";
import i18n from "../i18n";
import { panelVisibilityPatch, toggleSidePanel } from "../layoutState";
import { panelsInDock } from "../panels/registry";
import { executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";
import { useAppStore, workspaceLabel } from "../store";
import { startOneClickUpdate } from "../updateFlow";
import { updateButtonLabel, type UpdateButtonPhase } from "../updateStatus";
import { MenuBar } from "./MenuBar";
import { EventCenter } from "./EventCenter";
import appIcon from "../../src-tauri/icons/18x18.png";
import appIcon2x from "../../src-tauri/icons/36x36.png";
import appIcon3x from "../../src-tauri/icons/54x54.png";
import type { UiZoomAction } from "../uiZoom";
import { workspacePresentation } from "../workspacePresentation";
import { Icon } from "./Icon";

function reportWindowError(error: unknown) {
  useAppStore.setState({ editorError: i18n.t("app.windowError", { message: errorMessage(error) }) });
}

function preserveContentFocus(event: MouseEvent<HTMLElement>) {
  // Window chrome should not take the caret from the terminal, editor or input.
  // Keep keyboard navigation and activation unchanged.
  if (event.button === 0) event.preventDefault();
}

export function TitleBar({ closeReady, uiZoom, onUiZoom, onAbout, onCheckUpdate }: {
  closeReady: boolean;
  uiZoom: number;
  onUiZoom: (action: UiZoomAction) => void;
  onAbout: () => void;
  onCheckUpdate: () => void;
}) {
  const { t } = useTranslation();
  const workspace = useAppStore((state) => state.workspace);
  const devices = useAppStore((state) => state.devices);
  const availableUpdate = useAppStore((state) => state.availableUpdate);
  const layout = useAppStore((state) => state.layout);
  const guarding = useAppStore((state) => state.guarding);
  const setLayout = useAppStore((state) => state.setLayout);
  const dirty = useAppStore(anyDirty);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [updatePhase, setUpdatePhase] = useState<UpdateButtonPhase | null>(null);
  const desktop = isTauri();
  const label = workspaceLabel(workspace, devices);
  const presentation = workspace ? workspacePresentation(workspace, devices) : null;

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const refreshMaximized = async () => {
      const value = await appWindow.isMaximized();
      if (!disposed) setMaximized(value);
    };
    const listeners = [
      appWindow.onResized(() => { void refreshMaximized().catch(reportWindowError); }),
      appWindow.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }),
    ];
    void refreshMaximized().catch(reportWindowError);
    void appWindow.isFocused().then((value) => { if (!disposed) setFocused(value); }).catch(reportWindowError);
    for (const listener of listeners) void listener.catch(reportWindowError);
    return () => {
      disposed = true;
      for (const listener of listeners) void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [desktop]);

  const windowAction = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!desktop) return;
    // close() emits the close request handled by App's unsaved-document guard.
    void getCurrentWindow()[action]().catch(reportWindowError);
  };

  return (
    <div className={`titlebar${focused ? "" : " titlebar-inactive"}`}>
      <div className="titlebar-brand">
        <img className="titlebar-logo" src={appIcon} srcSet={`${appIcon2x} 2x, ${appIcon3x} 3x`} alt="" width="18" height="18" />
      </div>
      <MenuBar uiZoom={uiZoom} onUiZoom={onUiZoom} onAbout={onAbout} onCheckUpdate={onCheckUpdate} />
      <div className="titlebar-drag" data-tauri-drag-region onMouseDown={preserveContentFocus}>
        <div className="titlebar-workspace" data-tauri-drag-region title={label ?? t("titlebar.noWorkspaceTitle")}>
          {presentation && <Icon name={workspace?.type === "device" ? "server" : "folder"} />}
          <span className="titlebar-workspace-name">{presentation?.name ?? t("titlebar.noWorkspace")}</span>
          {presentation?.device && <span className="titlebar-workspace-context">{presentation.device}</span>}
          {dirty && <span className="titlebar-dirty" role="img" aria-label={t("titlebar.unsavedChanges")} />}
        </div>
      </div>
      <div className="titlebar-controls" role="group" aria-label={t("titlebar.windowControls")}>
        {availableUpdate && (
          <button
            type="button"
            className="titlebar-button titlebar-update"
            disabled={!!updatePhase}
            aria-label={t("titlebar.updateAvailable", { version: availableUpdate.latest_version })}
            title={t("titlebar.updateAvailable", { version: availableUpdate.latest_version })}
            onClick={() => void startOneClickUpdate(availableUpdate, setUpdatePhase)}
          >
            {updateButtonLabel(updatePhase)}
          </button>
        )}
        <button
          type="button"
          className={`titlebar-button${layout.sidebarVisible && layout.sidebarPosition === "left" ? " active" : ""}`}
          aria-label={t("titlebar.toggleLeftSidebar")}
          aria-pressed={layout.sidebarVisible && layout.sidebarPosition === "left"}
          title={t("titlebar.toggleLeftSidebar")}
          onClick={() => setLayout(toggleSidePanel(layout, "left"))}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" />
            <rect x="2.2" y="2.7" width="2.6" height="6.6" rx="0.6" fill="currentColor" />
          </svg>
        </button>
        {panelsInDock("center").filter((panel) => panel.manualVisibility !== false).map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={`titlebar-button${layout.panelVisible[panel.id] && (!panel.toggleCommand || !layout.panelCollapsed[panel.id]) ? " active" : ""}`}
            aria-label={t(panel.toggleKey ?? panel.titleKey)}
            aria-pressed={layout.panelVisible[panel.id] && (!panel.toggleCommand || !layout.panelCollapsed[panel.id])}
            title={panel.toggleCommand ? shortcutTitle(t(panel.toggleKey ?? panel.titleKey), panel.toggleCommand) : t(panel.toggleKey ?? panel.titleKey)}
            disabled={!!panel.toggleCommand && guarding}
            onClick={() => panel.toggleCommand ? void executeAppCommand(panel.toggleCommand) : setLayout(panelVisibilityPatch(layout, panel.id, !layout.panelVisible[panel.id]))}
          >
            {panel.icon}
          </button>
        ))}
        <button
          type="button"
          className={`titlebar-button${layout.sidebarVisible && layout.sidebarPosition === "right" ? " active" : ""}`}
          aria-label={t("titlebar.toggleRightSidebar")}
          aria-pressed={layout.sidebarVisible && layout.sidebarPosition === "right"}
          title={t("titlebar.toggleRightSidebar")}
          onClick={() => setLayout(toggleSidePanel(layout, "right"))}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" />
            <rect x="7.2" y="2.7" width="2.6" height="6.6" rx="0.6" fill="currentColor" />
          </svg>
        </button>
        <EventCenter />
        <button type="button" className="titlebar-button" aria-label={t("titlebar.minimize")} title={t("titlebar.minimize")} disabled={!desktop} onMouseDown={preserveContentFocus} onClick={() => windowAction("minimize")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1 6.5h10" stroke="currentColor" /></svg>
        </button>
        <button type="button" className="titlebar-button" aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")} title={maximized ? t("titlebar.restore") : t("titlebar.maximize")} disabled={!desktop} onMouseDown={preserveContentFocus} onClick={() => windowAction("toggleMaximize")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            {maximized ? <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" stroke="currentColor" /> : <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" />}
          </svg>
        </button>
        <button type="button" className="titlebar-button titlebar-close" aria-label={t("titlebar.close")} title={t("titlebar.close")} disabled={!desktop || !closeReady} onMouseDown={preserveContentFocus} onClick={() => windowAction("close")}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" stroke="currentColor" /></svg>
        </button>
      </div>
    </div>
  );
}
