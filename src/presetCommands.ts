import type { ConsoleMode } from "./api";

const STORAGE_KEY = "devport.presets.v1";
export const MAX_PRESETS = 100;
export const MAX_PRESET_NAME = 60;
export const MAX_PRESET_COMMAND = 2000;
const MAX_TIMEOUT_SECS = 86400;

/** 预置命令：可选名称 + 命令文本 + 运行参数（console 模式 / 超时），双击即对当前选中设备执行。 */
export interface PresetCommand {
  id: string;
  name: string;
  command: string;
  consoleMode: ConsoleMode;
  /** 超时秒数，0 = 不限 */
  timeoutSecs: number;
}

export function newPresetId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_TIMEOUT_SECS, Math.max(0, Math.round(value)))
    : 0;
}

function normalizePreset(value: unknown): PresetCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const command = typeof source.command === "string" ? source.command.trim() : "";
  if (!command) return null;
  return {
    id: typeof source.id === "string" && source.id ? source.id : newPresetId(),
    name: name.slice(0, MAX_PRESET_NAME),
    command: command.slice(0, MAX_PRESET_COMMAND),
    consoleMode: source.consoleMode === "pipe" ? "pipe" : "pty",
    timeoutSecs: clampTimeout(source.timeoutSecs),
  };
}

/** 任意输入逐条校验：丢弃缺命令的条目，名称允许为空，去重 id，限制总数。 */
export function normalizePresets(value: unknown): PresetCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: PresetCommand[] = [];
  for (const item of value) {
    const preset = normalizePreset(item);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
    if (presets.length >= MAX_PRESETS) break;
  }
  return presets;
}

export function loadPresets(): PresetCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizePresets(raw === null ? undefined : JSON.parse(raw));
  } catch {
    return [];
  }
}

export function savePresets(presets: PresetCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
  } catch (error) {
    console.warn("Unable to save preset commands", error);
  }
}
