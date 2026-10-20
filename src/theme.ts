import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
const STORAGE_KEY = "remote-runner.theme.v1";

export function loadThemePreference(): ThemePreference {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system"
    ? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
}

interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>((set) => {
  const preference = loadThemePreference();
  return {
    preference,
    theme: resolveTheme(preference),
    setPreference: (preference) => {
      try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Keep the session preference when storage is unavailable. */ }
      set({ preference, theme: resolveTheme(preference) });
    },
  };
});

/** Start before React renders, so restored preferences also color the first frame. */
export function initializeTheme(): () => void {
  const browserWindow = window;
  const apply = () => { document.documentElement.dataset.theme = useThemeStore.getState().theme; };
  const unsubscribe = useThemeStore.subscribe(apply);
  const media = browserWindow.matchMedia?.("(prefers-color-scheme: dark)");
  const updateSystem = () => {
    const { preference } = useThemeStore.getState();
    if (preference === "system") useThemeStore.setState({ theme: resolveTheme(preference) });
  };
  const updateStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    const preference = loadThemePreference();
    useThemeStore.setState({ preference, theme: resolveTheme(preference) });
  };
  media?.addEventListener("change", updateSystem);
  browserWindow.addEventListener("storage", updateStorage);
  const preference = loadThemePreference();
  useThemeStore.setState({ preference, theme: resolveTheme(preference) });
  apply();
  return () => {
    unsubscribe();
    media?.removeEventListener("change", updateSystem);
    browserWindow.removeEventListener("storage", updateStorage);
  };
}

export function terminalTheme(theme: Theme): ITheme {
  return theme === "dark" ? { background: "#1e1f24" } : {
    background: "#f8f9fc", foreground: "#242c3b", cursor: "#242c3b", cursorAccent: "#f8f9fc",
    selectionBackground: "#cbdcfb", selectionInactiveBackground: "#dfe6f1",
    black: "#202733", red: "#b42332", green: "#26723b", yellow: "#856000",
    blue: "#245ac2", magenta: "#8542a4", cyan: "#087586", white: "#626e80",
    brightBlack: "#626e80", brightRed: "#c02b3d", brightGreen: "#237943", brightYellow: "#8a6200",
    brightBlue: "#275fc9", brightMagenta: "#9344aa", brightCyan: "#087c8b", brightWhite: "#455164",
  };
}
