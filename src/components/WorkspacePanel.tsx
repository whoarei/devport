import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { appCommandEnabled, executeAppCommand } from "../appCommands";
import { shortcutLabel } from "../shortcuts";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, type DeviceProfile, type WorkspaceEntry, type WorkspaceRef } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useTerminalStore } from "../terminalStore";
import { useCommandUiStore } from "../commandUiStore";
import { revealConsolePanel } from "../consoleTabs";
import { useTransferStore } from "../transferStore";
import { openWorkspace } from "../workspacePicker";
import { joinPath, WORKSPACE_ROOT, WorkspacePath, WorkspaceTree } from "../workspaceTree";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";
import { deviceLabel } from "./DeviceEditor";
import { PanelTitle } from "./PanelTitle";
import { preserveContentFocus } from "../focus";
import { workspaceRunMenu } from "../workspaceRunMenu";
import { useWorkspaceRunStore } from "../workspaceRunStore";
import { workspaceSourceRevision } from "../workspaceRun";
import { workspacePresentation } from "../workspacePresentation";
import { FileIcon, Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

type Editing =
  | { mode: "create-file"; dir: WorkspacePath }
  | { mode: "create-dir"; dir: WorkspacePath }
  | { mode: "rename"; dir: WorkspacePath; entry: WorkspaceEntry };

interface PendingDelete {
  path: WorkspacePath;
  isDir: boolean;
}

/** 最近的工作区菜单项（扁平列出，与「文件」菜单同源）；无记录时为置灰占位 */
function recentWorkspaceEntries(
  t: (key: string) => string,
  recentWorkspaces: WorkspaceRef[],
  devices: DeviceProfile[],
): MenuEntry[] {
  if (recentWorkspaces.length === 0) return [{ label: t("menu.noRecent"), disabled: true, onSelect: () => {} }];
  return recentWorkspaces.map((workspace) => ({
    label: workspaceLabel(workspace, devices) ?? "",
    onSelect: () => void openWorkspace(workspace),
  }));
}

/** 未打开工作区时的右键菜单：打开工作区 + 打开设备工作区 + 最近的工作区 */
export function workspacePickerMenuEntries(
  t: (key: string) => string,
  recentWorkspaces: WorkspaceRef[],
  devices: DeviceProfile[] = [],
): MenuEntry[] {
  return [
    { label: t("menu.openWorkspace"), detail: shortcutLabel("openWorkspace"), disabled: !appCommandEnabled("openWorkspace"), onSelect: () => void executeAppCommand("openWorkspace") },
    { label: t("menu.openRemoteWorkspace"), detail: shortcutLabel("openRemoteWorkspace"), disabled: !appCommandEnabled("openRemoteWorkspace"), onSelect: () => void executeAppCommand("openRemoteWorkspace") },
    "separator",
    ...recentWorkspaceEntries(t, recentWorkspaces, devices),
  ];
}

/** 已打开工作区时空白区右键的工作区管理项：打开 / 打开设备 / 关闭 / 最近（用于切换） */
export function workspaceSwitchMenuEntries(
  t: (key: string) => string,
  recentWorkspaces: WorkspaceRef[],
  devices: DeviceProfile[] = [],
): MenuEntry[] {
  return [
    { label: t("menu.openWorkspace"), detail: shortcutLabel("openWorkspace"), disabled: !appCommandEnabled("openWorkspace"), onSelect: () => void executeAppCommand("openWorkspace") },
    { label: t("menu.openRemoteWorkspace"), detail: shortcutLabel("openRemoteWorkspace"), disabled: !appCommandEnabled("openRemoteWorkspace"), onSelect: () => void executeAppCommand("openRemoteWorkspace") },
    { label: t("menu.closeWorkspace"), onSelect: () => useAppStore.getState().setWorkspace(null) },
    "separator",
    ...recentWorkspaceEntries(t, recentWorkspaces, devices),
  ];
}

/** 打开双向传输面板并定位所选条目；此入口本身不会开始上传或下载。 */
export function workspaceTransferMenuEntry(
  t: (key: string) => string,
  workspace: WorkspaceRef,
  path?: WorkspacePath,
): MenuEntry {
  return {
    label: t("transfer.title"),
    onSelect: () => useTransferStore.getState().seed(workspace, path),
  };
}

/** 本机目录可交给系统文件管理器；设备工作区没有对应的本机路径。 */
export function workspaceFileManagerMenuEntry(
  t: (key: string) => string,
  workspace: WorkspaceRef,
  subdir: WorkspacePath = WORKSPACE_ROOT,
): MenuEntry | null {
  if (workspace.type !== "local") return null;
  return {
    label: t("workspace.openInFileManager"),
    onSelect: () => {
      void api.openWorkspaceInFileManager(workspace, subdir)
        .catch((error) => useAppStore.setState({ workspaceError: `${t("workspace.openFileManagerFailed")}: ${errorMessage(error)}` }));
    },
  };
}

/**
 * 「在终端中打开」子菜单：本机工作区可落到任意本机（Local）设备；
 * 设备工作区只能落回托管它的那台设备（SSH/WSL 终端启动后 cd 到工作区目录）。
 */
export function workspaceTerminalMenuEntries(
  t: (key: string) => string,
  devices: DeviceProfile[],
  workspace: WorkspaceRef,
  full: boolean,
  onOpen: (device: DeviceProfile) => void,
): MenuEntry[] {
  if (full) return [{ label: t("terminal.maxTabs"), disabled: true }];
  const hosts = workspace.type === "local"
    ? devices.filter((device) => device.transport === "local")
    : devices.filter((device) => device.id === (workspace as { device_id: string }).device_id);
  if (hosts.length === 0) return [{ label: t("workspace.noLocalDevices"), disabled: true }];
  return hosts.map((device) => ({
    label: `${deviceLabel(device)}${device.is_default ? t("device.defaultSuffix") : ""}`,
    onSelect: () => onOpen(device),
  }));
}

interface TreeProps {
  dir: WorkspacePath;
  depth: number;
  tree: WorkspaceTree;
  openFile: string | null;
  /** 打开文件与增删改期间禁用条目点击；目录展开始终可用 */
  disabled: boolean;
  editing: Editing | null;
  onOpen: (path: WorkspacePath, preview: boolean) => void;
  onToggle: (path: WorkspacePath) => void;
  onMenu: (event: MouseEvent, dir: WorkspacePath, entry: WorkspaceEntry | null) => void;
  onEditing: (editing: Editing | null) => void;
}

function InlineInput({ initial, label, onSubmit, onCancel }: {
  initial: string; label: string; onSubmit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    // 重命名时只选中主文件名，扩展名保持可见
    const dot = initial.lastIndexOf(".");
    if (dot > 0) element.setSelectionRange(0, dot);
    else element.select();
  }, [initial]);
  const submit = () => {
    const name = value.trim();
    if (name && name !== initial) onSubmit(name);
    else onCancel();
  };
  return <input
    className="tree-input"
    ref={input}
    aria-label={label}
    value={value}
    onChange={(event) => setValue(event.target.value)}
    onBlur={onCancel}
    // 输入框内不弹面板菜单；WebView 默认菜单由应用入口统一禁用
    onContextMenu={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      // 中文输入法组词期间的 Enter/Esc 是确认/取消候选词，不是提交或取消输入
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); submit(); }
      else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    }}
  />;
}

