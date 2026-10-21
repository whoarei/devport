import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, DeviceProfile, LocalShellInfo } from "../api";
import { useAppStore } from "../store";
import { useUsbStore } from "../usbStore";
import { automaticDeviceName } from "../deviceNaming";

function DeviceIcon({ name }: { name: "ssh" | "serial" | "wsl" | "local" | "close" | "refresh" | "info" }) {
  const paths = {
    ssh: <><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5" /></>,
    serial: <><path d="M8 3v4m8-4v4M6 7h12v5a6 6 0 0 1-12 0V7Zm6 11v3" /></>,
    wsl: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    local: <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8m-4-4v4m-5-13 3 2-3 2m6 0h4" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.5 7A7 7 0 0 1 19 9M5 15a7 7 0 0 0 12.5 2" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** 新设备模板 */
export const emptyDevice = (): DeviceProfile => ({
  id: "",
  name: "",
  is_default: false,
  transport: "ssh",
  serial: { port: "", baud_rate: 115200 },
  wsl: { distribution: "", user: "" },
  local: { shell: "", path: null, no_profile: false },
  host: "",
  port: 22,
  username: "root",
  auth: { type: "key", key_path: null },
  workspace_root: "~/devrunner/workspaces",
});

/** 设备下拉列表中的展示文案 */
export const deviceLabel = (d: DeviceProfile) =>
  `${d.name} (${d.transport === "wsl" ? `WSL · ${d.wsl?.distribution}` : d.transport === "serial" ? `${d.serial?.port} · ${d.serial?.baud_rate}` : d.transport === "local" ? `Local · ${d.local?.shell}` : `${d.username}@${d.host}`})`;

export function DeviceDialog() {
  const editing = useAppStore((s) => s.editingDevice);
  return editing ? <DeviceDialogForm key={editing.id || "new"} editing={editing} /> : null;
}

function DeviceDialogForm({ editing }: { editing: DeviceProfile }) {
  const { t } = useTranslation();
  const loadDevices = useAppStore((s) => s.loadDevices);
  const selectDevice = useAppStore((s) => s.selectDevice);
  const closeDeviceDialog = useAppStore((s) => s.closeDeviceDialog);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [distributions, setDistributions] = useState<string[]>([]);
  const [shells, setShells] = useState<LocalShellInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [automaticName, setAutomaticName] = useState(() => !editing.id && !editing.name.trim());
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const connectionInput = useRef<HTMLInputElement>(null);
  const previousTransport = useRef(editing.transport);
  const device = { ...editing, name: automaticName ? automaticDeviceName(editing) : editing.name };

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    (editing.id ? nameInput.current : connectionInput.current)?.focus();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (previousTransport.current === editing.transport) return;
    previousTransport.current = editing.transport;
    connectionInput.current?.focus();
  }, [editing.transport]);

  const refreshPorts = async () => {
    try { setPorts(await api.listSerialPorts()); }
    catch (e) { setTestResult(t("device.enumPortsFailed", { message: String(e) })); }
  };

  const refreshDistributions = async () => {
    try { setDistributions(await api.listWslDistributions()); }
    catch (e) { setTestResult(t("device.enumDistrosFailed", { message: String(e) })); }
  };

  const refreshShells = async () => {
    try { setShells(await api.listLocalShells()); }
    catch (e) { setTestResult(t("device.enumShellsFailed", { message: String(e) })); }
  };

  // 按连接方式预取端口 / 发行版 / 本机 shell 列表。
  useEffect(() => {
    if (editing.transport === "serial") void refreshPorts();
    if (editing.transport === "wsl") void refreshDistributions();
    if (editing.transport === "local") void refreshShells();
  }, [editing.transport]);

  const update = (patch: Partial<DeviceProfile>) =>
    useAppStore.setState({ editingDevice: { ...editing, ...patch } });

  const save = async (d: DeviceProfile) => {
    try {
      const saved = await api.saveDevice(d);
      await loadDevices();
      if (saved.is_default) selectDevice(saved.id);
      closeDeviceDialog();
    } catch (e) { setTestResult(t("device.saveFailed", { message: String(e) })); }
  };

  const remove = async (d: DeviceProfile) => {
    if (!confirm(t("device.deleteConfirm", { name: d.name }))) return;
    await api.deleteDevice(d.id);
    await loadDevices();
    closeDeviceDialog();
  };

  const test = async (d: DeviceProfile) => {
    setTestResult(t("device.connecting"));
    setTesting(true);
    try {
      setTestResult(await api.testDevice(d));
    } catch (e) {
      setTestResult(t("device.testFailed", { message: String(e) }));
    } finally { setTesting(false); }
  };

  const transports = [
    { value: "ssh", label: t("device.ssh"), hint: t("device.sshHint") },
    { value: "serial", label: t("device.serial"), hint: t("device.serialHint") },
    { value: "wsl", label: t("device.wslShort"), hint: t("device.wslHint") },
    { value: "local", label: t("device.local"), hint: t("device.localHint") },
  ] as const;

  return (
    <dialog ref={dialog} className="device-dialog" aria-labelledby="device-dialog-title"
      onCancel={(e) => { e.preventDefault(); closeDeviceDialog(); }}>
      <header className="device-dialog-header">
        <div className="device-heading-icon"><DeviceIcon name={editing.transport} /></div>
        <div className="device-heading">
          <h3 id="device-dialog-title">{editing.id ? t("device.editTitle") : t("device.addTitle")}</h3>
          <p>{t("device.subtitle")}</p>
        </div>
        <button type="button" className="device-icon-button" aria-label={t("device.close")} onClick={closeDeviceDialog}>
          <DeviceIcon name="close" />
        </button>
      </header>
      <div className="device-dialog-body">
        <section className="device-section" aria-labelledby="device-transport-title">
          <h4 id="device-transport-title">{t("device.transport")}</h4>
          <div className="device-transports" role="group" aria-labelledby="device-transport-title">
            {transports.map(({ value, label, hint }) => <button key={value} type="button"
              className="device-transport" aria-pressed={editing.transport === value} disabled={testing}
              onClick={() => {
                if (editing.transport === value) return;
                update({ transport: value, serial: editing.serial ?? { port: "", baud_rate: 115200 }, wsl: editing.wsl ?? { distribution: "", user: "" }, local: editing.local ?? { shell: "", path: null, no_profile: false } });
                setTestResult(null);
              }}>
              <DeviceIcon name={value} /><strong>{label}</strong><span>{hint}</span>
            </button>)}
          </div>
        </section>
        <section className="device-section" aria-labelledby="device-settings-title">
          <h4 id="device-settings-title">{t("device.connectionSettings")}</h4>
          <div className="device-fields">
            {editing.transport === "wsl" ? <>
              <div className="device-field-wide">
                <label htmlFor="device-wsl-distro">{t("device.wslDistro")}</label>
                <div className="device-input-action">
                  <input ref={connectionInput} id="device-wsl-distro" list="wsl-distributions" value={editing.wsl?.distribution ?? ""} placeholder={t("device.wslDistroPlaceholder")}
                    onChange={(e) => update({ wsl: { distribution: e.target.value, user: editing.wsl?.user ?? "" } })} />
                  <button type="button" onClick={refreshDistributions}><DeviceIcon name="refresh" />{t("device.refreshDistros")}</button>
                </div>
                <datalist id="wsl-distributions">{distributions.map((name) => <option key={name} value={name} />)}</datalist>
              </div>
              <label className="device-field-wide">
                {t("device.wslUser")}
                <input value={editing.wsl?.user ?? ""} placeholder={t("device.wslUserPlaceholder")}
                  onChange={(e) => update({ wsl: { distribution: editing.wsl?.distribution ?? "", user: e.target.value } })} />
              </label>
            </> : editing.transport === "local" ? <>
              <div className="device-field-wide">
                <label htmlFor="device-local-shell">{t("device.localShell")}</label>
                <div className="device-input-action">
                  <input ref={connectionInput} id="device-local-shell" list="local-shell-options" value={editing.local?.shell ?? ""} placeholder={t("device.localShellPlaceholder")}
                    onChange={(e) => update({ local: { shell: e.target.value, path: null, no_profile: editing.local?.no_profile ?? false } })} />
                  <button type="button" onClick={refreshShells}><DeviceIcon name="refresh" />{t("device.refreshShells")}</button>
                </div>
                <datalist id="local-shell-options">
                  {shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.label} · {shell.path}</option>)}
                </datalist>
              </div>
              <label className="device-field-wide">
                {t("device.localShellPath")}
                <input value={editing.local?.path ?? ""} placeholder={t("device.localShellPathPlaceholder")}
                  onChange={(e) => update({ local: { shell: editing.local?.shell ?? "", path: e.target.value || null, no_profile: editing.local?.no_profile ?? false } })} />
              </label>
              <div className="device-field-wide device-option">
                <label className="device-checkbox">
                  <input type="checkbox" checked={editing.local?.no_profile ?? false} aria-describedby="device-profile-hint"
                    onChange={(e) => update({ local: { shell: editing.local?.shell ?? "", path: editing.local?.path ?? null, no_profile: e.target.checked } })} />
                  {t("device.localNoProfile")}
                </label>
                <p id="device-profile-hint">{t("device.localNoProfileHint")}</p>
              </div>
            </> : editing.transport === "serial" ? <>
              <div>
                <label htmlFor="device-serial-port">{t("device.serialPort")}</label>
                <div className="device-input-action">
                  <input ref={connectionInput} id="device-serial-port" list="serial-ports" value={editing.serial?.port ?? ""} placeholder={t("device.serialPlaceholder")}
                    onChange={(e) => update({ serial: { port: e.target.value, baud_rate: editing.serial?.baud_rate ?? 115200 } })} />
                  <button type="button" onClick={refreshPorts} aria-label={t("device.refreshPorts")} title={t("device.refreshPorts")}><DeviceIcon name="refresh" /></button>
                </div>
                <datalist id="serial-ports">{ports.map((port) => <option key={port} value={port} />)}</datalist>
              </div>
              <label>
                {t("device.baudRate")}
                <input type="number" min={1} max={4000000} list="serial-baud-rates" value={editing.serial?.baud_rate ?? 115200}
                  onChange={(e) => update({ serial: { port: editing.serial?.port ?? "", baud_rate: Number(e.target.value) } })} />
                <datalist id="serial-baud-rates">{[9600, 57600, 115200, 230400, 460800, 921600, 1500000].map((rate) => <option key={rate} value={rate} />)}</datalist>
              </label>
            </> : <>
              <div className="device-field-wide device-host-fields">
                <label>
                  {t("device.host")}
                  <input ref={connectionInput} id="device-ssh-host" value={editing.host} placeholder={t("device.hostPlaceholder")}
                    onChange={(e) => update({ host: e.target.value })} />
                </label>
                <label>
                  {t("device.port")}
                  <input type="number" min={1} max={65535} value={editing.port}
                    onChange={(e) => update({ port: Number(e.target.value) || 22 })} />
                </label>
              </div>
              <label>
                {t("device.username")}
                <input value={editing.username} onChange={(e) => update({ username: e.target.value })} />
              </label>
              <label>
                {t("device.auth")}
                <select value={editing.auth.type} onChange={(e) => update({ auth: e.target.value === "password"
                  ? { type: "password", password: "" } : { type: "key", key_path: null } })}>
                  <option value="key">{t("device.authKey")}</option>
                  <option value="password">{t("device.authPassword")}</option>
                </select>
              </label>
              {editing.auth.type === "password" ? <label className="device-field-wide">
                {t("device.password")}
                <input type="password" autoComplete="off" value={editing.auth.password}
                  onChange={(e) => update({ auth: { type: "password", password: e.target.value } })} />
              </label> : <label className="device-field-wide">
                {t("device.keyPath")}
                <input value={editing.auth.key_path ?? ""} placeholder={t("device.keyPathPlaceholder")}
                  onChange={(e) => update({ auth: { type: "key", key_path: e.target.value || null } })} />
              </label>}
            </>}
            <div className="device-field-wide">
              <label htmlFor="device-name">{t("device.name")}</label>
              <div className="device-input-action">
                <input ref={nameInput} id="device-name" value={device.name} placeholder={t("device.namePlaceholder")}
                  onChange={(e) => {
                    setAutomaticName(false);
                    update({ name: e.target.value });
                  }}
                  onBlur={(e) => { if (!e.target.value.trim()) setAutomaticName(true); }} />
                <button type="button" disabled={automaticName} onClick={() => setAutomaticName(true)}>{t("device.restoreAutomaticName")}</button>
              </div>
            </div>
          </div>
          {editing.transport !== "ssh" && <div className="device-notice">
            <DeviceIcon name="info" />
            <p>{t(editing.transport === "wsl" ? "device.wslDescription" : editing.transport === "local" ? "device.localDescription" : "device.serialDescription")}</p>
          </div>}
        </section>
        <details className="device-advanced" key={editing.transport}>
          <summary>{t("device.advancedSettings")}</summary>
          <div className="device-advanced-body">
            {editing.transport !== "local" && <label>
              {editing.transport === "wsl" ? t("device.workspaceRootWsl") : t("device.workspaceRootRemote")}
              <input value={editing.workspace_root} onChange={(e) => update({ workspace_root: e.target.value })} />
            </label>}
            <div className="device-option">
              <label className="device-checkbox">
                <input type="checkbox" checked={editing.is_default} disabled={editing.is_default} aria-describedby="device-default-hint"
                  onChange={(e) => update({ is_default: e.target.checked })} />
                {t("device.defaultDevice")}
              </label>
              <p id="device-default-hint">{t("device.defaultDeviceHint")}</p>
            </div>
            {editing.transport === "wsl" && <button type="button" className="device-usb-button" onClick={() => useUsbStore.getState().show(editing.wsl ?? undefined)}>{t("usb.title")}</button>}
            {editing.transport === "ssh" && editing.id && <button type="button" className="device-usb-button" onClick={() => useUsbStore.getState().showRemote(editing.id)}>{t("usb.title")}</button>}
          </div>
        </details>
        {testResult && <pre className="device-test-result" role="status" aria-live="polite">{testResult}</pre>}
      </div>
      <footer className="device-dialog-footer">
        <div className="device-footer-secondary">
          <button type="button" disabled={testing} onClick={() => test(device)}>
            {testing && <span className="device-spinner" />}{t(testing ? "device.connecting" : "device.testConnection")}
          </button>
          {editing.id && <button type="button" className="device-delete" onClick={() => remove(editing)}>{t("device.delete")}</button>}
        </div>
        <div className="device-footer-primary">
          <button type="button" onClick={closeDeviceDialog}>{t("dialog.cancel")}</button>
          <button type="button" className="primary"
            disabled={testing || !device.name.trim() || (editing.transport === "wsl" ? !editing.wsl?.distribution.trim() : editing.transport === "serial" ? !editing.serial?.port || !editing.serial?.baud_rate : editing.transport === "local" ? !editing.local?.shell : !editing.host)}
            onClick={() => save(device)}>{t("device.save")}</button>
        </div>
      </footer>
    </dialog>
  );
}
