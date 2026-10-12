import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, type UsbDevice, type UsbError } from "../api";
import { canUsbAction, isUsbHostIp, usbDeviceState, usbHardwareId, useUsbStore } from "../usbStore";
import { useAppStore } from "../store";

const INSTALL_GUIDE = "https://learn.microsoft.com/en-us/windows/wsl/connect-usb";

function UsbIcon({ name = "usb" }: { name?: "usb" | "close" | "refresh" | "info" | "check" | "warning" | "arrow" | "shield" }) {
  const paths = {
    usb: <><path d="M12 21V3m-3 3 3-3 3 3M12 15l-5-4V8m5 4 5-4V6" /><circle cx="7" cy="6" r="2" /><path d="M15 3h4v4h-4z" /><circle cx="12" cy="19" r="2" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.5 7A7 7 0 0 1 19 9M5 15a7 7 0 0 0 12.5 2" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v1" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function UsbNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const structured = error && typeof error === "object" && "code" in error ? error as UsbError : null;
  const message = structured ? t(`usb.errors.${structured.code}`, { defaultValue: structured.code }) : errorMessage(error);
  return <div className="usb-notice usb-notice-error" role="alert">
    <UsbIcon name="warning" />
    <div><p>{message}</p>{structured?.message && <details className="usb-diagnostics">
      <summary>{t("usb.diagnostics")}</summary><pre>{structured.message}</pre>
    </details>}</div>
  </div>;
}

export function UsbDialog() {
  const { t } = useTranslation();
  const state = useUsbStore();
  const devices = useAppStore((s) => s.devices);
  const sshDevices = devices.filter((d) => d.transport === "ssh");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state.open) {
      dialog.current?.showModal();
      dialog.current?.focus();
    }
    else dialog.current?.close();
  }, [state.open]);
  useEffect(() => {
    if (state.open && state.target === "remote" && !state.remoteConfig.device_id && sshDevices.length) {
      state.setRemoteConfig({ device_id: sshDevices[0].id, host_ip: "" });
    }
  }, [state.open, state.target, state.remoteConfig.device_id, devices]);
  useEffect(() => {
    if (!state.open) return;
    const timer = setInterval(() => { if (!document.hidden) void useUsbStore.getState().refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [state.open]);

  const snapshot = state.snapshot;
  const disabled = !!state.busy || state.probing;
  const remote = state.target === "remote";
  const selectedSsh = sshDevices.find((d) => d.id === state.remoteConfig.device_id);
  const remoteConfig = remote && selectedSsh ? state.remoteConfig : remote ? { device_id: "", host_ip: "" } : undefined;
  const actionLabel = (action: "connect" | "verify" | "disconnect" | "unshare") =>
    t(remote && action === "connect" ? "usb.remote.connect" : `usb.actions.${action}`);
  const distros = snapshot?.distributions.filter((d) => d.version === 2) ?? [];
  const connected = snapshot?.devices.filter((d) => d.bus_id)
    .sort((a, b) => Number(!!b.client_ip_address) - Number(!!a.client_ip_address)) ?? [];
  const offline = snapshot?.devices.filter((d) => !d.bus_id) ?? [];
  const installNeeded = snapshot?.problem && ["not_installed", "unsupported_version"].includes(snapshot.problem.code);

  const renderDevice = (device: UsbDevice) => {
    const status = usbDeviceState(device);
    const current = state.busy?.id === device.instance_id;
    const verification = state.verification?.id === device.instance_id ? state.verification.result : null;
    const actions = status === "unplugged" ? (device.persisted_guid ? ["unshare"] as const : [])
      : status === "attached" ? ["verify", "disconnect"] as const
      : status === "shared" ? ["connect", "unshare"] as const : ["connect"] as const;
    return <article className={`usb-device usb-device-${status}${current ? " usb-device-busy" : ""}`} key={device.instance_id}>
      <div className="usb-device-icon"><UsbIcon /></div>
      <div className="usb-device-content">
        <div className="usb-device-heading">
          <strong title={device.description}>{device.description}</strong>
          <span className={`usb-badge usb-badge-${status}`}><i />{t(`usb.states.${status}`)}</span>
        </div>
        <div className="usb-device-meta"><code>{usbHardwareId(device)}</code>
          {device.bus_id && <span>BUS <code>{device.bus_id}</code></span>}
          {device.client_ip_address && <span>{t("usb.client")} <code>{device.client_ip_address}</code></span>}
        </div>
      </div>
      <div className="usb-device-actions">{actions.map((action) => <button key={action} type="button"
        className={action === "connect" ? "usb-connect" : action === "unshare" ? "usb-text-button" : "usb-secondary-button"}
        disabled={disabled || !canUsbAction(action, device, snapshot, state.config.distribution, remoteConfig)}
        onClick={() => {
          if (action === "disconnect" && !window.confirm(t("usb.disconnectConfirm"))) return;
          void state.perform(action, device);
        }}>
        {current && state.busy?.action === action ? <span className="usb-spinner" /> : action === "connect" ? <UsbIcon name="arrow" /> : null}
        {actionLabel(action)}
      </button>)}</div>
      {device.is_forced && <p className="usb-device-detail usb-muted">{t("usb.forcedHint")}</p>}
      {current && <div className="usb-device-detail usb-progress" role="status"><span className="usb-spinner" />
        <span>{t(`usb.progress.${state.busy!.action}`)}{state.busy?.action === "connect" && !device.persisted_guid && <small>{t("usb.uacHint")}</small>}</span>
      </div>}
      {verification && <div className={`usb-device-detail usb-verification ${verification.visible && verification.accessible ? "usb-verification-ok" : "usb-verification-warning"}`} role="status">
        <UsbIcon name={verification.visible && verification.accessible ? "check" : "info"} />
        <div><p>{t(remote ? !verification.visible ? "usb.remote.notVisible" : verification.accessible ? "usb.remote.accessible" : "usb.remote.needsPermission"
          : !verification.visible ? "usb.notVisible" : verification.accessible ? "usb.accessible" : "usb.needsPermission")}</p>
          {verification.nodes.length > 0 && <code>{verification.nodes.join(", ")}</code>}
        </div>
      </div>}
    </article>;
  };

  return (
    <dialog ref={dialog} className="usb-dialog" tabIndex={-1} aria-labelledby="usb-title" onCancel={(e) => {
      e.preventDefault(); state.close();
    }}>
      <header className="usb-dialog-header">
        <div className="usb-heading-icon"><UsbIcon /></div>
        <div className="usb-heading"><h3 id="usb-title">{t("usb.dialogTitle")}</h3><p>{t("usb.subtitle")}</p></div>
        <span className={`usb-dependency ${snapshot?.problem ? "usb-dependency-warning" : snapshot ? "usb-dependency-ready" : ""}`} title={snapshot?.version ?? undefined}>
          <i />{t(snapshot?.problem ? "usb.dependencyUnavailable" : snapshot ? "usb.dependencyReady" : "usb.checking")}
        </span>
        <button type="button" className="usb-icon-button" disabled={disabled} aria-label={t("usb.close")} onClick={state.close}><UsbIcon name="close" /></button>
      </header>
      <div className="usb-dialog-body">
        {snapshot?.problem && <UsbNotice error={snapshot.problem} />}
        {installNeeded && <div className="usb-install">
          <p>{t("usb.installHint")}</p>
          <code>winget install --interactive --exact dorssel.usbipd-win</code>
          <button type="button" className="usb-text-button" onClick={() => void openUrl(INSTALL_GUIDE).catch((error) => useUsbStore.setState({ error }))}>{t("usb.installGuide")}<UsbIcon name="arrow" /></button>
        </div>}
        <section className="usb-target" aria-labelledby="usb-target-title">
          <div className="usb-section-heading"><h4 id="usb-target-title">{t("usb.targetHeading")}</h4>
            <div className="usb-target-switch" role="group" aria-label={t("usb.targetHeading")}>
              <button type="button" disabled={disabled} aria-pressed={!remote} onClick={() => state.setTarget("wsl")}>WSL 2</button>
              <button type="button" disabled={disabled} aria-pressed={remote} onClick={() => state.setTarget("remote")}>{t("usb.remote.label")}</button>
            </div>
          </div>
          {remote ? <>
            <div className="usb-controls">
              <label>{t("usb.remote.device")}
                <select disabled={disabled || !sshDevices.length} value={state.remoteConfig.device_id}
                  onChange={(e) => state.setRemoteConfig({ device_id: e.target.value, host_ip: "" })}>
                  {!selectedSsh && <option value="">{t("usb.remote.noDevices")}</option>}
                  {sshDevices.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.username}@{d.host}</option>)}
                </select>
              </label>
              <label>{t("usb.remote.hostIp")}
                <input disabled={disabled} value={state.remoteConfig.host_ip} placeholder={t("usb.remote.hostPlaceholder")}
                  aria-invalid={!isUsbHostIp(state.remoteConfig.host_ip)} onChange={(e) => state.setRemoteConfig({ ...state.remoteConfig, host_ip: e.target.value })} />
              </label>
            </div>
            <div className="usb-remote-check">
              <p className="usb-target-hint"><UsbIcon name="info" /><span>{t("usb.remote.targetHint")}</span></p>
              <button type="button" className="usb-secondary-button" disabled={disabled || !selectedSsh || !!snapshot?.problem || !isUsbHostIp(state.remoteConfig.host_ip)}
                onClick={() => void state.probeRemote()}>{state.probing && <span className="usb-spinner" />}{t(state.probing ? "usb.remote.checking" : "usb.remote.check")}</button>
            </div>
            {state.remoteProbe && <div className="usb-remote-results" role="status">
              <span className={state.remoteProbe.usbip_path ? "usb-check-ok" : "usb-check-warning"}><UsbIcon name={state.remoteProbe.usbip_path ? "check" : "warning"} />usbip {t(state.remoteProbe.usbip_path ? "usb.remote.available" : "usb.remote.missing")}</span>
              <span className={state.remoteProbe.vhci_loaded ? "usb-check-ok" : "usb-check-warning"}><UsbIcon name={state.remoteProbe.vhci_loaded ? "check" : "info"} />vhci_hcd {t(state.remoteProbe.vhci_loaded ? "usb.remote.loaded" : state.remoteProbe.can_load_module ? "usb.remote.loadOnConnect" : "usb.remote.moduleMissing")}</span>
              <span className={state.remoteProbe.privilege === "unavailable" ? "usb-check-warning" : "usb-check-neutral"}><UsbIcon name="shield" />{t(`usb.remote.privilege.${state.remoteProbe.privilege}`)}</span>
              <span className={state.remoteProbe.reachable ? "usb-check-ok" : "usb-check-warning"}><UsbIcon name={state.remoteProbe.reachable ? "check" : "warning"} />TCP 3240 {t(state.remoteProbe.reachable ? "usb.remote.reachable" : "usb.remote.unreachable")}</span>
              {state.remoteProbe.network_error && <p>{state.remoteProbe.network_error}</p>}
            </div>}
            <details className="usb-remote-setup"><summary>{t("usb.remote.setupHeading")}</summary><p>{t("usb.remote.setupHint")}</p><code>sudo modprobe vhci_hcd</code></details>
          </> : <><div className="usb-controls">
            <label>{t("usb.distribution")}
              <select disabled={disabled || !distros.length} value={state.config.distribution}
                onChange={(e) => state.setConfig({ distribution: e.target.value, user: "" })}>
                {!distros.length && <option value="">{t("usb.noWsl2")}</option>}
                {distros.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
            </label>
            <label>{t("usb.user")}
              <input disabled={disabled} value={state.config.user} placeholder={t("usb.defaultUser")}
                onChange={(e) => state.setConfig({ ...state.config, user: e.target.value })} />
            </label>
          </div>
          <p className="usb-target-hint"><UsbIcon name="info" />{t("usb.targetHint")}</p></>}
        </section>
        {!remote && snapshot?.wsl_problem && <UsbNotice error={snapshot.wsl_problem} />}
        <section className="usb-device-section" aria-labelledby="usb-devices-title" aria-busy={!!state.busy}>
          <div className="usb-section-heading">
            <h4 id="usb-devices-title">{t("usb.devicesHeading")}<span className="usb-count">{connected.length}</span></h4>
            <button type="button" className="usb-text-button usb-refresh" disabled={disabled || state.loading} onClick={() => void state.refresh(true)}>
              <span className={state.loading ? "usb-refreshing" : ""}><UsbIcon name="refresh" /></span>{t("usb.refresh")}
            </button>
          </div>
          <div className="usb-ownership-note"><UsbIcon name="info" /><span>{t("usb.ownershipSummary")}</span></div>
          <div className="usb-devices">
            {connected.map(renderDevice)}
            {!connected.length && !snapshot?.problem && <div className="usb-empty" role="status">
              {state.loading && !snapshot ? <span className="usb-spinner" /> : <UsbIcon />}
              <p>{t(state.loading && !snapshot ? "usb.loading" : "usb.empty")}</p>
              {snapshot && <small>{t("usb.emptyHint")}</small>}
            </div>}
          </div>
          {offline.length > 0 && <details className="usb-offline-list">
            <summary>{t("usb.offlineHeading")}<span className="usb-count">{offline.length}</span></summary>
            <div className="usb-devices">{offline.map(renderDevice)}</div>
          </details>}
        </section>
        {state.completed && state.completed !== "verify" && <div className="usb-notice usb-notice-success" role="status"><UsbIcon name="check" /><p>{t("usb.completed", { action: actionLabel(state.completed) })}</p></div>}
        {state.error != null && <UsbNotice error={state.error} />}
        <details className="usb-help">
          <summary><UsbIcon name="shield" />{t("usb.helpHeading")}</summary>
          <div><p>{t("usb.ownershipHint")}</p><p>{t("usb.networkHint")}</p>
            {remote && <p>{t("usb.remote.networkHint")}</p>}
            {snapshot?.version && <code>usbipd-win {snapshot.version}</code>}
          </div>
        </details>
      </div>
      <footer className="usb-dialog-footer"><span>{t("usb.sessionHint")}</span><button type="button" className="usb-secondary-button" disabled={disabled} onClick={state.close}>{t("usb.close")}</button></footer>
    </dialog>
  );
}
