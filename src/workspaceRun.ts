import type { CommandSource, DeviceProfile, WorkspaceCommand, WorkspaceCommandRecord, WorkspaceRef } from "./api";

export const workspaceKey = (w: WorkspaceRef | null) => !w ? "none" : w.type === "local" ? JSON.stringify(["local", w.dir]) : JSON.stringify(["device", w.device_id, w.path]);
export const workspaceSourceRevision = (w: WorkspaceRef | null, devices: DeviceProfile[]): string | null =>
  w?.type === "device" ? devices.find((device) => device.id === w.device_id)?.revision ?? "missing" : null;
export const commandLabel = (c: WorkspaceCommand) => c.entry.type === "python_module" ? `python -m ${c.entry.name}` : c.entry.path;
export const pythonVersionMatches = (request: string, actual: string) =>
  /^\d+\.\d+(\.\d+)?$/.test(request) && /^\d+\.\d+\.\d+$/.test(actual)
  && (actual === request || request.split(".").length === 2 && actual.startsWith(`${request}.`));
export function commandsFor(records: WorkspaceCommandRecord[], source?: CommandSource): WorkspaceCommandRecord[] {
  if (!source) return records;
  return records.filter((r) => r.entry.type !== "python_module" ? source.type === "file" && r.entry.path === source.path : r.sources?.some((s) => s.type === source.type && s.path === source.path));
}
export function inferModule(path: string, directory: boolean, cwd: string, pythonPath: string[]): string | null {
  const candidates = new Set<string>();
  for (const root of new Set([cwd, ...pythonPath])) {
    const prefix = root === "." || !root ? "" : root.replace(/\/$/, "") + "/";
    if (!path.startsWith(prefix)) continue;
    let value = path.slice(prefix.length);
    if (!directory) value = value.replace(/\.py$/i, "").replace(/\/(__init__|__main__)$/, "");
    if (value && value.split("/").every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) candidates.add(value.replace(/\//g, "."));
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
export const validModule = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name);
