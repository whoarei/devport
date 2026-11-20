import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deviceWorkspace, errorMessage, isRemoteWorkspaceHost, workspaceRefEquals, type DeviceProfile } from "../api";
import { canBrowseDevicePath, isDevicePath, joinDevicePath, parentDevicePath } from "../directoryCompletion";
import { useAppStore } from "../store";
import { transferApi, type TransferDirectory } from "../transferApi";
import { DirectoryPathInput } from "./DirectoryPathInput";
import { Icon } from "./Icon";
import "./RemoteWorkspaceDialog.css";

export { isDevicePath, joinDevicePath, parentDevicePath } from "../directoryCompletion";

/** Device HOME is resolved by the file service, never inferred from the login name. */
export async function resolveDeviceWorkspacePath(id: string, path: string): Promise<string> {
  if (!path.startsWith("~/")) return path;
  const directory = await transferApi.list(deviceWorkspace(id, path));
  return directory.endpoint.type === "device" ? directory.endpoint.path : path;
}

export function RemoteWorkspaceDialog() {
  const open = useAppStore((s) => s.remoteWorkspaceDialogOpen);
  const devices = useAppStore((s) => s.devices);
  const close = useAppStore((s) => s.closeRemoteWorkspaceDialog);
  const hosts = useMemo(() => devices.filter(isRemoteWorkspaceHost), [devices]);
  return open ? <RemoteWorkspacePicker hosts={hosts} close={close} /> : null;
}

