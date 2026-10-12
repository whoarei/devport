import { create } from "zustand";
import { api, type UsbDevice, type UsbRemoteConfig, type UsbRemoteProbe, type UsbSelector, type UsbSnapshot, type UsbVerification, type UsbWslConfig } from "./api";

export type UsbAction = "connect" | "disconnect" | "unshare" | "verify";
export function usbSelector(device: UsbDevice) {
  return { instance_id: device.instance_id, bus_id: device.bus_id, persisted_guid: device.persisted_guid };
}
export function usbHardwareId(device: UsbDevice): string {
  const vid = /VID_([\da-f]{4})/i.exec(device.instance_id)?.[1];
  const pid = /PID_([\da-f]{4})/i.exec(device.instance_id)?.[1];
  return vid && pid ? `${vid}:${pid}`.toUpperCase() : "—";
}
export function usbDeviceState(device: UsbDevice): "unplugged" | "attached" | "shared" | "unshared" {
  if (!device.bus_id) return "unplugged";
  if (device.client_ip_address) return "attached";
  return device.persisted_guid ? "shared" : "unshared";
}
export function isUsbHostIp(host: string): boolean {
  if (!host) return true; // Rust resolves the local route, then checks it from Linux.
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host)) return false;
  const parts = host.split(".").map(Number);
  return parts.every((n) => n <= 255) && parts[0] > 0 && parts[0] !== 127 && parts[0] < 224;
}
export function canUsbAction(action: UsbAction, device: UsbDevice, snapshot: UsbSnapshot | null, distro: string, remote?: UsbRemoteConfig): boolean {
  if (!snapshot || snapshot.problem || !snapshot.supported) return false;
  if (action === "unshare") return !!device.persisted_guid && !device.client_ip_address;
  if (remote) {
    if (!remote.device_id || !isUsbHostIp(remote.host_ip) || !device.bus_id) return false;
    return action === "connect" ? !device.client_ip_address : !!device.client_ip_address;
  }
  if (action === "disconnect") return !!device.bus_id && !!device.client_ip_address;
  const wsl2 = snapshot.distributions.some((d) => d.name === distro && d.version === 2);
  return !snapshot.wsl_problem && wsl2 && !!device.bus_id &&
    (action === "connect" ? !device.client_ip_address : !!device.client_ip_address);
}

interface UsbState {
  open: boolean;
  target: "wsl" | "remote";
  config: UsbWslConfig;
  remoteConfig: UsbRemoteConfig;
  remoteProbe: UsbRemoteProbe | null;
  probing: boolean;
  snapshot: UsbSnapshot | null;
  loading: boolean;
  busy: { id: string; action: UsbAction } | null;
  error: unknown;
  verification: { id: string; selector: UsbSelector; result: UsbVerification } | null;
  completed: UsbAction | null;
  show: (config?: UsbWslConfig) => void;
  showRemote: (deviceId: string) => void;
  close: () => void;
  setTarget: (target: "wsl" | "remote") => void;
  setConfig: (config: UsbWslConfig) => void;
  setRemoteConfig: (config: UsbRemoteConfig) => void;
  probeRemote: () => Promise<void>;
  refresh: (clearError?: boolean) => Promise<void>;
  perform: (action: UsbAction, device: UsbDevice) => Promise<void>;
}

