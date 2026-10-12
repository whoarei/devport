import { create } from "zustand";
import { api, type UsbDevice, type UsbSelector, type UsbSnapshot, type UsbVerification, type UsbWslConfig } from "./api";

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
export function canUsbAction(action: UsbAction, device: UsbDevice, snapshot: UsbSnapshot | null, distro: string): boolean {
  if (!snapshot || snapshot.problem || !snapshot.supported) return false;
  if (action === "unshare") return !!device.persisted_guid && !device.client_ip_address;
  if (action === "disconnect") return !!device.bus_id && !!device.client_ip_address;
  const wsl2 = snapshot.distributions.some((d) => d.name === distro && d.version === 2);
  return !snapshot.wsl_problem && wsl2 && !!device.bus_id &&
    (action === "connect" ? !device.client_ip_address : !!device.client_ip_address);
}

interface UsbState {
  open: boolean;
  config: UsbWslConfig;
  snapshot: UsbSnapshot | null;
  loading: boolean;
  busy: { id: string; action: UsbAction } | null;
  error: unknown;
  verification: { id: string; selector: UsbSelector; result: UsbVerification } | null;
  completed: UsbAction | null;
  show: (config?: UsbWslConfig) => void;
  close: () => void;
  setConfig: (config: UsbWslConfig) => void;
  refresh: (clearError?: boolean) => Promise<void>;
  perform: (action: UsbAction, device: UsbDevice) => Promise<void>;
}

// Invalidate snapshots started before an ownership change or a dialog reopening.
let revision = 0;
export const useUsbStore = create<UsbState>((set, get) => ({
  open: false, config: { distribution: "", user: "" }, snapshot: null,
  loading: false, busy: null, error: null, verification: null, completed: null,
  show: (config) => {
    if (get().busy) return;
    ++revision;
    set({ open: true, loading: false, snapshot: null, error: null, verification: null, completed: null,
      config: config ?? get().config });
    void get().refresh();
  },
  close: () => {
    if (get().busy) return;
    ++revision;
    set({ open: false, loading: false });
  },
  setConfig: (config) => { if (!get().busy) set({ config, verification: null, completed: null }); },
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
        verification: verified && distribution === previous.distribution && snapshot.devices.some((d) =>
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
    if (!state.open || state.busy || !canUsbAction(action, device, state.snapshot, state.config.distribution)) return;
    ++revision;
    set({ busy: { id: device.instance_id, action }, loading: false, error: null, verification: null, completed: null });
    try {
      const selector = usbSelector(device);
      if (action === "verify") {
        const result = await api.usbVerify(selector, state.config);
        set({ verification: { id: device.instance_id, selector, result } });
      } else if (action === "connect") await api.usbConnect(selector, state.config);
      else if (action === "disconnect") await api.usbDisconnect(selector);
      else await api.usbUnshare(selector);
      set({ completed: action });
    } catch (error) { set({ error }); }
    finally {
      set({ busy: null });
      await get().refresh();
    }
  },
}));
