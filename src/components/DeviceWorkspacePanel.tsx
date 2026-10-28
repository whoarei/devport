import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { errorMessage, workspaceRefEquals } from "../api";
import { createDeviceWorkspaceStore, deviceWorkspaceKey, deviceWorkspaceNode } from "../deviceWorkspaceStore";
import { deviceWorkspaceContextCurrent, deviceWorkspaceEndpoint, deviceWorkspaceFileBlocker, deviceWorkspaceFileContext, mutateDeviceWorkspaceFile, type DeviceWorkspaceFileContext } from "../deviceWorkspaceActions";
import { useAppStore } from "../store";
import { useTransferStore } from "../transferStore";
import { transferActive } from "../transferApi";
import { deviceFileOperationBlocker } from "../transferFileActions";
import { openWorkspace } from "../workspacePicker";
import { joinPath, nameOf, parentOf } from "../workspaceTree";
import { parentDevicePath } from "../directoryCompletion";
import { uploadBusy } from "../editorDocument";
import { preserveContentFocus } from "../focus";
import type { PanelComponentProps } from "../panels/components";
import { ContextMenu, contextMenuPosition, type MenuEntry, type MenuState } from "./ContextMenu";
import { EmptyState } from "./EmptyState";
import { FileIcon, Icon } from "./Icon";
import { PanelTitle } from "./PanelTitle";
import { DirectoryPathInput } from "./DirectoryPathInput";
import { TransferFileDialog, type TransferFileRequest } from "./TransferFileDialog";
import "../fileTransfer.css";

