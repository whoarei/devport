import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage, localWorkspace, WorkspaceRef } from "./api";
import i18n from "./i18n";
import { useAppStore } from "./store";

/**
 * 选择并打开本机工作区目录。传入 recent 时直接打开该工作区，
 * 否则弹出目录选择对话框。错误写入 editorError。
 */
export async function openWorkspace(recent?: WorkspaceRef): Promise<void> {
  try {
    const { workspace, recentWorkspaces, setWorkspace } = useAppStore.getState();
    if (recent) {
      await setWorkspace(recent);
      return;
    }
    const localDefault = (value: WorkspaceRef | null | undefined) =>
      value?.type === "local" ? value.dir : undefined;
    const dir = await open({
      directory: true,
      title: i18n.t("workspace.pickDirTitle"),
      defaultPath: localDefault(workspace) ?? localDefault(recentWorkspaces[0]),
    });
    if (typeof dir === "string") await setWorkspace(localWorkspace(dir));
  } catch (error) {
    useAppStore.setState({ editorError: i18n.t("workspace.openFailed", { message: errorMessage(error) }) });
  }
}
