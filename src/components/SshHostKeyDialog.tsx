import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { HostKeyChange } from "../api";

export interface HostKeyPrompt {
  change: HostKeyChange;
  respond: (confirmed: boolean) => void;
}

export function SshHostKeyDialog({ request }: { request: HostKeyPrompt | null }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request) {
      if (!element.open) element.showModal();
      cancel.current?.focus();
    } else if (element.open) element.close();
  }, [request]);
  return <dialog ref={dialog} className="confirm-dialog ssh-host-key-dialog"
    aria-labelledby={titleId} aria-describedby={messageId}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); request?.respond(false); }}>
    <h3 id={titleId}>{t("device.hostKeyChanged")}</h3>
    <p id={messageId}>{t("device.hostKeyChangedMessage")}</p>
    <dl>
      <dt>{t("device.hostKeyAddress")}</dt><dd>{request?.change.addr}</dd>
      <dt>{t("device.hostKeySaved")}</dt><dd><code>{request?.change.saved_fingerprint}</code></dd>
      <dt>{t("device.hostKeyReceived")}</dt><dd><code>{request?.change.received_fingerprint}</code></dd>
    </dl>
    <div className="dialog-actions">
      <button ref={cancel} type="button" onClick={() => request?.respond(false)}>{t("dialog.cancel")}</button>
      <button type="button" className="danger" onClick={() => request?.respond(true)}>{t("device.hostKeyReplace")}</button>
    </div>
  </dialog>;
}
