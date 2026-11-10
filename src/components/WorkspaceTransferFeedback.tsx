import { useTranslation } from "react-i18next";
import { workspaceRefEquals, type WorkspaceRef } from "../api";
import { useTransferStore } from "../transferStore";

export function WorkspaceTransferFeedback({ workspace }: { workspace: WorkspaceRef | null }) {
  const { t } = useTranslation();
  const error = useTransferStore((s) => s.inlineError);
  if (!error || !workspaceRefEquals(workspace, error.workspace)) return null;
  return <div className="workspace-error" role="alert">
    <span>{error.path}: {error.message}</span>
    <button onClick={() => useTransferStore.setState({ inlineError: null })}>{t("transfer.dismiss")}</button>
  </div>;
}
