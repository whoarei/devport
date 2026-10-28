import type { WorkspaceRef } from "./api";
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
