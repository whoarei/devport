import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateConfirmationStore } from "../updateConfirmation";
import { Icon } from "./Icon";
import "./UpdateConfirmDialog.css";

export function UpdateConfirmDialog() {
  const { t } = useTranslation();
  const request = useUpdateConfirmationStore((state) => state.request);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request) {
      returnFocus.current = request.returnFocus;
      if (!element.open) element.showModal();
      cancel.current?.focus();
    } else if (element.open) {
      element.close();
      // Update entry buttons are disabled until the awaiting flow releases its latch.
      const target = returnFocus.current;
      const frame = requestAnimationFrame(() => { if (target?.isConnected && !element.open) target.focus(); });
      return () => cancelAnimationFrame(frame);
    }
  }, [request]);

  const dismiss = () => request?.respond(false);
  return <dialog ref={dialog} className="update-confirm-dialog" aria-labelledby="update-confirm-title"
    aria-describedby="update-confirm-description update-confirm-warning"
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
    onClose={() => { if (!dialog.current?.open) dismiss(); }}>
    <div className="update-confirm-body">
      <header className="update-confirm-heading">
        <span className="update-confirm-icon"><Icon name="refresh" width="22" height="22" /></span>
        <div className="update-confirm-intro">
          <h2 id="update-confirm-title">{t("update.confirmTitle")}</h2>
          <p id="update-confirm-description">{t("update.restartAfterInstall")}</p>
        </div>
        <button type="button" className="update-confirm-close" aria-label={t("about.close")} onClick={dismiss}>
          <Icon name="close" width="18" height="18" />
        </button>
      </header>
      {request && <div className="update-confirm-versions" role="group"
        aria-label={t("update.versionChange", { current: request.info.current_version, latest: request.info.latest_version })}>
        <span>{t("about.updateTitle")}</span>
        <code>{request.info.current_version}</code>
        <Icon name="arrowRight" width="14" height="14" />
        <code className="update-confirm-latest">{request.info.latest_version}</code>
      </div>}
      <div className="update-confirm-warning" id="update-confirm-warning">
        <Icon name="alert" width="18" height="18" />
        <div>
          <h3>{t("update.activeTerminals", { count: request?.terminalCount ?? 0 })}</h3>
          <p>{t("update.closeTerminalsConfirm")}</p>
        </div>
      </div>
    </div>
    <footer className="update-confirm-actions dialog-actions">
      <button type="button" ref={cancel} onClick={dismiss}>{t("dialog.cancel")}</button>
      <button type="button" className="primary" onClick={() => request?.respond(true)}>{t("update.closeTerminalsAndInstall")}</button>
    </footer>
  </dialog>;
}
