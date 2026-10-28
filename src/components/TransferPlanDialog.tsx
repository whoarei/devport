import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useTransferStore } from "../transferStore";
import { workspaceSourceRevision } from "../workspaceRun";
import { sameTransferFilename, transferApi, transferBytes, type ConflictPolicy, type TransferPlan } from "../transferApi";
import "../fileTransfer.css";

export function TransferPlanDialog({ plan }: { plan: TransferPlan }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>(plan.keep_both ? "keep_both" : "skip");
  const [preserve, setPreserve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useAppStore((s) => s.devices);
  const revisions = useRef([workspaceSourceRevision(plan.request.source, devices), workspaceSourceRevision(plan.request.target, devices)]);
  const stale = revisions.current[0] !== workspaceSourceRevision(plan.request.source, devices)
    || revisions.current[1] !== workspaceSourceRevision(plan.request.target, devices);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  const start = async () => {
    if (busy || stale) return;
    setBusy(true); setError(null);
    try {
      const id = await transferApi.start(plan.id, policy, preserve);
      useTransferStore.getState().register(id);
      useTransferStore.setState({ plan: null, inlinePlanOrigin: null });
      await useTransferStore.getState().refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const overwriteProtected = plan.items.some((i) => plan.request.protected_paths.some((path) => sameTransferFilename(path, i.path, plan.request.target)));
  return <dialog ref={ref} className="transfer-plan-dialog" aria-labelledby="transfer-plan-title" onCancel={(event) => { event.preventDefault(); if (!busy) useTransferStore.getState().discard(); }}>
    <h2 id="transfer-plan-title">{t("transfer.review")}</h2>
    <p className="transfer-endpoint">{workspaceLabel(plan.request.source, devices)}<br />→ {workspaceLabel(plan.request.target, devices)}</p>
    <p>{t("transfer.planSummary", { count: plan.items.length, bytes: transferBytes(plan.total_bytes), conflicts: plan.conflicts })}</p>
    <label>{t("transfer.conflictPolicy")}<select value={policy} disabled={busy} onChange={(e) => setPolicy(e.target.value as ConflictPolicy)}>
      <option value="keep_both" disabled={!plan.keep_both}>{t("transfer.keepBoth")}</option><option value="skip">{t("transfer.skip")}</option>
      <option value="overwrite" disabled={!plan.overwrite || overwriteProtected}>{t("transfer.overwrite")}</option>
    </select></label>
    {!plan.overwrite && <p className="transfer-hint">{t("transfer.noOverwrite")}</p>}
    {!plan.keep_both && <p className="transfer-hint">{t("transfer.noKeepBoth")}</p>}
    {overwriteProtected && <p className="transfer-hint">{t("transfer.protectedFiles")}</p>}
    <label className="transfer-checkbox"><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />{t("transfer.preserveExecutable")}</label>
    <p className="transfer-hint">{t("transfer.copyHint")}</p>
    {plan.warnings.length > 0 && <details><summary>{t("transfer.warnings", { count: plan.warnings.length })}</summary><ul>{plan.warnings.slice(0, 100).map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    {(error || stale) && <p role="alert" className="transfer-error">{stale ? t("transfer.directoryChanged") : error}</p>}
    <div className="transfer-dialog-actions"><button disabled={busy} onClick={() => useTransferStore.getState().discard()}>{t("transfer.cancel")}</button><button disabled={busy || stale} onClick={() => void start()}>{t("transfer.start")}</button></div>
  </dialog>;
}
