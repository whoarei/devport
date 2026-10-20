import { isTauri } from "@tauri-apps/api/core";
import { availableMonitors, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import type { WindowGeometry } from "./environmentState";

interface ScreenArea { x: number; y: number; width: number; height: number; scale: number }
export function fitWindow(saved: WindowGeometry, screens: ScreenArea[]): WindowGeometry {
  const screen = screens.find((s) => saved.x >= s.x && saved.x < s.x + s.width && saved.y >= s.y && saved.y < s.y + s.height) ?? screens[0];
  if (!screen) return saved;
  const width = Math.max(900, Math.min(saved.width, screen.width / screen.scale));
  const height = Math.max(600, Math.min(saved.height, screen.height / screen.scale));
  return { ...saved, width, height,
    x: Math.round(Math.max(screen.x, Math.min(saved.x, screen.x + Math.max(0, screen.width - width * screen.scale)))),
    y: Math.round(Math.max(screen.y, Math.min(saved.y, screen.y + Math.max(0, screen.height - height * screen.scale)))) };
}

let flush: (() => Promise<void>) | undefined;
export const flushWindowGeometry = async () => { await flush?.(); };

export async function trackWindow(saved: WindowGeometry | null, update: (geometry: WindowGeometry) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const appWindow = getCurrentWindow();
  let normal = saved, pendingMaximize = false;
  if (saved) {
    const screens = (await availableMonitors()).map((m) => ({ x: m.workArea.position.x, y: m.workArea.position.y,
      width: m.workArea.size.width, height: m.workArea.size.height, scale: m.scaleFactor }));
    normal = fitWindow(saved, screens);
    await appWindow.setPosition(new PhysicalPosition(normal.x, normal.y));
    await appWindow.setSize(new LogicalSize(normal.width, normal.height));
    if (saved.maximized) {
      if (await appWindow.isVisible()) await appWindow.maximize();
      else pendingMaximize = true;
    }
  }
  let disposed = false, epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capture = async () => {
    const token = ++epoch;
    if (disposed || await appWindow.isMinimized()) return;
    if (pendingMaximize) {
      if (!await appWindow.isVisible()) return;
      pendingMaximize = false;
      await appWindow.maximize();
    }
    const maximized = await appWindow.isMaximized();
    if (maximized && normal) {
      const monitor = await currentMonitor();
      if (disposed || token !== epoch) return;
      if (monitor) {
        const { position, size } = monitor.workArea;
        if (normal.x < position.x || normal.x >= position.x + size.width || normal.y < position.y || normal.y >= position.y + size.height)
          normal = { ...normal, x: position.x, y: position.y };
      }
      update({ ...normal, maximized }); return;
    }
    const [position, size, scale] = await Promise.all([appWindow.outerPosition(), appWindow.innerSize(), appWindow.scaleFactor()]);
    if (disposed || token !== epoch || size.width === 0 || size.height === 0) return;
    normal = { x: position.x, y: position.y, width: size.width / scale, height: size.height / scale, maximized };
    update(normal);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void capture().catch(() => {}); }, 200); };
  const listeners = await Promise.all([appWindow.onMoved(schedule), appWindow.onResized(schedule), appWindow.onFocusChanged(schedule)]);
  flush = capture;
  const stop = () => { disposed = true; ++epoch; clearTimeout(timer); listeners.forEach((off) => off()); if (flush === capture) flush = undefined; };
  try { await capture(); } catch (error) { stop(); throw error; }
  return stop;
}
