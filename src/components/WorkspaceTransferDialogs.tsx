import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, isRemoteWorkspaceHost, type WorkspaceRef } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useTransferStore } from "../transferStore";
import { rememberedDeviceDirectory } from "../transferDirectories";
import { appendEndpoint, endpointPath, transferApi, type TransferDirectory } from "../transferApi";
import { canBrowseDevicePath, endpointWithPath, parentDevicePath } from "../directoryCompletion";
import { workspaceSourceRevision } from "../workspaceRun";
import type { WorkspaceTransferSelection } from "../workspaceTransfers";
import { DirectoryPathInput } from "./DirectoryPathInput";
import { TransferPlanDialog } from "./TransferPlanDialog";
import { TransferDetailsDialog } from "./TransferQueue";
import { Icon } from "./Icon";
import "./RemoteWorkspaceDialog.css";
import "../fileTransfer.css";

function DestinationDialog({ selection }: { selection: WorkspaceTransferSelection }) {
  const { t } = useTranslation();
  const devices = useAppStore((s) => s.devices);
  const hosts = devices.filter(isRemoteWorkspaceHost);
  const upload = selection.workspace.type === "local";
  const transfer = useTransferStore.getState();
  const app = useAppStore.getState();
  const initialDevice = hosts.find((device) => device.id === app.selectedDeviceId)
    ?? hosts.find((device) => device.id === transfer.options.device_id) ?? hosts[0];
  const initialTarget: WorkspaceRef = upload ? {
    type: "device", device_id: initialDevice?.id ?? "",
    path: initialDevice ? rememberedDeviceDirectory(transfer.directories, initialDevice.id) ?? initialDevice.workspace_root : "/",
  } : { type: "local", dir: transfer.directories.local ?? (app.workspace?.type === "local" ? app.workspace.dir : "") };
  const [target, setTarget] = useState(initialTarget);
  const [directory, setDirectory] = useState<TransferDirectory | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planning = useTransferStore((s) => s.planning);
  const planError = useTransferStore((s) => s.error);
  const ref = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const choosing = useRef(false);
  const revision = workspaceSourceRevision(target, devices);
  const sourceStale = selection.revision !== workspaceSourceRevision(selection.workspace, devices);
  const path = endpointPath(target);
  const valid = path.trim() && (target.type === "local" || (!!target.device_id && canBrowseDevicePath(path)));
  const navigate = async (endpoint: WorkspaceRef) => {
    const request = ++sequence.current;
    setTarget(endpoint); setDirectory(null); setError(null); setReading(true);
    const expected = workspaceSourceRevision(endpoint, useAppStore.getState().devices);
    try {
      const result = await transferApi.list(endpoint);
      if (request !== sequence.current) return;
      if (expected !== workspaceSourceRevision(endpoint, useAppStore.getState().devices)) throw new Error(t("transfer.directoryChanged"));
      setTarget(result.endpoint); setDirectory(result);
    } catch (error) { if (request === sequence.current) setError(errorMessage(error)); }
    finally { if (request === sequence.current) setReading(false); }
  };
  useEffect(() => {
    ref.current?.showModal();
    return () => { ++sequence.current; };
  }, []);
  useEffect(() => {
    if (target.type === "device" && target.device_id && canBrowseDevicePath(path)) void navigate(target);
    else if (target.type === "local" && path.trim()) void navigate(target);
    return () => { ++sequence.current; };
  }, [target.type === "device" ? target.device_id : "local", revision]);
  const editPath = (value: string) => { ++sequence.current; setReading(false); setDirectory(null); setError(null); setTarget(endpointWithPath(target, value)); };
  const close = () => { if (!useTransferStore.getState().planning && !choosing.current) useTransferStore.setState({ workspaceTransfer: null, error: null }); };
  const choose = async () => {
    if (choosing.current) return;
    choosing.current = true;
    const request = ++sequence.current;
    setReading(false);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: t("transfer.chooseFolder") });
      if (request === sequence.current && typeof dir === "string") await navigate({ type: "local", dir });
    } catch (error) { if (request === sequence.current) setError(errorMessage(error)); }
    finally { choosing.current = false; }
  };
  const submit = () => {
    if (!valid || reading || sourceStale || choosing.current) return;
    void useTransferStore.getState().prepareWorkspaceTransfer(target);
  };
  const up = () => {
    const value = path.replace(/[\\/]$/, ""), cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    let parent = target.type === "device" ? parentDevicePath(path) : cut <= 0 ? "/" : value.slice(0, cut);
    if (/^[a-z]:$/i.test(parent)) parent += "\\";
    void navigate(endpointWithPath(target, parent));
  };
  return <dialog ref={ref} className="remote-workspace-dialog" aria-labelledby="transfer-destination-title"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="remote-workspace-header"><h2 id="transfer-destination-title">{t(upload ? "transfer.uploadTitle" : "transfer.downloadTitle")}</h2>
      <button className="remote-icon-button" disabled={planning} aria-label={t("transfer.close")} onClick={close}><Icon name="close" /></button></header>
    <div className="remote-workspace-body">
      <p className="transfer-destination-source">{workspaceLabel(appendEndpoint(selection.workspace, selection.path), devices)}</p>
      {upload && <><label htmlFor="transfer-destination-device">{t("transfer.device")}</label><div className="remote-device-control"><Icon name="server" />
        <select id="transfer-destination-device" disabled={planning} value={target.type === "device" ? target.device_id : ""} onChange={(event) => {
          const device = hosts.find((device) => device.id === event.target.value);
          if (device) { ++sequence.current; setDirectory(null); setTarget({ type: "device", device_id: device.id, path: rememberedDeviceDirectory(useTransferStore.getState().directories, device.id) ?? device.workspace_root }); }
        }}><option value="" disabled>{t("transfer.selectDevice")}</option>{hosts.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.transport.toUpperCase()}</option>)}</select></div></>}
      <label htmlFor="transfer-destination-path">{t("transfer.destination")}</label>
      <div className="remote-path-bar">
        <button className="remote-icon-button" disabled={planning || reading || !valid} title={t("transfer.up")} aria-label={t("transfer.up")} onClick={up}><Icon name="arrowUp" /></button>
        <div className="remote-path-control"><Icon name="folder" /><DirectoryPathInput id="transfer-destination-path" value={path} endpoint={target}
          contextKey={JSON.stringify([target.type, target.type === "device" ? target.device_id : "local", revision])} directory={directory}
          disabled={planning} label={t("transfer.path")} onChange={editPath} onNavigate={(value) => void navigate(endpointWithPath(target, value))} />
          <button className="remote-icon-button" disabled={planning || reading || !valid} title={t("transfer.go")} aria-label={t("transfer.go")} onClick={() => void navigate(target)}><Icon name="arrowRight" /></button></div>
        {!upload && <button className="remote-icon-button" disabled={planning} title={t("transfer.chooseFolder")} aria-label={t("transfer.chooseFolder")} onClick={() => void choose()}><Icon name="folderOpen" /></button>}
      </div>
      <div className="remote-directory-list">
        {reading ? <p className="remote-directory-status" role="status">{t("transfer.loading")}</p>
          : directory && !directory.entries.some((entry) => entry.kind === "dir") ? <p className="remote-directory-status">{t("workspace.remoteEmpty")}</p>
            : <ul>{directory?.entries.filter((entry) => entry.kind === "dir").map((entry) => <li key={entry.name}><button className="remote-directory-name" disabled={planning}
              onClick={() => void navigate(appendEndpoint(directory.endpoint, entry.name))}><Icon name="folder" /><span>{entry.name}</span><Icon name="chevronRight" /></button></li>)}</ul>}
      </div>
      {(error || planError || sourceStale) && <p className="transfer-error" role="alert">{sourceStale ? t("transfer.directoryChanged") : error || planError}</p>}
      {planning && <p role="status" className="transfer-hint">{t("transfer.scanning")}</p>}
    </div>
    <footer className="remote-workspace-footer"><button disabled={planning} onClick={close}>{t("transfer.cancel")}</button>
      <button className="primary" disabled={planning || reading || !valid || sourceStale} onClick={submit}>{t("transfer.next")}</button></footer>
  </dialog>;
}

export function WorkspaceTransferDialogs() {
  const selection = useTransferStore((s) => s.workspaceTransfer);
  const plan = useTransferStore((s) => s.planOwner === "workspace" ? s.plan : null);
  const task = useTransferStore((s) => s.tasks.find((task) => task.id === s.inlineDetailsId));
  const actionError = useTransferStore((s) => s.inlineActionError);
  return <>
    {selection && <DestinationDialog key={JSON.stringify(selection)} selection={selection} />}
    {plan && <TransferPlanDialog key={plan.id} plan={plan} />}
    {task && <TransferDetailsDialog task={task} actionError={actionError?.id === task.id ? actionError.message : undefined} onClose={() => useTransferStore.setState({ inlineDetailsId: null })}
      onRetry={() => void useTransferStore.getState().retry(task.id, "workspace")}
      onShowTask={(id) => useTransferStore.setState({ inlineDetailsId: id })} />}
  </>;
}
