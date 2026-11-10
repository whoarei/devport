import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTransferStore } from "../transferStore";
import { TransferPlanDialog } from "./TransferPlanDialog";
import { TransferDetailsDialog } from "./TransferQueue";
import { Icon } from "./Icon";

export function WorkspaceTransferDialogs() {
  const { t } = useTranslation();
  const plan = useTransferStore((s) => s.planOwner === "workspace" ? s.plan : null);
  const task = useTransferStore((s) => s.tasks.find((task) => task.id === s.inlineDetailsId));
  const actionError = useTransferStore((s) => s.inlineActionError);
  const notice = useTransferStore((s) => s.inlineNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      if (useTransferStore.getState().inlineNotice === notice) useTransferStore.setState({ inlineNotice: null });
    }, 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  return <>
    {notice && <div className="workspace-transfer-notice" role="status">
      <Icon name="info" /><span>{notice.message}</span>
      <button aria-label={t("transfer.dismiss")} onClick={() => useTransferStore.setState({ inlineNotice: null })}><Icon name="close" /></button>
    </div>}
    {plan && <TransferPlanDialog key={plan.id} plan={plan} />}
    {task && <TransferDetailsDialog task={task} actionError={actionError?.id === task.id ? actionError.message : undefined} onClose={() => useTransferStore.setState({ inlineDetailsId: null })}
      onRetry={() => void useTransferStore.getState().retry(task.id, "workspace")}
      onShowTask={(id) => useTransferStore.setState({ inlineDetailsId: id })} />}
  </>;
}
