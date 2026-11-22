import { api, type DeviceProfile, type HostKeyChange } from "./api";

export function hostKeyChange(error: unknown): HostKeyChange | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  if (value.code !== "ssh_host_key_changed" || typeof value.addr !== "string" ||
      typeof value.saved_fingerprint !== "string" || typeof value.received_fingerprint !== "string") return null;
  return { addr: value.addr, saved_fingerprint: value.saved_fingerprint, received_fingerprint: value.received_fingerprint };
}

/** Each changed address/key pair needs its own explicit confirmation before retrying. */
export async function testDeviceConnection(
  device: DeviceProfile,
  confirm: (change: HostKeyChange) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<string | null> {
  let confirmation: HostKeyChange | undefined;
  while (!signal?.aborted) {
    try {
      const result = await api.testDevice(device, confirmation, signal);
      return signal?.aborted ? null : result;
    } catch (error) {
      if (signal?.aborted) return null;
      const change = device.transport === "ssh" ? hostKeyChange(error) : null;
      if (!change) throw error;
      if (!await confirm(change)) return null;
      confirmation = change;
    }
  }
  return null;
}