export function DeviceWorkspacePanel({ visible, collapsed, onToggleCollapse }: PanelComponentProps) {
  const { t } = useTranslation();
  const device = useAppStore((s) => s.devices.find((d) => d.id === s.selectedDeviceId));
  const busy = useAppStore((s) => s.loading || s.saving || s.starting || s.guarding || s.updating || s.workspaceMutating || uploadBusy(s));
  // Subscribe to transfer guards as well as editor guards so menu/buttons stay current.
  const transferBusy = useTransferStore((s) => s.deviceMutating || s.planning || !!s.plan
    || s.registeredIds.some((id) => !s.tasks.some((task) => task.id === id))
    || s.tasks.some((task) => transferActive(task.state) && [task.source, task.target].some((endpoint) => endpoint.type === "device" && endpoint.device_id === device?.id)));
  const [browser] = useState(createDeviceWorkspaceStore);
  const { root, tree, key, generation, navigating, mutating, error } = useStore(browser);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [fileRequest, setFileRequest] = useState<{ request: TransferFileRequest; context: DeviceWorkspaceFileContext } | null>(null);
  const sourceKey = deviceWorkspaceKey(device);
  useEffect(() => {
    setMenu(null);
    setActionError(null);
    setFileRequest(null);
    void browser.getState().follow(visible ? device : null);
    return () => { void browser.getState().follow(null); };
  }, [browser, visible, sourceKey]);
  useEffect(() => { setMenu(null); if (!mutating) setFileRequest(null); }, [collapsed, generation]);
  useEffect(() => { setPathDraft(root?.type === "device" ? root.path : ""); }, [root]);
  const listing = useMemo(() => root && tree[""]?.loaded ? { endpoint: root, entries: tree[""].entries, overwrite: false } : null, [root, tree[""]?.entries, tree[""]?.loaded]);

  if (!sourceKey) return null;
  const current = visible && key === sourceKey;
  const navigatingDisabled = busy || opening || mutating || transferBusy || !current;
  const unavailable = navigatingDisabled || navigating || !tree[""]?.loaded;
  const endpoint = (dir: string) => deviceWorkspaceEndpoint(root!, dir);
  const sourceCurrent = () => {
    const app = useAppStore.getState();
    return browser.getState().key === sourceKey && sourceKey === deviceWorkspaceKey(app.devices.find((d) => d.id === app.selectedDeviceId));
  };
  const openAsWorkspace = (dir: string) => { if (!unavailable && sourceCurrent()) void openWorkspace(endpoint(dir)); };
  const navigate = (path: string) => {
    if (navigatingDisabled || !sourceCurrent()) return;
    setMenu(null); setFileRequest(null); setActionError(null);
    void browser.getState().navigate(path);
  };
  const requestAction = async (type: TransferFileRequest["type"], dir: string, name?: string, directory?: boolean) => {
    if (unavailable || !root || !sourceCurrent()) return;
    const version = browser.getState().generation;
    if (!deviceWorkspaceNode(browser.getState().tree, dir)?.loaded) await browser.getState().load(dir);
    if (version !== browser.getState().generation || !workspaceRefEquals(root, browser.getState().root) || !sourceCurrent()) return;
    const context = deviceWorkspaceFileContext(browser, dir);
    const blocked = deviceWorkspaceFileBlocker(browser, context);
    if (blocked || !context) { browser.setState({ error: blocked }); return; }
    setFileRequest({ context, request: { type, name, directory,
      context: { endpoint: endpoint(dir), generation: context.generation, revision: device?.revision ?? null } } });
  };
  const createEntries = (dir: string): MenuEntry[] => {
    const disabled = unavailable || !root || !!deviceFileOperationBlocker(root) || !!deviceWorkspaceNode(tree, dir)?.loading;
    return [
      { label: t("workspace.newFile"), disabled, onSelect: () => requestAction("create-file", dir) },
      { label: t("workspace.newDir"), disabled, onSelect: () => requestAction("create-dir", dir) },
    ];
  };
  const openFile = async (path: string) => {
    if (unavailable || !root || !sourceCurrent()) return;
    setOpening(true);
    setActionError(null);
    try {
      await useAppStore.getState().openDeviceFile(root, path);
    } catch (error) {
      if (browser.getState().key === sourceKey) setActionError(errorMessage(error));
    } finally { setOpening(false); }
  };
  const openMenu = (event: MouseEvent, path: string, directory: boolean) => {
    event.preventDefault(); event.stopPropagation();
    if (!current || !root) return;
    const entries: MenuEntry[] = [
      directory
        ? { label: t("deviceWorkspace.openAsWorkspace"), disabled: unavailable, onSelect: () => openAsWorkspace(path) }
        : { label: t("workspace.open"), disabled: unavailable, onSelect: () => void openFile(path) },
      { label: t("transfer.title"), onSelect: () => useTransferStore.getState().seed(root, path || undefined) },
    ];
    if (directory) {
      if (path) entries.push({ label: t("deviceWorkspace.enterDirectory"), disabled: unavailable, onSelect: () => navigate((endpoint(path) as { path: string }).path) });
      entries.push("separator", ...createEntries(path));
    }
    if (path) {
      const dir = parentOf(path), name = nameOf(path);
      const disabled = !!deviceWorkspaceFileBlocker(browser, deviceWorkspaceFileContext(browser, dir)) || opening;
      entries.push("separator",
        { label: t("workspace.rename"), disabled, onSelect: () => requestAction("rename", dir, name, directory) },
        { label: t("workspace.delete"), disabled, danger: true, onSelect: () => requestAction("delete", dir, name, directory) });
    }
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };
  const level = (dir: string, depth: number): ReactNode => {
    const node = tree[dir];
    if (!node) return null;
    return <ul className="file-list" key={dir}>
      {node.loading && <li className="workspace-empty" role="status">{t("transfer.loading")}</li>}
      {node.error && <li className="workspace-error" role="alert"><span>{node.error}</span>
        <button onClick={() => void browser.getState().load(dir)}>{t("deviceWorkspace.retry")}</button></li>}
      {node.loaded && !node.entries.length && <li className="workspace-empty">{t("deviceWorkspace.empty")}</li>}
      {node.entries.map((entry) => {
        const path = joinPath(dir, entry.name);
        const directory = entry.kind === "dir";
        const expanded = !!tree[path]?.expanded;
        return <li key={entry.name}>
          <button className="tree-row" style={{ paddingLeft: 10 + depth * 12 }}
            title={directory ? t("deviceWorkspace.directoryHint") : t("deviceWorkspace.openFileHint")}
            disabled={unavailable} aria-expanded={directory ? expanded : undefined}
            onClick={(event) => { if (!directory) void openFile(path); else if (event.detail < 2) void browser.getState().toggle(path); }}
            onDoubleClick={directory ? () => navigate((endpoint(path) as { path: string }).path) : undefined}
            onContextMenu={(event) => openMenu(event, path, directory)}>
            <span className="tree-chevron" aria-hidden="true">{directory && <Icon name={expanded ? "chevronDown" : "chevronRight"} />}</span>
            <FileIcon name={entry.name} directory={directory} expanded={expanded} />
            <span className="tree-name">{entry.name}</span>
          </button>
          {directory && expanded && level(path, depth + 1)}
        </li>;
      })}
    </ul>;
  };
  return <div className="workspace-panel device-workspace-panel" onContextMenu={collapsed ? undefined : (event) => openMenu(event, "", true)}>
    <PanelTitle title={t("deviceWorkspace.title")} collapsed={collapsed} onToggle={onToggleCollapse}>
      <button className="device-workspace-action" disabled={unavailable} title={t("deviceWorkspace.newEntry")} aria-label={t("deviceWorkspace.newEntry")}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const entries = createEntries(""); setMenu({ ...contextMenuPosition(rect.left, rect.bottom, entries.length), entries }); }}><Icon name="plus" /></button>
      <button className="device-workspace-action" onMouseDown={preserveContentFocus} disabled={navigatingDisabled || navigating || tree[""]?.loading} title={t("workspace.refresh")} aria-label={t("workspace.refresh")}
        onClick={() => { setMenu(null); void browser.getState().refresh(); }}><Icon name="refresh" /></button>
      <button className="device-workspace-action" disabled={unavailable} title={t("deviceWorkspace.openAsWorkspace")} aria-label={t("deviceWorkspace.openAsWorkspace")}
        onClick={() => openAsWorkspace("")}><Icon name="folderOpen" /></button>
    </PanelTitle>
    {!collapsed && <>
      <div className="device-workspace-navigation" onContextMenu={(event) => event.stopPropagation()}>
        <button className="device-workspace-action" disabled={navigatingDisabled || navigating || root?.type !== "device" || root.path === "/"} title={t("transfer.up")} aria-label={t("transfer.up")}
          onClick={() => root?.type === "device" && navigate(parentDevicePath(root.path))}><Icon name="arrowUp" /></button>
        <button className="device-workspace-action" disabled={navigatingDisabled || navigating} title={t("transfer.resetDeviceRoot")} aria-label={t("transfer.resetDeviceRoot")}
          onClick={() => { setMenu(null); setFileRequest(null); void browser.getState().resetRoot(); }}><Icon name="server" /></button>
        <DirectoryPathInput value={pathDraft} endpoint={root} contextKey={`${sourceKey}:${generation}`} directory={listing}
          disabled={navigatingDisabled} label={t("deviceWorkspace.path")} placeholder={device?.workspace_root}
          onChange={setPathDraft} onNavigate={navigate} />
        <button className="device-workspace-action" disabled={navigatingDisabled || !pathDraft.trim()} title={t("transfer.go")} aria-label={t("transfer.go")}
          onClick={() => navigate(pathDraft)}><Icon name="arrowRight" /></button>
      </div>
      {actionError && <div className="workspace-error" role="alert"><span>{actionError}</span></div>}
      {error && <div className="workspace-error" role="alert"><span>{error}</span><button onClick={() => browser.setState({ error: null })}>{t("workspace.close")}</button></div>}
      {navigating && <div className="workspace-empty" role="status">{t("transfer.loading")}</div>}
      {current && level("", 0)}
      {!current && <EmptyState compact icon="folder" title={t("transfer.loading")} />}
    </>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {fileRequest && <TransferFileDialog request={fileRequest.request} onClose={() => setFileRequest(null)} controller={{
      current: () => deviceWorkspaceContextCurrent(browser, fileRequest.context),
      mutate: (action) => mutateDeviceWorkspaceFile(browser, fileRequest.context, action),
      error: () => browser.getState().error ?? t("transfer.directoryChanged"),
    }} />}
  </div>;
}
