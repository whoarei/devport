import test from "node:test";
import assert from "node:assert/strict";
import { initializeTheme, loadThemePreference, terminalTheme, useThemeStore } from "../src/theme";

function environment(t: test.TestContext) {
  const originals = ["localStorage", "window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const data = new Map<string, string>();
  const mediaEvents = new EventTarget();
  const browserEvents = new EventTarget();
  const media = { matches: false, addEventListener: mediaEvents.addEventListener.bind(mediaEvents), removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents) };
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) };
  const window = { matchMedia: () => media, addEventListener: browserEvents.addEventListener.bind(browserEvents), removeEventListener: browserEvents.removeEventListener.bind(browserEvents) };
  for (const [name, value] of Object.entries({ localStorage: storage, window, document })) Object.defineProperty(globalThis, name, { configurable: true, value });
  useThemeStore.setState({ preference: "dark", theme: "dark" });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return { data, document, media, mediaEvents, browserEvents, storage };
}

test("theme restores before rendering and persists an explicit choice", (t) => {
  const env = environment(t);
  assert.equal(loadThemePreference(), "dark");
  env.data.set("remote-runner.theme.v1", "light");
  const stop = initializeTheme();
  t.after(stop);
  assert.equal(env.document.documentElement.dataset.theme, "light");
  useThemeStore.getState().setPreference("dark");
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  assert.equal(env.data.get("remote-runner.theme.v1"), "dark");
});

test("system theme follows live changes without overriding manual selection and unsubscribes", (t) => {
  const env = environment(t);
  env.data.set("remote-runner.theme.v1", "system");
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
  env.data.set("remote-runner.theme.v1", "invalid");
  const stop = initializeTheme();
  t.after(stop);
  assert.equal(useThemeStore.getState().theme, "dark");
  env.data.set("remote-runner.theme.v1", "light");
  const event = Object.assign(new Event("storage"), { key: "remote-runner.theme.v1", storageArea: env.storage });
  env.browserEvents.dispatchEvent(event);
  assert.equal(env.document.documentElement.dataset.theme, "light");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  assert.equal(loadThemePreference(), "dark");
  assert.doesNotThrow(() => useThemeStore.getState().setPreference("dark"));
  assert.equal(env.document.documentElement.dataset.theme, "dark");
});

test("light terminal foreground and ANSI colors stay readable on its background", () => {
  const colors = terminalTheme("light");
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const background = luminance(colors.background!);
  for (const key of ["foreground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
    assert.ok((background + .05) / (luminance(colors[key]!) + .05) >= 4.5, key);
  }
});
