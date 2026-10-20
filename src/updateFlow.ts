/** 一键更新编排（Tauri 耦合）：标题栏「更新」按钮与关于对话框共用的安装流程。 */
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type AppUpdateInfo } from "./api";
import i18n from "./i18n";
import { useAppStore } from "./store";
import { useTerminalStore, terminalActive } from "./terminalStore";
import { transferActive, transferApi } from "./transferApi";
import { useTransferStore } from "./transferStore";
import { flushWorkEnvironment } from "./workEnvironment";
import {
  directUpdateAction,
  installWithProgress,
  updateInstallBlocker,
  type UpdateButtonPhase,
  type UpdateProgress,
} from "./updateStatus";

/** 安装已固定（checked）的更新。成功时 Windows 进程退出，返回即视为异常。 */
export async function installCheckedUpdate(
  info: AppUpdateInfo,
  onPhase: (phase: UpdateButtonPhase) => void,
): Promise<void> {
  if ((await transferApi.snapshot()).some((task) => transferActive(task.state))) throw new Error(i18n.t("transfer.updateBlocker"));
  useAppStore.setState({ updating: true });
  onPhase({ kind: "downloading", downloaded: 0, total: null });
  try {
    await flushWorkEnvironment();
    await installWithProgress(info.latest_version,
      () => listen<UpdateProgress>("app-update://progress", ({ payload }) => {
        if (payload.phase === "verifying" || payload.phase === "installing") onPhase({ kind: payload.phase });
        else onPhase({ kind: "downloading", downloaded: payload.downloaded, total: payload.total });
      }), api.installAppUpdate);
    // On Windows a successful install command exits the process. Returning is unexpected.
    throw new Error(i18n.t("update.installerNotTakeOver"));
  } finally {
    useAppStore.setState({ updating: false });
  }
}

function installBlocker(): string | null {
  return updateInstallBlocker(useAppStore.getState())
    || (useTransferStore.getState().tasks.some((task) => transferActive(task.state)) ? i18n.t("transfer.updateBlocker") : null)
    || (useTerminalStore.getState().tabs.some(terminalActive) ? i18n.t("about.closeTerminalBlocker") : null);
}

let oneClickRunning = false;

/** 标题栏「更新」按钮：受阻提示原因，便携版打开下载页，否则重新固定后直接安装。 */
export async function startOneClickUpdate(
  info: AppUpdateInfo,
  onPhase: (phase: UpdateButtonPhase | null) => void,
): Promise<void> {
  if (oneClickRunning) return;
  const action = directUpdateAction(info, installBlocker());
  if (action.kind === "blocked") {
    useAppStore.setState({ editorError: action.reason });
    return;
  }
  if (action.kind === "manual") {
    try { await openUrl(action.url); }
    catch (error) { useAppStore.setState({ editorError: i18n.t("update.openBrowserFailed", { message: errorMessage(error) }) }); }
    return;
  }
  oneClickRunning = true;
  onPhase({ kind: "checking" });
  try {
    // Re-pin the exact metadata so install never depends on a stale startup check.
    const fresh = await api.checkAppUpdate();
    if (!fresh) {
      useAppStore.setState({ availableUpdate: null, editorError: i18n.t("update.upToDate") });
      return;
    }
    useAppStore.setState({ availableUpdate: fresh });
    await installCheckedUpdate(fresh, onPhase);
  } catch (error) {
    useAppStore.setState({ editorError: i18n.t("update.autoFailedManual", { message: errorMessage(error) }) });
  } finally {
    oneClickRunning = false;
    onPhase(null);
  }
}
