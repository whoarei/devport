import type { DeviceProfile, RunReplay, RunStatus, WorkspaceRef } from "./api";
import { workspaceRefEquals } from "./api";
import { isActiveRun, isExecutionRun } from "./runState";

export const historyWorkspace = (replay: RunReplay): WorkspaceRef | null => replay.workspace_request?.workspace ?? replay.request.workspace ?? null;
export const historyArgs = (replay: RunReplay) => replay.workspace_request?.command.args ?? replay.request.args ?? [];
export const historyCommand = (replay: RunReplay) => {
  const entry = replay.workspace_request?.command.entry;
  return entry ? entry.type === "python_module" ? `python -m ${entry.name}` : entry.path
    : replay.request.kind === "command" ? replay.request.command ?? "" : `${replay.request.module ? "python -m " : ""}${replay.request.entry ?? ""}`;
};
export const historySettings = (replay: RunReplay) => replay.workspace_request?.settings ?? {
  cwd: replay.request.cwd ?? ".", env: replay.request.env ?? {}, console_mode: replay.request.console_mode ?? "pty" as const,
  timeout_secs: replay.request.timeout_secs ?? 0, bash: replay.request.bash,
};
export const historyPython = (replay: RunReplay) => replay.workspace_request?.python ?? (replay.request.managed_python ? "project" : "device_default");
export const historyIsPython = (replay: RunReplay) => replay.workspace_request ? replay.workspace_request.command.entry.type !== "bash_script" : replay.request.kind === "python";
export const historyWorkspacePath = (workspace: WorkspaceRef | null) => !workspace ? "—" : workspace.type === "local" ? workspace.dir : workspace.path;

export function historyEntries(runs: Record<string, RunStatus>, workspace: WorkspaceRef | null, all = false): RunStatus[] {
  return Object.values(runs).filter(isExecutionRun)
    .filter(run => all || isActiveRun(run) || !run.replay || workspaceRefEquals(historyWorkspace(run.replay), workspace))
    .sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started_at.localeCompare(a.started_at));
}

export function historyDuration(run: RunStatus): string | null {
  if (!run.ended_at) return null;
  const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : null;
}

export interface HistoryRunDraft {
  runId: string;
  replay: RunReplay;
  deviceId: string;
  deviceRevision: string | undefined;
  sourceRevision: string | null;
  notice?: string;
}

export function historyDraft(run: RunStatus, devices: DeviceProfile[], deviceId = run.replay?.request.device_id ?? ""): HistoryRunDraft | null {
  if (!run.replay) return null;
  const source = historyWorkspace(run.replay);
  return { runId: run.run_id, replay: structuredClone(run.replay), deviceId,
    deviceRevision: devices.find(d => d.id === deviceId)?.revision,
    sourceRevision: source?.type === "device" ? devices.find(d => d.id === source.device_id)?.revision ?? "missing" : null };
}

export function decodeHistoryOutput(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
}
