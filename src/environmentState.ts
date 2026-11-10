import type { DeviceProfile, WorkspaceRef } from "./api";
import type { EditorLanguage, EditorTab } from "./editorDocument";
import { editorFileKey, type EditorFileSource } from "./editorSources";

export interface EditorLocation { anchor: number; head: number; scroll_top: number; scroll_left: number }
export interface FileDraft { content: string; saved_content: string; revision: string; eol: "lf" | "crlf"; bom: boolean }
export interface FileSession { name: string; language: EditorLanguage; view?: EditorLocation; draft?: FileDraft; source?: EditorFileSource }
export interface WorkspaceSession {
  workspace: WorkspaceRef; files: FileSession[]; active_file: string | null;
  expanded: string[]; tree_scroll: number;
}
export interface TerminalDescriptor {
  id: string; device_id: string; workspace?: { workspace: WorkspaceRef; subdir: string };
}
export interface WindowGeometry { x: number; y: number; width: number; height: number; maximized: boolean }
export interface TransferOptions { device_id: string | null; hidden: boolean; exclude: boolean }
export interface WorkEnvironment {
  version: 1; current: WorkspaceRef | null; workspaces: WorkspaceSession[];
  terminals: TerminalDescriptor[]; active_terminal: string | null;
  transfer: TransferOptions; window: WindowGeometry | null;
  device_files?: FileSession[]; active_device_file?: string | null;
}
export const emptyEnvironment = (): WorkEnvironment => ({ version: 1, current: null, workspaces: [],
  terminals: [], active_terminal: null, transfer: { device_id: null, hidden: false, exclude: false }, window: null });
export const environmentKey = (workspace: WorkspaceRef) => JSON.stringify(workspace);

/** Session-only devices must never leave broken terminals, workspaces or drafts on restart. */
export function persistentEnvironment(environment: WorkEnvironment, devices: DeviceProfile[]): WorkEnvironment {
  const temporary = new Set(devices.filter((device) => device.temporary).map((device) => device.id));
  const keep = (workspace: WorkspaceRef | null) => workspace?.type !== "device" || !temporary.has(workspace.device_id);
  const terminals = environment.terminals.filter((tab) => !temporary.has(tab.device_id) && (!tab.workspace || keep(tab.workspace.workspace)));
  const files = environment.device_files?.filter((file) => !file.source || keep(file.source.workspace));
  return { ...environment, current: keep(environment.current) ? environment.current : null,
    workspaces: environment.workspaces.filter((view) => keep(view.workspace)),
    terminals, active_terminal: terminals.some((tab) => tab.id === environment.active_terminal) ? environment.active_terminal : null,
    transfer: { ...environment.transfer, device_id: temporary.has(environment.transfer.device_id ?? "") ? null : environment.transfer.device_id },
    ...(files ? { device_files: files, active_device_file: files.some((file) => file.name === environment.active_device_file) ? environment.active_device_file : null } : {}) };
}

export function restoredTab(file: FileSession): EditorTab {
  return { name: file.source ? editorFileKey(file.source) : file.name, ...(file.source ? { source: file.source } : {}), language: file.language, view: file.view, recovery: file.draft, loaded: false,
    fileContent: file.draft?.content ?? "", savedContent: file.draft?.saved_content ?? "",
    revision: file.draft?.revision ?? "", eol: file.draft?.eol ?? "lf", bom: file.draft?.bom ?? false,
    conflict: false, generation: 1 };
}

export function captureWorkspace(state: { workspace: WorkspaceRef | null; openTabs: EditorTab[]; activeFile: string | null;
  workspaceTree: Record<string, { expanded: boolean }>; workspaceScroll: number }): WorkspaceSession | null {
  if (!state.workspace) return null;
  const tabs = state.openTabs.filter((tab) => !tab.source);
  return { workspace: state.workspace, active_file: tabs.some((tab) => tab.name === state.activeFile) ? state.activeFile : tabs[0]?.name ?? null, tree_scroll: state.workspaceScroll,
    expanded: Object.entries(state.workspaceTree).filter(([path, node]) => path && node.expanded).map(([path]) => path),
    files: tabs.map(captureFile) };
}

export function captureFile(tab: EditorTab): FileSession {
  return { name: tab.name, language: tab.language, view: tab.view, ...(tab.source ? { source: tab.source } : {}),
    draft: tab.discardRecovery ? undefined : tab.fileContent !== tab.savedContent ? { content: tab.fileContent, saved_content: tab.savedContent,
      revision: tab.revision, eol: tab.eol, bom: tab.bom } : tab.recovery };
}
