import type { EditorLanguage } from "./editorLanguages";
export type { EditorLanguage } from "./editorLanguages";
export { inferLanguage } from "./editorLanguages";
export type ChangeChoice = "save" | "discard" | "cancel";

/** 一个打开的文件标签：工作区相对路径即标签身份，generation 驱动编辑器 remount */
export interface EditorTab {
  name: string;
  fileContent: string;
  savedContent: string;
  revision: string;
  eol: "lf" | "crlf";
  bom: boolean;
  language: EditorLanguage;
  conflict: boolean;
  generation: number;
  /** A clean preview can be replaced by the next file opened from the tree. */
  preview?: boolean;
  /** Restored descriptors read content only when activated. */
  loaded?: boolean;
  recovery?: import("./environmentState").FileDraft;
  view?: import("./environmentState").EditorLocation;
  discardRecovery?: boolean;
}

export function dirtyTab(tab: Pick<EditorTab, "fileContent" | "savedContent">): boolean {
  return tab.fileContent !== tab.savedContent;
}

export function anyDirty(state: { openTabs: Pick<EditorTab, "fileContent" | "savedContent">[] }): boolean {
  return state.openTabs.some(dirtyTab);
}

/** 按名更新标签，保持数组身份稳定（无变化时返回原数组） */
export function withTab(tabs: EditorTab[], name: string, update: (tab: EditorTab) => EditorTab): EditorTab[] {
  const index = tabs.findIndex((tab) => tab.name === name);
  if (index < 0) return tabs;
  const next = update(tabs[index]);
  if (next === tabs[index]) return tabs;
  const copy = tabs.slice();
  copy[index] = next;
  return copy;
}

/** 关闭标签后的活动标签：优先右侧邻居，否则左侧，都没有则 null */
export function neighborAfterClose(tabs: EditorTab[], closing: string, remaining: EditorTab[]): string | null {
  const index = tabs.findIndex((tab) => tab.name === closing);
  const names = new Set(remaining.map((tab) => tab.name));
  return tabs.slice(index + 1).find((tab) => names.has(tab.name))?.name
    ?? tabs.slice(0, index).reverse().find((tab) => names.has(tab.name))?.name
    ?? remaining[0]?.name ?? null;
}

export function uploadBusy(state: { runs: Record<string, { state: string }> }): boolean {
  return Object.values(state.runs).some((run) => ["preparing", "syncing", "stopping"].includes(run.state));
}
