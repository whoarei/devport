import type { RunStatus } from "./api";
import i18n from "./i18n";

export const isActiveRun = (run: RunStatus) =>
  ["preparing", "syncing", "starting", "running", "stopping"].includes(run.state);

export const isExecutionRun = (run: RunStatus) => !run.replay?.workspace_request?.operation || run.replay.workspace_request.operation === "run";
export const latestExecution = (runs: Record<string, RunStatus>) => Object.values(runs).filter(isExecutionRun)
  .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;

/** 运行状态的界面展示名；后端未知状态原样显示。CSS class 仍用原始 state。 */
export function runStateLabel(state: string): string {
  const key = `state.${state}`;
  return i18n.exists(key) ? i18n.t(key) : state;
}

/** Managed Runtime 准备阶段的界面展示名；未知阶段原样显示。 */
export function runPhaseLabel(phase: string): string {
  const key = `phase.${phase}`;
  return i18n.exists(key) ? i18n.t(key) : phase;
}

const phase = ["preparing", "syncing", "starting", "running", "stopping"];
/** Elapsed wall-clock time, including preparation; invalid historical timestamps stay hidden. */
export function runDuration(start: string, end: string | null, now = Date.now()): string | null {
  const from = Date.parse(start), to = end ? Date.parse(end) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  const s = String(seconds % 60).padStart(2, "0"), minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${s}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

export function newestStatus(current: RunStatus | undefined, incoming: RunStatus): RunStatus {
  if (current && (!isActiveRun(current) || phase.indexOf(current.state) > phase.indexOf(incoming.state) && isActiveRun(incoming))) return current;
  return incoming;
}

export interface RunDraft {
  mode: "script" | "command";
  entry: string;
  argsText: string;
  command: string;
  /** Managed Python Runtime（uv-only）；仅 python 脚本生效 */
  managed: boolean;
  consoleMode: "pty" | "pipe";
  timeoutSecs: number;
}

export const DEFAULT_RUN_DRAFT: RunDraft = {
  mode: "script", entry: "", argsText: "", command: "", managed: false, consoleMode: "pty", timeoutSecs: 0,
};
