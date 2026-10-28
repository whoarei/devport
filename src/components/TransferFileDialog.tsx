import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, workspaceLabel } from "../store";
import { appendEndpoint } from "../transferApi";
import { deviceFileContextCurrent, mutateDeviceFile, validDeviceFilename, type DeviceFileContext, type DeviceFileAction } from "../transferFileActions";
import { useTransferStore } from "../transferStore";

export interface TransferFileRequest {
  context: DeviceFileContext;
  type: "create-file" | "create-dir" | "rename" | "delete";
  name?: string;
  directory?: boolean;
}

export interface FileDialogController {
  current: () => boolean;
  mutate: (action: DeviceFileAction) => Promise<boolean>;
  error: () => string | null;
}

export function TransferFileDialog({ request, onClose, controller }: { request: TransferFileRequest; onClose: () => void; controller?: FileDialogController }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(request.type === "rename" ? request.name ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useAppStore((s) => s.devices);
  const deleting = request.type === "delete";
  const title = t(request.type === "create-file" ? "workspace.newFile" : request.type === "create-dir" ? "workspace.newDir" : deleting ? "workspace.delete" : "workspace.rename");
  const endpoint = request.name ? appendEndpoint(request.context.endpoint, request.name) : request.context.endpoint;
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    if (input.current) { input.current.focus(); input.current.select(); }
  }, []);
  const submit = async () => {
    if (busy) return;
    if (!(controller ? controller.current() : deviceFileContextCurrent(request.context))) { setError(t("transfer.directoryChanged")); return; }
    const filename = name.trim();
    if (!deleting && !validDeviceFilename(filename)) { setError(t("transfer.invalidFilename")); return; }
    if (request.type === "rename" && filename === request.name) { onClose(); return; }
    setBusy(true); setError(null);
    const action: DeviceFileAction = deleting
      ? { type: "delete", name: request.name! }
      : request.type === "rename" ? { type: "rename", name: request.name!, newName: filename }
      : { type: "create", name: filename, kind: request.type === "create-dir" ? "dir" : "file" };
    const success = await (controller ? controller.mutate(action) : mutateDeviceFile(request.context, action));
    setBusy(false);
    if (success || deleting) onClose();
    else setError(controller ? controller.error() : useTransferStore.getState().error);
  };
  return <dialog ref={dialog} className="transfer-plan-dialog transfer-file-dialog" aria-labelledby="transfer-file-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2 id="transfer-file-title">{title}</h2>
      <p className="transfer-endpoint">{workspaceLabel(endpoint, devices)}</p>
      {deleting ? <p>{t(request.directory ? "transfer.deleteDirectoryPrompt" : "transfer.deleteFilePrompt")}</p>
        : <label>{t("transfer.name")}<input ref={input} aria-label={t("transfer.name")} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>}
      {error && <p role="alert" className="transfer-error">{error}</p>}
      {busy && <p role="status" className="transfer-hint">{t("transfer.fileOperationBusy")}</p>}
      <div className="transfer-dialog-actions"><button type="button" autoFocus={deleting} disabled={busy} onClick={onClose}>{t("dialog.cancel")}</button>
        <button type="submit" className={deleting ? "danger" : "primary"} disabled={busy || (!deleting && !name.trim())}>{deleting ? t("workspace.delete") : request.type === "rename" ? t("workspace.rename") : t("transfer.create")}</button></div>
    </form>
  </dialog>;
}
