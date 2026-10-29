import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store";
import { terminalActive, useTerminalStore, type TerminalTab } from "../terminalStore";
import { terminalCloseTargets, type TerminalCloseScope } from "../terminalTabActions";
import { terminalTabLabel } from "../terminalTitle";
import { errorMessage } from "../api";
import { ContextMenu, contextMenuPosition, type MenuEntry, type MenuState } from "./ContextMenu";
import { deviceLabel } from "./DeviceEditor";
import { RunToolbar } from "./RunToolbar";
import { RunConsole } from "./RunConsole";
import { TerminalPage } from "./TerminalPage";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutTitle } from "../shortcuts";
import { Icon } from "./Icon";
import { deviceDisplayNames } from "../workspacePresentation";
import { tabNavigationTarget, useRevealActiveTab } from "../tabStrip";
import { useCommandUiStore } from "../commandUiStore";
import { preserveContentFocus, preserveLayoutFocus } from "../focus";

export function ConsolePanel({ visible, collapsed, onToggleCollapse }: {
  visible: boolean; collapsed: boolean; onToggleCollapse: () => void;
}) {
  const { t } = useTranslation();
  const { tabs, activeTab, select, shuttingDown } = useTerminalStore();
  const devices = useAppStore((s) => s.devices);
  const { updating } = useAppStore(useShallow(s => ({ updating: s.updating, guarding: s.guarding })));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState("");
  const deviceButton = useRef<HTMLButtonElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const keyboardTabFocus = useRef(false);
  const selectTab = (id: string) => {
    keyboardTabFocus.current = false;
    select(id);
    useCommandUiStore.setState({ focus: "console" });
  };
  useRevealActiveTab(tabStrip, activeTab, visible);
  const deviceNames = deviceDisplayNames(devices);
  const defaultDevice = devices.find((device) => device.is_default) ?? devices[0];
  const activeRunId = useAppStore((s) => s.activeRunId);
  const previousRun = useRef(activeRunId);
  useEffect(() => {
    if (activeRunId !== previousRun.current) { keyboardTabFocus.current = false; select("run"); previousRun.current = activeRunId; }
  }, [activeRunId, select]);

  const open = (deviceId: string) => {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
    keyboardTabFocus.current = false;
    setError("");
    if (collapsed) onToggleCollapse();
    void useTerminalStore.getState().open(device.id, device.name).catch((e) => setError(errorMessage(e)));
  };
  const newTerminalEntries = (): MenuEntry[] => devices.length
    ? devices.map((device) => ({
      label: `${deviceLabel(device)}${device.is_default ? t("device.defaultSuffix") : ""}`,
      onSelect: () => open(device.id),
    }))
    : [{ label: t("console.noDevices"), disabled: true, onSelect: () => undefined }];
  const openNewTerminalMenu = (x: number, y: number) => {
    setError("");
    const entries = newTerminalEntries();
    setMenu({ ...contextMenuPosition(x, y, entries.length), entries });
  };
  const toggleMenu = () => {
    if (menu) { setMenu(null); return; }
    const rect = deviceButton.current?.getBoundingClientRect();
    openNewTerminalMenu(rect?.left ?? 0, (rect?.bottom ?? 0) + 4);
  };
  const openTabsBlankMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (updating || shuttingDown || tabs.length >= 8) return;
    openNewTerminalMenu(event.clientX, event.clientY);
  };
  const closeTabs = (ids: string[]) => {
    void Promise.all(ids.map((id) => useTerminalStore.getState().close(id)));
  };
  const openTabMenu = (event: MouseEvent, tab: TerminalTab) => {
    event.preventDefault();
    event.stopPropagation();
    select(tab.id);
    const targets = (scope: TerminalCloseScope) => terminalCloseTargets(tabs, tab.id, scope);
    const others = targets("others");
    const right = targets("right");
    const all = targets("all");
    const sameDeviceAvailable = devices.some((device) => device.id === tab.deviceId);
    const anyBusy = (ids: string[]) => ids.some((id) => tabs.find((candidate) => candidate.id === id)?.busy);
    const entries: MenuEntry[] = [
      {
        label: t("ctxmenu.openSameDevice"),
        disabled: !sameDeviceAvailable || updating || shuttingDown || tabs.length >= 8,
        onSelect: () => open(tab.deviceId),
      },
    ];
    if (!terminalActive(tab) && !tab.busy) entries.push({
      label: t("ctxmenu.reconnect"),
      onSelect: () => void useTerminalStore.getState().reconnect(tab.id),
    });
    entries.push(
      "separator",
      {
        label: t("ctxmenu.closeTerminal"), danger: true, disabled: tab.busy,
        onSelect: () => closeTabs(targets("current")),
      },
      {
        label: t("ctxmenu.closeOtherTerminals", { count: others.length }), danger: true,
        disabled: others.length === 0 || anyBusy(others), onSelect: () => closeTabs(others),
      },
      {
        label: t("ctxmenu.closeTerminalsToRight", { count: right.length }), danger: true,
        disabled: right.length === 0 || anyBusy(right), onSelect: () => closeTabs(right),
      },
      {
        label: t("ctxmenu.closeAllTerminals", { count: all.length }), danger: true,
        disabled: all.length === 0 || anyBusy(all), onSelect: () => closeTabs(all),
      },
    );
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };
  const contentVisible = visible && !collapsed;
  return <div className="console-panel">
    <div className="console-tabs-bar center-panel-header">
      <button className="console-collapse center-panel-collapse" aria-label={collapsed ? t("console.expand") : t("console.collapse")} aria-expanded={!collapsed} onMouseDown={preserveContentFocus} onClick={() => preserveLayoutFocus(onToggleCollapse)}><Icon name={collapsed ? "chevronRight" : "chevronDown"} /></button>
      <div ref={tabStrip} className="console-tabs" role="tablist" aria-label={t("console.tabsAria")} onContextMenu={openTabsBlankMenu} onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
        const next = tabNavigationTarget(["run", ...tabs.map((tab) => tab.id)], activeTab, event.key);
        if (!next) return;
        event.preventDefault();
        keyboardTabFocus.current = true;
        select(next); document.getElementById(`tab-${next}`)?.focus();
      }}>
        <button role="tab" id="tab-run" data-active-tab={activeTab === "run"} aria-controls="panel-run" aria-selected={activeTab === "run"} tabIndex={activeTab === "run" ? 0 : -1} onClick={() => selectTab("run")}>{t("console.runTab")}</button>
        {tabs.map((tab) => {
          const device = devices.find((candidate) => candidate.id === tab.deviceId);
          const deviceName = device?.name.trim() || tab.deviceName;
          const label = terminalTabLabel(tab, device, deviceNames.get(tab.deviceId));
          const title = t("console.terminalTitle", { name: tab.title ?? deviceName, device: deviceName });
          return <div className={`console-tab${activeTab === tab.id ? " active" : ""}`} data-active-tab={activeTab === tab.id} key={tab.id} onContextMenu={(event) => openTabMenu(event, tab)}>
            <button role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)} title={title} aria-label={title}>
              <span className={`terminal-dot terminal-${tab.status?.state ?? "connecting"}`} aria-hidden="true" />
              <span className="terminal-tab-label">{t("console.terminalTab", { name: label })}</span>
            </button>
            <button className="terminal-tab-close" tabIndex={activeTab === tab.id ? 0 : -1} disabled={tab.busy} aria-label={t("console.closeTerminalAria", { name: label })} onMouseDown={preserveContentFocus} onClick={() => void preserveLayoutFocus(() => useTerminalStore.getState().close(tab.id))}><Icon name="close" /></button>
          </div>;
        })}
      </div>
      <div className="terminal-add-group">
        <button className="terminal-add" aria-label={t("console.newDefaultTerminal")} title={shortcutTitle(defaultDevice
          ? t("console.newDefaultTerminalTitle", { name: defaultDevice.name })
          : t("console.noDefaultDevice"), "newTerminal")}
          disabled={!appCommandEnabled("newTerminal")}
          onClick={() => void executeAppCommand("newTerminal")}><Icon name="plus" /></button>
        <button className="terminal-device-picker" ref={deviceButton} aria-label={t("console.chooseTerminalDevice")}
          title={t("console.chooseTerminalDevice")} aria-haspopup="menu" aria-expanded={!!menu}
          disabled={updating || shuttingDown || tabs.length >= 8} onClick={toggleMenu}>
          <Icon name="chevronDown" />
        </button>
      </div>
    </div>
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <section className="run-page" role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={!contentVisible || activeTab !== "run"}>
      <RunToolbar />
      <RunConsole collapsed={!contentVisible || activeTab !== "run"} onToggleCollapse={onToggleCollapse} embedded autoFocus={!keyboardTabFocus.current} />
    </section>
    {tabs.map((tab) => <TerminalPage key={tab.id} tab={tab} visible={contentVisible && activeTab === tab.id} autoFocus={!keyboardTabFocus.current} />)}
  </div>;
}
