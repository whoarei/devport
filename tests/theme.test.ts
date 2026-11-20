import test from "node:test";
import assert from "node:assert/strict";
import { initializeTheme, loadThemePreference, terminalTheme, useThemeStore } from "../src/theme";
import { ACCENT_PRESETS, ACCENT_VARIABLES, accentVariables, isAccentPreset, normalizeAccent } from "../src/accentPalette";

function environment(t: test.TestContext) {
  const originals = ["localStorage", "window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const data = new Map<string, string>();
  const mediaEvents = new EventTarget();
  const browserEvents = new EventTarget();
  const media = { matches: false, addEventListener: mediaEvents.addEventListener.bind(mediaEvents), removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents) };
  const styles = new Map<string, string>();
  const document = { documentElement: { dataset: {} as Record<string, string>, style: {
    setProperty: (key: string, value: string) => styles.set(key, value),
    removeProperty: (key: string) => styles.delete(key),
  } } };
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) };
  const window = { matchMedia: () => media, addEventListener: browserEvents.addEventListener.bind(browserEvents), removeEventListener: browserEvents.removeEventListener.bind(browserEvents) };
  for (const [name, value] of Object.entries({ localStorage: storage, window, document })) Object.defineProperty(globalThis, name, { configurable: true, value });
  useThemeStore.setState({ preference: "dark", theme: "dark", accent: "default" });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return { data, document, media, mediaEvents, browserEvents, storage, styles };
}

test("theme restores before rendering and persists an explicit choice", (t) => {
  const env = environment(t);
  assert.equal(loadThemePreference(), "light");
  env.data.set("devport.theme.v1", "dark");
  const stop = initializeTheme();
  t.after(stop);
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  useThemeStore.getState().setPreference("light");
  assert.equal(env.document.documentElement.dataset.theme, "light");
  assert.equal(env.data.get("devport.theme.v1"), "light");
});

test("system theme follows live changes without overriding manual selection and unsubscribes", (t) => {
  const env = environment(t);
  env.data.set("devport.theme.v1", "system");
  const stop = initializeTheme();
  assert.equal(env.document.documentElement.dataset.theme, "light");
  env.media.matches = true;
  env.mediaEvents.dispatchEvent(new Event("change"));
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  useThemeStore.getState().setPreference("light");
  env.mediaEvents.dispatchEvent(new Event("change"));
  assert.equal(env.document.documentElement.dataset.theme, "light");
  useThemeStore.getState().setPreference("system");
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  stop();
  env.media.matches = false;
  env.mediaEvents.dispatchEvent(new Event("change"));
  assert.equal(useThemeStore.getState().theme, "dark");
});

test("theme survives invalid or unavailable storage and receives preference changes from another window", (t) => {
  const env = environment(t);
  env.data.set("devport.theme.v1", "invalid");
  const stop = initializeTheme();
  t.after(stop);
  assert.equal(useThemeStore.getState().theme, "light");
  env.data.set("devport.theme.v1", "dark");
  const event = Object.assign(new Event("storage"), { key: "devport.theme.v1", storageArea: env.storage });
  env.browserEvents.dispatchEvent(event);
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  assert.equal(loadThemePreference(), "light");
  assert.doesNotThrow(() => useThemeStore.getState().setPreference("dark"));
  assert.equal(env.document.documentElement.dataset.theme, "dark");
});

test("accent restores independently of mode and resets only its own CSS variables", (t) => {
  const env = environment(t);
  env.data.set("devport.theme.v1", "system");
  env.data.set("devport.accent.v1", "#F76EAA");
  env.styles.set("zoom", "1.5");
  t.after(initializeTheme());
  const light = env.styles.get("--accent");
  assert.equal(useThemeStore.getState().accent, "#f76eaa");
  assert.equal(light, accentVariables("light", "#f76eaa")?.["--accent"]);
  env.media.matches = true;
  env.mediaEvents.dispatchEvent(new Event("change"));
  assert.equal(useThemeStore.getState().preference, "system");
  assert.equal(env.styles.get("--accent"), accentVariables("dark", "#f76eaa")?.["--accent"]);
  assert.notEqual(env.styles.get("--accent"), light);
  useThemeStore.getState().setAccent("blue");
  assert.equal(env.data.get("devport.accent.v1"), "blue");
  assert.equal(env.data.get("devport.theme.v1"), "system");
  env.data.set("devport.accent.v1", "url(invalid)");
  env.browserEvents.dispatchEvent(Object.assign(new Event("storage"), { key: "devport.accent.v1", storageArea: env.storage }));
  assert.equal(useThemeStore.getState().accent, "default");
  assert.ok(ACCENT_VARIABLES.every(key => !env.styles.has(key)));
  assert.equal(env.styles.get("zoom"), "1.5");
});

test("custom colors normalize to a full hex value", () => {
  assert.equal(normalizeAccent(" #A0bC19 "), "#a0bc19");
  assert.equal(normalizeAccent("59AD09"), "#59ad09");
  assert.equal(normalizeAccent("#123"), "default");
  assert.equal(normalizeAccent("__proto__"), "default");
  assert.equal(normalizeAccent("#12345678"), "default");
});

function luminance(hex: string) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

function contrast(color: string, background: string) {
  const first = luminance(color) + .05;
  const second = luminance(background) + .05;
  return Math.max(first, second) / Math.min(first, second);
}

test("accent text, primary buttons and focus indicators remain readable in both modes", () => {
  const choices = [...Object.keys(ACCENT_PRESETS).filter(isAccentPreset), "#ffffff", "#000000", "#ffff00"] as const;
  for (const theme of ["light", "dark"] as const) {
    for (const choice of choices) {
      const colors = accentVariables(theme, choice);
      if (!colors) continue;
      const buttonFill = colors["--accent-solid"];
      const buttonText = colors["--accent-on-solid"];
      const hover = theme === "light" ? "#eae7e3" : "#343d4b";
      const surface = colors["--accent-surface"];
      assert.ok(contrast(colors["--accent"], hover) >= 4.5, `${theme}: ${choice} accent hover surface`);
      assert.ok(contrast(colors["--accent"], surface) >= 4.5, `${theme}: ${choice} accent surface`);
      assert.ok(contrast(colors["--accent-border"], surface) >= 3, `${theme}: ${choice} focus border`);
      assert.ok(contrast(buttonText, buttonFill) >= 4.5, `${theme}: ${choice} button`);
      assert.ok(contrast(buttonText, colors["--accent-solid-hover"]) >= 4.5, `${theme}: ${choice} button hover`);
      const original = terminalTheme(theme);
      const terminal = terminalTheme(theme, choice);
      assert.equal(terminal.cursor, colors["--accent"]);
      assert.equal(terminal.selectionBackground, colors["--selection"]);
      assert.equal(terminal.background, original.background);
      assert.equal(terminal.red, original.red);
      assert.equal(terminal.blue, original.blue);
    }
  }
});

test("terminal foreground and ANSI colors stay readable in both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    const colors = terminalTheme(theme);
    for (const key of ["foreground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
      assert.ok(contrast(colors[key]!, colors.background!) >= 4.5, `${theme}: ${key}`);
    }
  }
});
