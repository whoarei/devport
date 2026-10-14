import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, DeviceProfile, LocalShellInfo } from "../api";
import { useAppStore } from "../store";
import { useUsbStore } from "../usbStore";

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
  workspace_root: "/tmp/devrunner/workspaces",
});

/** 设备下拉列表中的展示文案 */
export const deviceLabel = (d: DeviceProfile) =>
  `${d.name} (${d.transport === "wsl" ? `WSL · ${d.wsl?.distribution}` : d.transport === "serial" ? `${d.serial?.port} · ${d.serial?.baud_rate}` : d.transport === "local" ? `Local · ${d.local?.shell}` : `${d.username}@${d.host}`})`;

export function DeviceDialog() {
  const { t } = useTranslation();
  const editing = useAppStore((s) => s.editingDevice);
  const loadDevices = useAppStore((s) => s.loadDevices);
  const selectDevice = useAppStore((s) => s.selectDevice);
  const closeDeviceDialog = useAppStore((s) => s.closeDeviceDialog);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [distributions, setDistributions] = useState<string[]>([]);
  const [shells, setShells] = useState<LocalShellInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const wasOpen = useRef(false);

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

  // 对话框打开时重置测试结果，并按连接方式预取端口 / 发行版 / 本机 shell 列表
  useEffect(() => {
    if (editing && !wasOpen.current) {
      setTestResult(null);
      setTesting(false);
      if (editing.transport === "serial") void refreshPorts();
      if (editing.transport === "wsl") void refreshDistributions();
      if (editing.transport === "local") void refreshShells();
    }
    wasOpen.current = !!editing;
  }, [editing]);

  if (!editing) return null;

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

  return (
    <div className="modal-mask">
      <div className="modal">
        <h3>{editing.id ? t("device.editTitle") : t("device.addTitle")}</h3>
        <label>
          {t("device.name")}
          <input
            value={editing.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={editing.is_default} disabled={editing.is_default}
            onChange={(e) => update({ is_default: e.target.checked })} />
          {t("device.defaultDevice")}
        </label>
        <p className="field-hint">{t("device.defaultDeviceHint")}</p>
        <label>
          {t("device.transport")}
          <select value={editing.transport} disabled={testing} onChange={(e) => {
            const transport = e.target.value as DeviceProfile["transport"];
            update({ transport, serial: editing.serial ?? { port: "", baud_rate: 115200 }, wsl: editing.wsl ?? { distribution: "", user: "" }, local: editing.local ?? { shell: "", path: null, no_profile: false } });
            setTestResult(null);
            if (transport === "serial") void refreshPorts();
            if (transport === "wsl") void refreshDistributions();
            if (transport === "local") void refreshShells();
          }}>
            <option value="ssh">SSH</option>
            <option value="serial">{t("device.serial")}</option>
            <option value="wsl">{t("device.wsl")}</option>
            <option value="local">{t("device.local")}</option>
          </select>
        </label>
        {editing.transport === "wsl" ? <>
          <label>
            {t("device.wslDistro")}
            <input list="wsl-distributions" value={editing.wsl?.distribution ?? ""} placeholder={t("device.wslDistroPlaceholder")}
              onChange={(e) => update({ wsl: { distribution: e.target.value, user: editing.wsl?.user ?? "" } })} />
            <datalist id="wsl-distributions">{distributions.map((name) => <option key={name} value={name} />)}</datalist>
            <button type="button" onClick={refreshDistributions}>{t("device.refreshDistros")}</button>
          </label>
          <label>
            {t("device.wslUser")}
            <input value={editing.wsl?.user ?? ""} placeholder={t("device.wslUserPlaceholder")}
              onChange={(e) => update({ wsl: { distribution: editing.wsl?.distribution ?? "", user: e.target.value } })} />
          </label>
          <p>{t("device.wslDescription")}</p>
          <button type="button" onClick={() => useUsbStore.getState().show(editing.wsl ?? undefined)}>{t("usb.title")}</button>
        </> : editing.transport === "local" ? <>
          <label>
            {t("device.localShell")}
            <input list="local-shell-options" value={editing.local?.shell ?? ""}
              placeholder={t("device.localShellPlaceholder")}
              onChange={(e) => update({ local: { shell: e.target.value, path: null, no_profile: editing.local?.no_profile ?? false } })} />
            <datalist id="local-shell-options">
              {shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.label} · {shell.path}</option>)}
            </datalist>
            <button type="button" onClick={refreshShells}>{t("device.refreshShells")}</button>
          </label>
          <label>
            {t("device.localShellPath")}
            <input value={editing.local?.path ?? ""} placeholder={t("device.localShellPathPlaceholder")}
              onChange={(e) => update({ local: { shell: editing.local?.shell ?? "", path: e.target.value || null, no_profile: editing.local?.no_profile ?? false } })} />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={editing.local?.no_profile ?? false}
              onChange={(e) => update({ local: { shell: editing.local?.shell ?? "", path: editing.local?.path ?? null, no_profile: e.target.checked } })} />
            {t("device.localNoProfile")}
          </label>
          <p className="field-hint">{t("device.localNoProfileHint")}</p>
          <p>{t("device.localDescription")}</p>
        </> : editing.transport === "serial" ? <>
          <label>
            {t("device.serialPort")}
            <input list="serial-ports" value={editing.serial?.port ?? ""} placeholder={t("device.serialPlaceholder")}
              onChange={(e) => update({ serial: { port: e.target.value, baud_rate: editing.serial?.baud_rate ?? 115200 } })} />
            <datalist id="serial-ports">{ports.map((port) => <option key={port} value={port} />)}</datalist>
            <button type="button" onClick={refreshPorts}>{t("device.refreshPorts")}</button>
          </label>
          <label>
            {t("device.baudRate")}
            <input type="number" min={1} max={4000000} list="serial-baud-rates" value={editing.serial?.baud_rate ?? 115200}
              onChange={(e) => update({ serial: { port: editing.serial?.port ?? "", baud_rate: Number(e.target.value) } })} />
            <datalist id="serial-baud-rates">{[9600, 57600, 115200, 230400, 460800, 921600, 1500000].map((rate) => <option key={rate} value={rate} />)}</datalist>
          </label>
          <p>{t("device.serialDescription")}</p>
        </> : <>
        <label>
          Host
          <input
            value={editing.host}
            placeholder="172.16.0.67"
            onChange={(e) => update({ host: e.target.value })}
          />
        </label>
        <label>
          {t("device.port")}
          <input
            type="number"
            value={editing.port}
            onChange={(e) => update({ port: Number(e.target.value) || 22 })}
          />
        </label>
        <label>
          {t("device.username")}
          <input
            value={editing.username}
            onChange={(e) => update({ username: e.target.value })}
          />
        </label>
        <label>
          {t("device.auth")}
          <select
            value={editing.auth.type}
            onChange={(e) =>
              update({
                auth:
                  e.target.value === "password"
                    ? { type: "password", password: "" }
                    : { type: "key", key_path: null },
              })
            }
          >
            <option value="key">{t("device.authKey")}</option>
            <option value="password">{t("device.authPassword")}</option>
          </select>
        </label>
        {editing.auth.type === "password" && (
          <label>
            {t("device.password")}
            <input
              type="password"
              value={editing.auth.password}
              onChange={(e) => update({ auth: { type: "password", password: e.target.value } })}
            />
          </label>
        )}
        {editing.auth.type === "key" && (
          <label>
            {t("device.keyPath")}
            <input
              value={editing.auth.key_path ?? ""}
              onChange={(e) =>
                update({ auth: { type: "key", key_path: e.target.value || null } })
              }
            />
          </label>
        )}
        </>}
        {editing.transport === "ssh" && editing.id && <button type="button" onClick={() => useUsbStore.getState().showRemote(editing.id)}>{t("usb.title")}</button>}
        {editing.transport !== "local" && (
        <label>
          {editing.transport === "wsl" ? t("device.workspaceRootWsl") : t("device.workspaceRootRemote")}
          <input
            value={editing.workspace_root}
            onChange={(e) => update({ workspace_root: e.target.value })}
          />
        </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={closeDeviceDialog}>{t("dialog.cancel")}</button>
          <button disabled={testing} onClick={() => test(editing)}>{t("device.testConnection")}</button>
          {editing.id && (
            <button className="danger" onClick={() => remove(editing)}>
              {t("device.delete")}
            </button>
          )}
          <button
            className="primary"
            disabled={testing || !editing.name || (editing.transport === "wsl" ? !editing.wsl?.distribution.trim() : editing.transport === "serial" ? !editing.serial?.port || !editing.serial?.baud_rate : editing.transport === "local" ? !editing.local?.shell : !editing.host)}
            onClick={() => save(editing)}
          >
            {t("device.save")}
          </button>
        </div>
        {testResult && <pre className="test-result">{testResult}</pre>}
      </div>
    </div>
  );
}
