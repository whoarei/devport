import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { errorMessage } from "../api";
import { isAutostartEnabled, setAutostartEnabled } from "../autostart";
import { requestQuit } from "../appLifecycle";
import { loadLanguagePreference, setLanguage, type LanguagePreference } from "../i18n/language";
import { useAppStore, workspaceLabel } from "../store";
import { useUsbStore } from "../usbStore";
import { revealTransferPanel, useTransferStore } from "../transferStore";
import { useTerminalStore } from "../terminalStore";
import { panelVisibilityPatch } from "../layoutState";
import { panelsInDock } from "../panels/registry";
import { deviceLabel } from "./DeviceEditor";
import { openWorkspace } from "../workspacePicker";
import { UI_ZOOM_LEVELS, type UiZoomAction } from "../uiZoom";
import { useThemeStore } from "../theme";
import { useTitlebarPreferences } from "../titlebarPreferences";
import { useShallow } from "zustand/react/shallow";
import { useRunHistoryStore } from "../runHistoryStore";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutLabel, type AppCommandId, type ShortcutContext } from "../shortcuts";
import { useCommandUiStore } from "../commandUiStore";

interface MenuEntry {
  type?: "item" | "checkbox" | "separator";
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuEntry[];
  shortcut?: string;
  title?: string;
}

interface TopMenu {
  label: string;
  entries: MenuEntry[];
}

