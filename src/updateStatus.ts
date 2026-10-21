/** 升级流程的纯展示辅助（无 Tauri 依赖，便于单元测试）。 */
import { anyDirty, EditorTab } from "./editorDocument";
import type { AppUpdateInfo } from "./api";
import i18n from "./i18n";

export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total: number | null;
}

export function updateInstallBlocker(state: {
  openTabs: Pick<EditorTab, "fileContent" | "savedContent">[];
  loading: boolean; saving: boolean; starting: boolean; guarding: boolean; workspaceMutating: boolean;
  runs: Record<string, { state: string }>;
}): string | null {
  if (state.loading || state.saving || state.starting || state.guarding || state.workspaceMutating) return i18n.t("update.blockerBusy");
  if (anyDirty(state)) return i18n.t("update.blockerDirty");
  if (Object.values(state.runs).some((run) => ["preparing", "syncing", "running", "stopping"].includes(run.state))) return i18n.t("update.blockerRunning");
  return null;
}

/** Subscribe before invoke; clean up on success and every failure, including listener setup. */
export async function installWithProgress(
  version: string,
  subscribe: () => Promise<() => void>,
  install: (version: string) => Promise<void>,
): Promise<void> {
  const unlisten = await subscribe();
  try { await install(version); }
  finally { unlisten(); }
}

/** 标题栏「更新」按钮的阶段；checking 仅用于一键流程的重新固定检查。 */
export type UpdateButtonPhase =
  | { kind: "checking" }
  | { kind: "closingTerminals" }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "verifying" }
  | { kind: "installing" };

/** 一键更新决策：受阻提示原因，便携版回退下载页，否则直接安装。 */
export type DirectUpdateAction =
  | { kind: "install" }
  | { kind: "blocked"; reason: string }
  | { kind: "manual"; url: string };

export function directUpdateAction(info: AppUpdateInfo, blocker: string | null): DirectUpdateAction {
  if (blocker) return { kind: "blocked", reason: blocker };
  if (!info.can_auto_install) return { kind: "manual", url: info.download_url };
  return { kind: "install" };
}

/** 标题栏按钮的紧凑进度文案。 */
export function updateButtonLabel(phase: UpdateButtonPhase | null): string {
  if (!phase) return i18n.t("update.button");
  switch (phase.kind) {
    case "checking": return i18n.t("update.checking");
    case "closingTerminals": return i18n.t("update.closingTerminals");
    case "downloading": {
      if (phase.total === null || phase.total <= 0) return i18n.t("update.downloadingBytes", { size: formatBytes(phase.downloaded) });
      const percent = Math.min(100, Math.floor((phase.downloaded / phase.total) * 100));
      return i18n.t("update.downloadingPercent", { percent });
    }
    case "verifying": return i18n.t("update.verifying");
    case "installing": return i18n.t("update.installing");
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 下载进度文案；total 未知时只显示已下载体积。 */
export function formatDownloadProgress(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return i18n.t("update.progressBytes", { downloaded: formatBytes(downloaded) });
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return i18n.t("update.progressFull", { downloaded: formatBytes(downloaded), total: formatBytes(total), percent });
}

/** 启动时静默检查：仅在有更新时回调；离线或检查失败不打扰用户。 */
export async function checkForAvailableUpdate(
  check: () => Promise<AppUpdateInfo | null>,
  onAvailable: (info: AppUpdateInfo) => void,
): Promise<void> {
  try {
    const info = await check();
    if (info) onAvailable(info);
  } catch {
    // 静默失败：启动路径不展示更新错误
  }
}
