import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { ACCENT_VARIABLES, accentVariables, normalizeAccent, type AccentPreference } from "./accentPalette";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
const STORAGE_KEY = "devport.theme.v1";
const ACCENT_STORAGE_KEY = "devport.accent.v1";
const DEFAULT_THEME = "light";

export function loadThemePreference(): ThemePreference {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system"
    ? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
}

function loadAccentPreference(): AccentPreference {
  try {
    return normalizeAccent(localStorage.getItem(ACCENT_STORAGE_KEY) ?? "default");
  } catch {
    return "default";
  }
}

interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
  accent: AccentPreference;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: AccentPreference) => void;
}

export const useThemeStore = create<ThemeState>((set) => {
  const preference = loadThemePreference();
  return {
    preference,
    theme: resolveTheme(preference),
    accent: loadAccentPreference(),
    setPreference: (preference) => {
      try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Keep the session preference when storage is unavailable. */ }
      set({ preference, theme: resolveTheme(preference) });
    },
    setAccent: (accent) => {
      const value = normalizeAccent(accent);
      try { localStorage.setItem(ACCENT_STORAGE_KEY, value); } catch { /* Keep the session preference when storage is unavailable. */ }
      set({ accent: value });
    },
  };
});

/** Start before React renders, so restored preferences also color the first frame. */
export function initializeTheme(): () => void {
  const browserWindow = window;
  const apply = ({ theme, accent }: ThemeState) => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    const colors = accentVariables(theme, accent);
    for (const key of ACCENT_VARIABLES) {
      if (colors) root.style.setProperty(key, colors[key]);
      else root.style.removeProperty(key);
    }
  };
  const unsubscribe = useThemeStore.subscribe(apply);
  const media = browserWindow.matchMedia?.("(prefers-color-scheme: dark)");
  const updateSystem = () => {
    const { preference } = useThemeStore.getState();
    if (preference === "system") useThemeStore.setState({ theme: resolveTheme(preference) });
  };
  const updateStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== ACCENT_STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    const update: Partial<ThemeState> = {};
    if (event.key !== ACCENT_STORAGE_KEY) {
      update.preference = loadThemePreference();
      update.theme = resolveTheme(update.preference);
    }
    if (event.key !== STORAGE_KEY) update.accent = loadAccentPreference();
    useThemeStore.setState(update);
  };
  media?.addEventListener("change", updateSystem);
  browserWindow.addEventListener("storage", updateStorage);
  const preference = loadThemePreference();
  useThemeStore.setState({ preference, theme: resolveTheme(preference), accent: loadAccentPreference() });
  return () => {
    unsubscribe();
    media?.removeEventListener("change", updateSystem);
    browserWindow.removeEventListener("storage", updateStorage);
  };
}

export function terminalTheme(theme: Theme, accent: AccentPreference = "default"): ITheme {
  const ansi: ITheme = theme === "dark" ? {
    background: "#1b1e24", foreground: "#e5eaf3", cursor: "#a3c1ff", cursorAccent: "#1b1e24",
    selectionBackground: "#344f79", selectionInactiveBackground: "#303d54",
    black: "#8792a4", red: "#ef9aa7", green: "#9bc89e", yellow: "#d6bd87",
    blue: "#98b7ee", magenta: "#c3a0dc", cyan: "#8fc9cf", white: "#c3cbd8",
    brightBlack: "#96a2b6", brightRed: "#ffb0bc", brightGreen: "#b0dfb0", brightYellow: "#ead29c",
    brightBlue: "#b0cdff", brightMagenta: "#d9b8f0", brightCyan: "#a6dfe3", brightWhite: "#edf2fa",
  } : {
    background: "#ffffff", foreground: "#272522", cursor: "#973e20", cursorAccent: "#ffffff",
    selectionBackground: "#f1d9c8", selectionInactiveBackground: "#eee8e2",
    black: "#202733", red: "#b42332", green: "#26723b", yellow: "#856000",
    blue: "#245ac2", magenta: "#8542a4", cyan: "#087586", white: "#626e80",
    brightBlack: "#626e80", brightRed: "#c02b3d", brightGreen: "#237943", brightYellow: "#8a6200",
    brightBlue: "#275fc9", brightMagenta: "#9344aa", brightCyan: "#087c8b", brightWhite: "#455164",
  };
  const colors = accentVariables(theme, accent);
  return colors ? {
    ...ansi,
    cursor: colors["--accent"],
    selectionBackground: colors["--selection"],
    selectionInactiveBackground: colors["--accent-surface"],
  } : ansi;
}