function MenuItem({ entry, close }: { entry: MenuEntry; close: () => void }) {
  const [subOpen, setSubOpen] = useState(false);

  if (entry.type === "separator") return <div className="menu-separator" role="separator" />;

  if (entry.children) {
    return (
      <div
        className="menu-submenu"
        onMouseEnter={() => { if (!entry.disabled) setSubOpen(true); }}
        onMouseLeave={() => setSubOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className="menu-item"
          disabled={entry.disabled}
          onClick={() => setSubOpen(true)}
        >
          <span className="menu-check" />
          <span className="menu-label">{entry.label}</span>
          <span className="menu-arrow" aria-hidden="true">▸</span>
        </button>
        {subOpen && !entry.disabled && (
          <div className="menu-dropdown menu-subdropdown" role="menu">
            {entry.children.map((child, index) => <MenuItem key={index} entry={child} close={close} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      role={entry.type === "checkbox" ? "menuitemcheckbox" : "menuitem"}
      aria-checked={entry.type === "checkbox" ? entry.checked : undefined}
      className="menu-item"
      title={entry.title}
      disabled={entry.disabled}
      onClick={() => {
        close();
        entry.onSelect?.();
      }}
    >
      <span className="menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>
      <span className="menu-label">{entry.label}</span>
      {entry.shortcut && <span className="menu-shortcut" aria-hidden="true">{entry.shortcut}</span>}
    </button>
  );
}

export function MenuBar({ uiZoom, onUiZoom, onAbout, onCheckUpdate }: {
  uiZoom: number;
  onUiZoom: (action: UiZoomAction) => void;
  onAbout: () => void;
  onCheckUpdate: () => void;
}) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  // 本地持有偏好状态：切到「跟随系统」且解析结果不变时 changeLanguage 不触发重渲染
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() => loadLanguagePreference());
  const chooseLanguage = (preference: LanguagePreference) => {
    setLanguagePreference(preference);
    setLanguage(preference);
  };
  const barRef = useRef<HTMLDivElement>(null);
  const themePreference = useThemeStore((state) => state.preference);
  const chooseTheme = useThemeStore((state) => state.setPreference);
  const pathDisplay = useTitlebarPreferences((state) => state.pathDisplay);
  const setPathDisplay = useTitlebarPreferences((state) => state.setPathDisplay);
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);
  const resetLayout = useAppStore((state) => state.resetLayout);
  const recentWorkspaces = useAppStore((state) => state.recentWorkspaces);
  const workspace = useAppStore((state) => state.workspace);
  const devices = useAppStore((state) => state.devices);
  const fileDevices = devices.filter((device) => device.transport === "ssh" || device.transport === "wsl");
  const openFile = useAppStore((state) => state.activeFile);
  const fileBusy = useAppStore((state) => state.loading || state.saving || state.starting || state.guarding);
  const [autostart, setAutostart] = useState(false);
  const tabCycleOrder = useTerminalStore((state) => state.tabCycleOrder);
  const setTabCycleOrder = useTerminalStore((state) => state.setTabCycleOrder);
  const copyOnSelect = useTerminalStore((state) => state.copyOnSelect);
  const setCopyOnSelect = useTerminalStore((state) => state.setCopyOnSelect);
  const clipboardPreferences = useTerminalStore(useShallow(state => ({
    copyOnCtrlC: state.copyOnCtrlC, pasteOnCtrlV: state.pasteOnCtrlV,
    setCopyOnCtrlC: state.setCopyOnCtrlC, setPasteOnCtrlV: state.setPasteOnCtrlV,
  })));
  const terminalState = useTerminalStore(useShallow(state => ({ count: state.tabs.length, shuttingDown: state.shuttingDown, activeTab: state.activeTab })));
  useRunHistoryStore(state => state.busy);
  // Re-evaluate shared command guards when file or run state changes.
  const commandState = useAppStore(useShallow(state => ({ tabs: state.openTabs, runs: state.runs, activeRunId: state.activeRunId,
    loading: state.loading, saving: state.saving, starting: state.starting, guarding: state.guarding, workspaceMutating: state.workspaceMutating, updating: state.updating })));
  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const currentRunId = layout.panelVisible.console && !layout.panelCollapsed.console && terminalState.activeTab === "run"
    ? commandState.activeRunId : null;
  const currentRun = currentRunId ? commandState.runs[currentRunId] : undefined;
  const runContext: ShortcutContext = { area: "run", runId: currentRunId ?? undefined };
  const commandEntry = (id: AppCommandId, label: string, context: ShortcutContext = { area: "other" }): MenuEntry => ({
    label, shortcut: shortcutLabel(id), disabled: !appCommandEnabled(id, context), onSelect: () => void executeAppCommand(id, context),
  });

  useEffect(() => {
    void isAutostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  const toggleAutostart = () => {
    const next = !autostart;
    setAutostart(next);
    setAutostartEnabled(next).catch((error) => {
      setAutostart(!next);
      useAppStore.setState({ editorError: t("menu.autostartFailed", { message: errorMessage(error) }) });
    });
  };

  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const menus: TopMenu[] = [
    {
      label: t("menu.file"),
      entries: [
        commandEntry("openWorkspace", t("menu.openWorkspace")),
        commandEntry("openRemoteWorkspace", t("menu.openRemoteWorkspace")),
        {
          label: t("menu.recentWorkspaces"),
          disabled: recentWorkspaces.length === 0,
          children: recentWorkspaces.length > 0
            ? recentWorkspaces.map((item) => ({
                label: workspaceLabel(item, devices) ?? "",
                onSelect: () => void openWorkspace(item),
              }))
            : [{ label: t("menu.noRecent"), disabled: true }],
        },
        // 关闭工作区与打开走同一条 setWorkspace 路径（含未保存确认），仅传 null
        {
          label: t("menu.closeWorkspace"),
          disabled: !workspace || fileBusy,
          onSelect: () => void useAppStore.getState().setWorkspace(null),
        },
        { type: "separator" },
        commandEntry("saveFile", t("menu.saveFile")),
        commandEntry("saveAll", t("shortcuts.saveAll")),
        commandEntry("closeFile", t("menu.closeFile")),
        { type: "separator" },
        {
          label: t("menu.quit"),
          disabled: !isTauri(),
          onSelect: () => void requestQuit(),
        },
      ],
    },
    {
      label: t("menu.devices"),
      entries: [
        { label: t("menu.manageDevices"), onSelect: () => useAppStore.getState().openDeviceManager() },
        { type: "separator" },
        { type: "checkbox", label: t("transfer.title"), checked: layout.panelVisible.transfer, onSelect: () => {
          const state = useAppStore.getState();
          if (state.layout.panelVisible.transfer) state.setLayout(panelVisibilityPatch(state.layout, "transfer", false));
          else useTransferStore.getState().seed();
        } },
        { label: t("transfer.browseDevice"), disabled: fileDevices.length === 0, children: fileDevices.map((device) => ({ label: deviceLabel(device), onSelect: () => { revealTransferPanel(); void useTransferStore.getState().openDevice(device.id); useTransferStore.getState().restore(); } })) },
        { type: "separator" },
        { label: t("usb.title"), disabled: !isTauri() || !/Win/i.test(navigator.platform), onSelect: () => {
          const selected = devices.find((d) => d.id === useAppStore.getState().selectedDeviceId);
          if (selected?.transport === "ssh") useUsbStore.getState().showRemote(selected.id);
          else useUsbStore.getState().show(selected?.transport === "wsl" ? selected.wsl ?? undefined : undefined);
        } },
      ],
    },
    {
      label: t("shortcuts.runMenu"),
      entries: [
        commandEntry("runFile", t("shortcuts.runFile"), { area: "editor", filePath: openFile ?? undefined }),
        commandEntry("runWithArgs", t("shortcuts.runWithArgs"), { area: "editor", filePath: openFile ?? undefined }),
        { type: "separator" },
        { ...commandEntry("rerun", t("shortcuts.rerun"), runContext), title: currentRun ? `${currentRun.label} @ ${currentRun.device_name}` : undefined },
        { ...commandEntry("stop", t("shortcuts.stop"), runContext), title: currentRun ? `${currentRun.label} @ ${currentRun.device_name}` : undefined },
      ],
    },
    {
      label: t("menu.view"),
      entries: [
        {
          label: t("menu.panels"),
          children: [
            // 面板勾选项由注册表生成：侧栏面板勾选时顺带保证侧栏 dock 可见
            ...panelsInDock("sidebar").filter((panel) => panel.manualVisibility !== false).map((panel): MenuEntry => ({
              type: "checkbox",
              label: t(panel.titleKey),
              checked: layout.panelVisible[panel.id],
              onSelect: () => setLayout({ ...panelVisibilityPatch(layout, panel.id, !layout.panelVisible[panel.id]), sidebarVisible: true }),
            })),
            { type: "separator" },
            ...panelsInDock("center").filter((panel) => panel.manualVisibility !== false).map((panel): MenuEntry => panel.toggleCommand ? {
              ...commandEntry(panel.toggleCommand, t(`shortcuts.${panel.toggleCommand}`)),
              type: "checkbox",
              checked: layout.panelVisible[panel.id] && !layout.panelCollapsed[panel.id],
            } : ({
              type: "checkbox",
              label: t(panel.titleKey),
              checked: layout.panelVisible[panel.id],
              onSelect: () => setLayout(panelVisibilityPatch(layout, panel.id, !layout.panelVisible[panel.id])),
            })),
          ],
        },
        { ...commandEntry("toggleSidebar", t("menu.sidebar")), type: "checkbox", checked: layout.sidebarVisible },
        commandEntry("focusEditor", t("shortcuts.focusEditor")),
        commandEntry("toggleConsole", t("shortcuts.toggleConsole")),
        commandEntry("newTerminal", t("shortcuts.newTerminal")),
        {
          label: t("menu.sidebarPosition"),
          children: [
            { type: "checkbox", label: t("menu.left"), checked: layout.sidebarPosition === "left", onSelect: () => setLayout({ sidebarPosition: "left" }) },
            { type: "checkbox", label: t("menu.right"), checked: layout.sidebarPosition === "right", onSelect: () => setLayout({ sidebarPosition: "right" }) },
          ],
        },
        { type: "separator" },
        { label: t("menu.zoomIn"), shortcut: `${shortcutModifier}++`, disabled: uiZoom >= UI_ZOOM_LEVELS[UI_ZOOM_LEVELS.length - 1], onSelect: () => onUiZoom("in") },
        { label: t("menu.zoomOut"), shortcut: `${shortcutModifier}+-`, disabled: uiZoom <= UI_ZOOM_LEVELS[0], onSelect: () => onUiZoom("out") },
        { label: t("menu.resetZoom", { percent: uiZoom }), shortcut: `${shortcutModifier}+0`, disabled: uiZoom === 100, onSelect: () => onUiZoom("reset") },
        { type: "separator" },
        { label: t("menu.resetLayout"), onSelect: () => resetLayout() },
      ],
    },
    {
      label: t("menu.settings"),
      entries: [
        {
          label: t("menu.language"),
          children: [
            { type: "checkbox", label: t("menu.followSystem"), checked: languagePreference === "system", onSelect: () => chooseLanguage("system") },
            { type: "checkbox", label: "中文", checked: languagePreference === "zh", onSelect: () => chooseLanguage("zh") },
            { type: "checkbox", label: "English", checked: languagePreference === "en", onSelect: () => chooseLanguage("en") },
          ],
        },
        {
          label: t("menu.theme"),
          children: [
            { type: "checkbox", label: t("menu.lightTheme"), checked: themePreference === "light", onSelect: () => chooseTheme("light") },
            { type: "checkbox", label: t("menu.darkTheme"), checked: themePreference === "dark", onSelect: () => chooseTheme("dark") },
            { type: "checkbox", label: t("menu.followSystem"), checked: themePreference === "system", onSelect: () => chooseTheme("system") },
          ],
        },
        { type: "separator" },
        {
          label: t("menu.titlebarPathDisplay"),
          children: [
            { type: "checkbox", label: t("menu.shortPath"), checked: pathDisplay === "short", onSelect: () => setPathDisplay("short") },
            { type: "checkbox", label: t("menu.fullPath"), checked: pathDisplay === "full", onSelect: () => setPathDisplay("full") },
          ],
        },
        {
          label: t("menu.tabCycleOrder"),
          children: [
            { type: "checkbox", label: t("menu.tabCycleSequential"), checked: tabCycleOrder === "sequential", onSelect: () => setTabCycleOrder("sequential") },
            { type: "checkbox", label: t("menu.tabCycleMru"), checked: tabCycleOrder === "mru", onSelect: () => setTabCycleOrder("mru") },
          ],
        },
        {
          label: t("menu.terminalSettings"),
          children: [
            { type: "checkbox", label: t("menu.copyOnCtrlC"), title: t("menu.copyOnCtrlCHint"), checked: clipboardPreferences.copyOnCtrlC, onSelect: () => clipboardPreferences.setCopyOnCtrlC(!clipboardPreferences.copyOnCtrlC) },
            { type: "checkbox", label: t("menu.pasteOnCtrlV"), title: t("menu.pasteOnCtrlVHint"), checked: clipboardPreferences.pasteOnCtrlV, onSelect: () => clipboardPreferences.setPasteOnCtrlV(!clipboardPreferences.pasteOnCtrlV) },
            { type: "checkbox", label: t("menu.copyOnSelect"), title: t("menu.copyOnSelectHint"), checked: copyOnSelect, onSelect: () => setCopyOnSelect(!copyOnSelect) },
          ],
        },
        { type: "separator" },
        { type: "checkbox", label: t("menu.autostart"), disabled: !isTauri(), checked: autostart, onSelect: toggleAutostart },
      ],
    },
    {
      label: t("menu.help"),
      entries: [
        { label: t("shortcuts.title"), onSelect: () => useCommandUiStore.setState({ shortcutsOpen: true }) },
        { label: t("menu.checkUpdate"), disabled: !isTauri(), onSelect: onCheckUpdate },
        { label: t("menu.about"), onSelect: onAbout },
      ],
    },
  ];

  return (
    <div className="menubar" role="menubar" aria-label={t("menu.ariaLabel")} ref={barRef}>
      {menus.map((menu, index) => (
        <div className="menubar-entry" key={menu.label}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === index}
            className={`menubar-title${openMenu === index ? " open" : ""}`}
            onClick={() => setOpenMenu(openMenu === index ? null : index)}
            onMouseEnter={() => { if (openMenu !== null) setOpenMenu(index); }}
          >
            {menu.label}
          </button>
          {openMenu === index && (
            <div className="menu-dropdown" role="menu">
              {menu.entries.map((entry, entryIndex) => (
                <MenuItem key={entryIndex} entry={entry} close={() => setOpenMenu(null)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
