import type { DeviceProfile, WorkspaceRef } from "./api";

type NamedDevice = Pick<DeviceProfile, "id" | "name" | "transport">;

/** Only shorten the generated prefix; user-chosen names remain recognizable. */
export function compactDeviceName(name: string, transport?: DeviceProfile["transport"]): string {
  const value = name.trim();
  if (transport === "wsl") return value.replace(/^wsl-[^@]+@(.+)$/, "$1");
  if (transport === "ssh") return value.replace(/^ssh-([^@\s]+@[^@\s]+)$/, "$1");
  return value;
}

/** Resolve collisions against the complete roster, so tabs and workspace headers
 * keep the same identity even when only one of the devices has an open tab. */
export function deviceDisplayNames(devices: NamedDevice[]): Map<string, string> {
  const names = devices.map((device) => compactDeviceName(device.name, device.transport));
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  const resolved = devices.map((device, index) => counts.get(names[index].toLowerCase())! > 1 ? device.name.trim() : names[index]);
  const used = new Set<string>();
  return new Map(devices.map((device, index) => {
    const base = resolved[index];
    let label = base, suffix = 2;
    // Include the whole roster in the check, including user names that already
    // contain a numeric suffix. Never silently create a new collision.
    while (used.has(label.toLowerCase()) || label !== base && resolved.some((name) => name.toLowerCase() === label.toLowerCase())) label = `${base} · ${suffix++}`;
    used.add(label.toLowerCase());
    return [device.id, label];
  }));
}

export function workspacePresentation(workspace: WorkspaceRef, devices: NamedDevice[]) {
  const path = workspace.type === "local" ? workspace.dir : workspace.path;
  const trimmed = path.replace(/[\\/]+$/, "");
  const name = /^[a-z]:$/i.test(trimmed) ? path : trimmed.split(/[\\/]/).pop() || path;
  const device = workspace.type === "device" ? devices.find((item) => item.id === workspace.device_id) : undefined;
  return { name, path, device: device ? deviceDisplayNames(devices).get(device.id)! : null, transport: device?.transport };
}
