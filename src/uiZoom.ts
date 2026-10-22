import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const DEFAULT_UI_ZOOM = 100;
export const UI_ZOOM_LEVELS = [70, 80, 90, 100, 110, 120, 130, 140, 150, 175, 200] as const;

const STORAGE_KEY = "remote-runner.ui-zoom.v1";

export type UiZoomAction = "in" | "out" | "reset";

export function normalizeUiZoom(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_UI_ZOOM;
  return UI_ZOOM_LEVELS.reduce((nearest, level) =>
    Math.abs(level - parsed) < Math.abs(nearest - parsed) ? level : nearest, DEFAULT_UI_ZOOM);
}

export function loadUiZoom(): number {
  if (typeof localStorage === "undefined") return DEFAULT_UI_ZOOM;
  try {
    return normalizeUiZoom(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_UI_ZOOM;
  }
}

export function saveUiZoom(percent: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(normalizeUiZoom(percent)));
  } catch {
    // WebView storage can be unavailable; zooming should still work for this session.
  }
}

export function changeUiZoom(current: number, action: UiZoomAction): number {
  if (action === "reset") return DEFAULT_UI_ZOOM;
  const normalized = normalizeUiZoom(current);
  const index = UI_ZOOM_LEVELS.indexOf(normalized as (typeof UI_ZOOM_LEVELS)[number]);
  const next = action === "in" ? index + 1 : index - 1;
  return UI_ZOOM_LEVELS[Math.max(0, Math.min(UI_ZOOM_LEVELS.length - 1, next))];
}

export function uiZoomShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "key" | "code">): UiZoomAction | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  if (["+", "="].includes(event.key) || event.code === "NumpadAdd") return "in";
  if (["-", "_"].includes(event.key) || event.code === "NumpadSubtract") return "out";
  if (event.key === "0" || event.code === "Numpad0") return "reset";
  return null;
}

/** Apply to the whole WebView so menus, editors, terminals, and layout scale together. */
export async function applyUiZoom(percent: number): Promise<void> {
  const scale = normalizeUiZoom(percent) / 100;
  if (isTauri()) {
    await getCurrentWebview().setZoom(scale);
  } else {
    // Keep browser development/preview behavior aligned with the desktop app.
    // CSS zoom leaves viewport units unscaled; dialogs use this for their bounds.
    document.documentElement.style.setProperty("--browser-ui-zoom", String(scale));
    document.documentElement.style.setProperty("zoom", String(scale));
  }
}