function RemoteWorkspacePicker({ hosts, close }: { hosts: DeviceProfile[]; close: () => void }) {
  const { t } = useTranslation();
  const initial = hosts.find((device) => device.id === useAppStore.getState().selectedDeviceId) ?? hosts[0];
  const [deviceId, setDeviceId] = useState(initial?.id ?? "");
  const [path, setPath] = useState(initial?.workspace_root ?? "/");
  const [directory, setDirectory] = useState<TransferDirectory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const edits = useRef(0);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const host = hosts.find((device) => device.id === deviceId);
  const contextKey = JSON.stringify([deviceId, host]);
  const currentPath = directory?.endpoint.type === "device" ? directory.endpoint.path : null;
  const entries = (directory?.entries ?? []).filter((entry) => entry.kind === "dir")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const navigate = useCallback(async (target: string) => {
    if (!deviceId || submitting.current) return;
    const request = ++sequence.current;
    const edit = ++edits.current;
    setPath(target); setSelected(null); setDirectory(null); setError(null);
    if (!canBrowseDevicePath(target)) { setError(t("workspace.remoteNeedAbsolute")); setLoading(false); return; }
    setLoading(true);
    try {
      const result = await transferApi.list(deviceWorkspace(deviceId, target));
      if (request !== sequence.current) return;
      if (result.endpoint.type !== "device" || result.endpoint.device_id !== deviceId || !isDevicePath(result.endpoint.path)) throw new Error(t("transfer.directoryChanged"));
      setDirectory(result);
      if (edit === edits.current) setPath(result.endpoint.path);
    } catch (e) {
      if (request === sequence.current) setError(errorMessage(e));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [deviceId, t]);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => { mounted.current = false; ++sequence.current; };
  }, []);
  useEffect(() => {
    if (host) void navigate(host.workspace_root);
    else { ++sequence.current; setDirectory(null); setLoading(false); }
    return () => { ++sequence.current; };
  }, [contextKey, navigate]);

  const dismiss = () => { if (!submitting.current) close(); };
  const submit = async () => {
    if (submitting.current || loading || !host || !canBrowseDevicePath(path)) return;
    submitting.current = true; setOpening(true); setError(null);
    try {
      const chosen = selected && currentPath === path ? joinDevicePath(currentPath, selected) : path;
      const resolved = await resolveDeviceWorkspacePath(deviceId, chosen);
      const workspace = deviceWorkspace(deviceId, resolved);
      await useAppStore.getState().setWorkspace(workspace);
      // Canceling the unsaved-file guard leaves the picker open.
      if (mounted.current && workspaceRefEquals(useAppStore.getState().workspace, workspace)) close();
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      submitting.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  return <dialog ref={dialog} className="remote-workspace-dialog" aria-labelledby="remote-workspace-title"
    onCancel={(event) => { event.preventDefault(); dismiss(); }}>
    <h2 id="remote-workspace-title">{t("workspace.remoteTitle")}</h2>
    <div className="remote-workspace-body">
      {!hosts.length ? <p className="remote-directory-status">{t("workspace.remoteNoDevices")}</p> : <>
        <label htmlFor="remote-workspace-device">{t("workspace.remoteDevice")}</label>
        <select id="remote-workspace-device" value={deviceId} disabled={opening} onChange={(event) => {
          ++sequence.current; ++edits.current; setDirectory(null); setSelected(null); setError(null); setDeviceId(event.target.value);
        }}>{hosts.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.transport.toUpperCase()}</option>)}</select>
        <label htmlFor="remote-workspace-path">{t("workspace.remotePath")}</label>
        <div className="remote-path-bar">
          <button type="button" className="remote-icon-button" aria-label={t("workspace.remoteUp")} title={t("workspace.remoteUp")}
            disabled={opening || loading || !canBrowseDevicePath(path) || path === "/"} onClick={() => void navigate(parentDevicePath(path))}><Icon name="arrowUp" /></button>
          <div className="remote-path-control">
            <DirectoryPathInput id="remote-workspace-path" label={t("workspace.remotePath")} value={path}
              endpoint={deviceId ? deviceWorkspace(deviceId, path) : null} contextKey={contextKey} directory={directory}
              disabled={opening} placeholder={t("workspace.remotePathPlaceholder")}
              onChange={(value) => { ++edits.current; setPath(value); setSelected(null); setError(null); }} onNavigate={(value) => void navigate(value)} />
            <button type="button" className="remote-icon-button" aria-label={t("transfer.go")} title={t("transfer.go")} disabled={opening || loading || !canBrowseDevicePath(path)} onClick={() => void navigate(path)}><Icon name="arrowRight" /></button>
          </div>
        </div>
        <div className="remote-directory-list" aria-busy={loading}>
          {loading ? <p role="status" className="remote-directory-status">{t("workspace.remoteLoading")}</p>
            : error ? <p role="alert" className="remote-directory-status remote-directory-error">{error}</p>
            : directory && !entries.length ? <p className="remote-directory-status">{t("workspace.remoteEmpty")}</p>
            : <ul aria-label={t("workspace.remoteBrowse")}>
              {entries.map((entry) => <li key={entry.name} className={selected === entry.name ? "selected" : undefined}>
                <button type="button" className="remote-directory-name" aria-pressed={selected === entry.name} disabled={opening}
                  title={entry.name} onClick={() => { setSelected(entry.name); if (currentPath) setPath(currentPath); }}
                  onDoubleClick={() => currentPath && void navigate(joinDevicePath(currentPath, entry.name))}>
                  <Icon name="folder" /><span>{entry.name}</span>
                </button>
                {selected === entry.name && <Icon name="check" />}
                <button type="button" className="remote-icon-button" aria-label={t("workspace.remoteEnter", { name: entry.name })} disabled={opening} onClick={() => currentPath && void navigate(joinDevicePath(currentPath, entry.name))}><Icon name="chevronRight" /></button>
              </li>)}
            </ul>}
        </div>
      </>}
    </div>
    <footer className="dialog-actions">
      <button type="button" disabled={opening} onClick={dismiss}>{t("dialog.cancel")}</button>
      <button type="button" className="primary" disabled={opening || loading || !host || !canBrowseDevicePath(path)} onClick={() => void submit()}>{t("workspace.remoteOpen")}</button>
    </footer>
  </dialog>;
}