function TreeLevel(props: TreeProps) {
  const { t } = useTranslation();
  const { dir, depth, tree, openFile, disabled, editing, onOpen, onToggle, onMenu, onEditing } = props;
  const node = tree[dir];
  const workspace = useAppStore((state) => state.workspace);
  useEffect(() => {
    if (node?.expanded && !node.loaded && !node.loading) void useAppStore.getState().loadWorkspaceDir(dir);
  }, [workspace, dir, node?.expanded, node?.loaded]);
  if (!node) return null;
  const creating = editing && editing.mode !== "rename" && editing.dir === dir ? editing : null;
  return (
    <ul className="file-list" style={depth ? { paddingLeft: depth * 12 } : undefined}>
      {creating && <li>
        <InlineInput
          initial=""
          label={creating.mode === "create-file" ? t("workspace.newFileName") : t("workspace.newDirName")}
          onSubmit={(name) => {
            onEditing(null);
            void useAppStore.getState().createWorkspaceEntry(dir, name, creating.mode === "create-file" ? "file" : "dir");
          }}
          onCancel={() => onEditing(null)}
        />
      </li>}
      {node.entries.map((entry) => {
        const path = joinPath(dir, entry.name);
        const child = entry.is_dir ? tree[path] : undefined;
        const renaming = editing?.mode === "rename" && editing.dir === dir && editing.entry.name === entry.name;
        return (
          <li key={entry.name} className={path === openFile ? "active" : ""}>
            {renaming ? (
              <InlineInput
                initial={entry.name}
                label={t("workspace.renameAria", { name: entry.name })}
                onSubmit={(name) => {
                  onEditing(null);
                  void useAppStore.getState().renameWorkspaceEntry(path, name);
                }}
                onCancel={() => onEditing(null)}
              />
            ) : (
              <button
                type="button"
                className="tree-row"
                data-workspace-file={entry.is_dir ? undefined : path}
                disabled={disabled && !entry.is_dir}
                aria-expanded={entry.is_dir ? !!child?.expanded : undefined}
                onClick={() => (entry.is_dir ? onToggle(path) : onOpen(path, true))}
                onDoubleClick={entry.is_dir ? undefined : () => onOpen(path, false)}
                onContextMenu={(event) => onMenu(event, dir, entry)}
              >
                <span className="tree-chevron" aria-hidden="true">
                  {entry.is_dir && <Icon name={child?.expanded ? "chevronDown" : "chevronRight"} />}
                </span>
                <FileIcon name={entry.name} directory={entry.is_dir} expanded={!!child?.expanded} />
                <span className="tree-name">{entry.name}</span>
              </button>
            )}
            {entry.is_dir && child?.expanded && <TreeLevel {...props} dir={path} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

export function WorkspacePanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { t } = useTranslation();
  const {
    workspace,
    workspaceTree,
    workspaceError,
    openFile,
    disabled,
    recentWorkspaces,
    devices,
  } = useAppStore(useShallow((s) => ({
    workspace: s.workspace, workspaceTree: s.workspaceTree, workspaceError: s.workspaceError,
    openFile: s.activeFile,
    disabled: s.saving || s.starting || s.guarding || s.workspaceMutating,
    recentWorkspaces: s.recentWorkspaces,
    devices: s.devices,
  })));
  const tabsFull = useTerminalStore((s) => s.tabs.length >= 8);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const label = workspaceLabel(workspace, devices);
  const presentation = workspace ? workspacePresentation(workspace, devices) : null;
  const panel = useRef<HTMLDivElement>(null);
  const focus = useCommandUiStore((state) => state.focus);
  useEffect(() => {
    if (focus !== "workspace" || collapsed || !panel.current) return;
    panel.current.focus({ preventScroll: true });
    useCommandUiStore.setState({ focus: null });
  }, [focus, collapsed]);
  const scrolling = useRef(false);
  useEffect(() => {
    if (!panel.current || collapsed) return;
    scrolling.current = true;
    panel.current.scrollTop = useAppStore.getState().workspaceScroll;
    const frame = requestAnimationFrame(() => { scrolling.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [workspace, workspaceTree, collapsed]);

  // 折叠面板或切换工作区时收起菜单与行内输入，避免操作落到错误的目录
  const sourceRevision = workspaceSourceRevision(workspace, devices);
  useEffect(() => { setMenu(null); setEditing(null); }, [collapsed, workspace, sourceRevision]);

  const startCreate = async (dir: WorkspacePath, mode: "create-file" | "create-dir") => {
    const node = useAppStore.getState().workspaceTree[dir];
    // 折叠目录（包括从未展开、还没有缓存节点的目录）中新建时先展开，
    // 否则行内输入框会落在不可见的子树里
    if (dir !== WORKSPACE_ROOT && !node?.expanded) await useAppStore.getState().toggleWorkspaceDir(dir);
    setEditing({ mode, dir });
  };

  /** 在工作区（子）目录中打开设备终端：先展开控制面板区；失败复用工作区错误条展示 */
  const openInTerminal = (device: DeviceProfile, subdir: WorkspacePath) => {
    if (!workspace) return;
    revealConsolePanel();
    void useTerminalStore.getState()
      .open(device.id, device.name, { workspace, subdir })
      .catch((error) => useAppStore.setState({ workspaceError: errorMessage(error) }));
  };

  const menuEpoch = useRef(0);
  const openMenu = async (event: MouseEvent, dir: WorkspacePath, entry: WorkspaceEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workspace) return;    const path = entry ? joinPath(dir, entry.name) : dir;
    const epoch = ++menuEpoch.current;
    const x = event.clientX, y = event.clientY;
    void useWorkspaceRunStore.getState().refreshCommands();
    const entries: MenuEntry[] = await workspaceRunMenu(workspace, path, !entry || entry.is_dir);
    if (epoch !== menuEpoch.current || workspace !== useAppStore.getState().workspace || sourceRevision !== workspaceSourceRevision(workspace, useAppStore.getState().devices)) return;
    entries.push(workspaceTransferMenuEntry(t, workspace, entry ? path : undefined));
    if (!entry) entries.push({ label: t("workspace.refresh"), onSelect: () => void useAppStore.getState().loadWorkspaceDir(dir) });
    // 新建入口只出现在目录与空白区；文件条目上只有打开/重命名/删除
    if (!entry || entry.is_dir) {
      const fileManagerEntry = workspaceFileManagerMenuEntry(t, workspace, path);
      if (fileManagerEntry) entries.push(fileManagerEntry);
      entries.push({ label: t("workspace.newFile"), onSelect: () => void startCreate(path, "create-file") });
      entries.push({ label: t("workspace.newDir"), onSelect: () => void startCreate(path, "create-dir") });
      // 目录与空白区（工作区根）可落在设备终端：本机工作区列出本机设备，设备工作区列出宿主设备
      entries.push({
        label: t("workspace.openInTerminal"),
        children: workspaceTerminalMenuEntries(t, devices, workspace, tabsFull, (device) => openInTerminal(device, path)),
      });
    }
    // 空白区附带工作区管理项：打开 / 关闭 / 最近（切换工作区与打开走同一条确认路径）
    if (!entry) entries.push("separator", ...workspaceSwitchMenuEntries(t, recentWorkspaces, devices));
    if (entry) {
      entries.push("separator");
      if (!entry.is_dir) entries.push({ label: t("workspace.open"), onSelect: () => void useAppStore.getState().openWorkspaceFile(path) });
      entries.push({ label: t("workspace.rename"), onSelect: () => setEditing({ mode: "rename", dir, entry }) });
      entries.push({ label: t("workspace.delete"), danger: true, onSelect: () => setPendingDelete({ path, isDir: entry.is_dir }) });
    }
    setMenu({
      ...contextMenuPosition(x, y, entries.length),
      entries,
    });
  };

  // 未打开工作区时右键给出打开入口，与菜单栏「文件」一致
  const openPickerMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const entries = workspacePickerMenuEntries(t, recentWorkspaces, devices);
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  const confirmRequest: ConfirmRequest | null = useMemo(() => pendingDelete ? {
    title: pendingDelete.isDir ? t("workspace.deleteDirTitle") : t("workspace.deleteFileTitle"),
    message: pendingDelete.isDir
      ? t("workspace.deleteDirMessage", { path: pendingDelete.path })
      : t("workspace.deleteFileMessage", { path: pendingDelete.path }),
    confirmLabel: t("workspace.delete"),
    danger: true,
    onCancel: () => setPendingDelete(null),
    onConfirm: () => {
      const path = pendingDelete.path;
      setPendingDelete(null);
      void useAppStore.getState().deleteWorkspaceEntry(path);
    },
  } : null, [pendingDelete, t]);

  return (
    <div
      className="workspace-panel"
      ref={panel}
      tabIndex={-1}
      onScroll={(event) => {
        if (!scrolling.current) useAppStore.setState({ workspaceScroll: Math.max(0, event.currentTarget.scrollTop) });
      }}
      onContextMenu={collapsed ? undefined : (event) => workspace ? openMenu(event, WORKSPACE_ROOT, null) : openPickerMenu(event)}
    >
      <PanelTitle title={t("workspace.title")} collapsed={collapsed} onToggle={onToggleCollapse} />
      {!collapsed && (
        <>
          {presentation && <div className="workspace-dir" title={label ?? undefined}>
            <Icon name={workspace?.type === "device" ? "server" : "folder"} />
            <div>
              <strong>{presentation.name}</strong>
              {workspace?.type === "device" && <span>{presentation.device ?? t("workspace.remoteDevice")}</span>}
            </div>
            {presentation.transport && <span className="workspace-transport">{presentation.transport.toUpperCase()}</span>}
          </div>}
          {workspaceError && <div className="workspace-error" role="alert">
            <span>{workspaceError}</span>
            <button onMouseDown={preserveContentFocus} onClick={() => useAppStore.getState().dismissWorkspaceError()}>{t("workspace.close")}</button>
          </div>}
          {workspace ? (
            <div className="file-tree">
              <TreeLevel
                dir={WORKSPACE_ROOT}
                depth={0}
                tree={workspaceTree}
                openFile={openFile}
                disabled={disabled}
                editing={editing}
                onOpen={(path, preview) => void useAppStore.getState().openWorkspaceFile(path, { preview })}
                onToggle={(path) => void useAppStore.getState().toggleWorkspaceDir(path)}
                onMenu={openMenu}
                onEditing={setEditing}
              />
            </div>
          ) : <EmptyState icon="folderOpen" title={t("workspace.empty")} description={t("workspace.emptyHint")} compact>
            <button className="primary" disabled={disabled} onClick={() => void executeAppCommand("openWorkspace")}>{t("workspace.openLocal")}</button>
            <button disabled={disabled} onClick={() => void executeAppCommand("openRemoteWorkspace")}>{t("workspace.openRemote")}</button>
          </EmptyState>}
        </>
      )}
      <ContextMenu menu={menu} disabled={disabled} onClose={() => setMenu(null)} />
      <ConfirmDialog request={confirmRequest} />
    </div>
  );
}
