import { create } from "zustand";
import { api, errorMessage, type AuthMethod, type DeviceProfile, type HostKeyChange } from "./api";
import { hostKeyChange } from "./deviceConnection";
import { useAppStore } from "./store";
import { useTerminalStore } from "./terminalStore";

const HISTORY_KEY = "devport.quick-ssh.recent.v1";
const HISTORY_LIMIT = 10;
const safeAddress = (value: unknown): value is string => typeof value === "string" && value.length <= 1024 &&
  /^[^\s@:/\\?#]+@(?:\[[0-9a-fA-F:]+\]|[^\s@:/\\?#]+):[0-9]+$/.test(value);

export function recentSshAddresses(): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(values) ? [...new Set(values.filter(safeAddress))].slice(0, HISTORY_LIMIT) : [];
  } catch { return []; }
}

export const useQuickSshStore = create<{ initialAddress: string | null; recentAddresses: string[] }>(() => ({
  initialAddress: null,
  recentAddresses: recentSshAddresses(),
}));
export const openQuickSsh = (address = "") => useQuickSshStore.setState({ initialAddress: address });
export const closeQuickSsh = () => useQuickSshStore.setState({ initialAddress: null });

/** Build history from the validated profile; never store the input or credentials. */
export function rememberSshAddress(device: DeviceProfile): void {
  const address = `${device.username}@${device.host}:${device.port}`;
  if (!safeAddress(address)) return;
  const recentAddresses = [address, ...useQuickSshStore.getState().recentAddresses.filter((item) => item !== address)].slice(0, HISTORY_LIMIT);
  useQuickSshStore.setState({ recentAddresses });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(recentAddresses)); }
  catch { /* History is optional; storage failure must not prevent a connection. */ }
}

export async function connectQuickSsh(
  address: string, auth: AuthMethod, confirm: (change: HostKeyChange) => Promise<boolean>,
): Promise<DeviceProfile | null> {
  let confirmation: HostKeyChange | undefined;
  for (;;) {
    try { return await api.quickConnectSsh({ address, auth }, confirmation); }
    catch (error) {
      const change = hostKeyChange(error);
      if (!change) throw error;
      if (!await confirm(change)) return null;
      confirmation = change;
    }
  }
}

export function activateQuickSsh(device: DeviceProfile): void {
  const state = useAppStore.getState();
  state.setDevices([...state.devices.filter((item) => item.id !== device.id), device]);
  state.selectDevice(device.id);
  state.setLayout({ sidebarVisible: true,
    panelVisible: { ...state.layout.panelVisible, deviceWorkspace: true, console: true },
    panelCollapsed: { ...state.layout.panelCollapsed, deviceWorkspace: false, console: false } });
  rememberSshAddress(device);
  closeQuickSsh();
  void useTerminalStore.getState().open(device.id, device.name)
    .catch((error) => useAppStore.setState({ editorError: errorMessage(error) }));
}