// Invalidate snapshots started before an ownership change or a dialog reopening.
let revision = 0;
let probeRevision = 0;
export const useUsbStore = create<UsbState>((set, get) => ({
  open: false, target: "wsl", config: { distribution: "", user: "" }, snapshot: null,
  remoteConfig: { device_id: "", host_ip: "" }, remoteProbe: null, probing: false,
  loading: false, busy: null, error: null, verification: null, completed: null,
  show: (config) => {
    if (get().busy) return;
    ++revision;
    ++probeRevision;
    set({ open: true, probing: false, remoteProbe: null, loading: false, snapshot: null, error: null, verification: null, completed: null,
      ...(config ? { target: "wsl" as const } : {}),
      config: config ?? get().config });
    void get().refresh();
  },
  showRemote: (deviceId) => {
    if (get().busy) return;
    set({ target: "remote", remoteConfig: { device_id: deviceId, host_ip: get().remoteConfig.device_id === deviceId ? get().remoteConfig.host_ip : "" } });
    get().show();
  },
  close: () => {
    if (get().busy) return;
    ++revision;
    ++probeRevision;
    set({ open: false, loading: false, probing: false });
  },
  setTarget: (target) => {
    if (get().busy) return;
    ++probeRevision;
    set({ target, probing: false, remoteProbe: null, verification: null, completed: null, error: null });
  },
  setConfig: (config) => { if (!get().busy) set({ config, verification: null, completed: null }); },
  setRemoteConfig: (remoteConfig) => {
    if (get().busy) return;
    ++probeRevision;
    set({ remoteConfig, probing: false, remoteProbe: null, verification: null, completed: null, error: null });
  },
  probeRemote: async () => {
    const state = get();
    if (!state.open || state.target !== "remote" || state.busy || state.probing || !state.remoteConfig.device_id || !isUsbHostIp(state.remoteConfig.host_ip)) return;
    const current = ++probeRevision;
    set({ probing: true, remoteProbe: null, error: null });
    try {
      const result = await api.usbRemoteProbe(state.remoteConfig);
      if (current !== probeRevision || !get().open) return;
      set({ remoteProbe: result, remoteConfig: { ...state.remoteConfig, host_ip: result.host_ip } });
    } catch (error) { if (current === probeRevision) set({ error }); }
    finally { if (current === probeRevision) set({ probing: false }); }
  },
  refresh: async (clearError = false) => {
    if (!get().open || get().loading || get().busy) return;
    const current = ++revision;
    set({ loading: true, ...(clearError ? { error: null, completed: null } : {}) });
    try {
      const snapshot = await api.usbSnapshot();
      if (current !== revision || !get().open) return;
      const previous = get().config;
      const distribution = snapshot.distributions.some((d) => d.name === previous.distribution && d.version === 2)
        ? previous.distribution : snapshot.distributions.find((d) => d.version === 2)?.name ?? "";
      const verified = get().verification;
      set({ snapshot, config: { distribution, user: distribution === previous.distribution ? previous.user : "" },
        verification: verified && (get().target === "remote" || distribution === previous.distribution) && snapshot.devices.some((d) =>
          d.instance_id === verified.id && d.client_ip_address && d.bus_id === verified.selector.bus_id &&
          d.persisted_guid === verified.selector.persisted_guid)
          ? verified : null });
    } catch (error) {
      if (current === revision) set({ error, snapshot: null });
    } finally {
      if (current === revision) set({ loading: false });
    }
  },
  perform: async (action, device) => {
    const state = get();
    if (!state.open || state.busy || state.probing || !canUsbAction(action, device, state.snapshot, state.config.distribution,
      state.target === "remote" ? state.remoteConfig : undefined)) return;
    ++revision;
    set({ busy: { id: device.instance_id, action }, loading: false, error: null, verification: null, completed: null });
    try {
      const selector = usbSelector(device);
      if (action === "verify") {
        const result = state.target === "remote" ? await api.usbRemoteVerify(selector, state.remoteConfig) : await api.usbVerify(selector, state.config);
        set({ verification: { id: device.instance_id, selector, result } });
      } else if (action === "connect") {
        if (state.target === "remote") {
          const host = await api.usbRemoteConnect(selector, state.remoteConfig);
          set({ remoteConfig: { ...state.remoteConfig, host_ip: host } });
        } else await api.usbConnect(selector, state.config);
      } else if (action === "disconnect") {
        if (state.target === "remote") await api.usbRemoteDisconnect(selector, state.remoteConfig);
        else await api.usbDisconnect(selector);
      }
      else await api.usbUnshare(selector);
      set({ completed: action });
    } catch (error) { set({ error }); }
    finally {
      set({ busy: null });
      await get().refresh();
    }
  },
}));
