import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UI_ZOOM,
  changeUiZoom,
  loadUiZoom,
  normalizeUiZoom,
  saveUiZoom,
  uiZoomShortcut,
} from "../src/uiZoom";

function mockLocalStorage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return data;
}

test("UI zoom normalizes invalid and arbitrary persisted values", () => {
  assert.equal(normalizeUiZoom(undefined), DEFAULT_UI_ZOOM);
  assert.equal(normalizeUiZoom("broken"), DEFAULT_UI_ZOOM);
  assert.equal(normalizeUiZoom(116), 120);
  assert.equal(normalizeUiZoom(-50), 70);
  assert.equal(normalizeUiZoom(999), 200);
});

test("UI zoom moves through bounded levels and resets", () => {
  assert.equal(changeUiZoom(100, "in"), 110);
  assert.equal(changeUiZoom(100, "out"), 90);
  assert.equal(changeUiZoom(200, "in"), 200);
  assert.equal(changeUiZoom(70, "out"), 70);
  assert.equal(changeUiZoom(175, "reset"), 100);
});

test("UI zoom recognizes main keyboard and numpad shortcuts", () => {
  const event = { altKey: false, ctrlKey: true, metaKey: false, key: "=", code: "Equal" };
  assert.equal(uiZoomShortcut(event), "in");
  assert.equal(uiZoomShortcut({ ...event, key: "-", code: "Minus" }), "out");
  assert.equal(uiZoomShortcut({ ...event, key: "0", code: "Digit0" }), "reset");
  assert.equal(uiZoomShortcut({ ...event, ctrlKey: false, metaKey: true }), "in");
  assert.equal(uiZoomShortcut({ ...event, key: "+", code: "NumpadAdd" }), "in");
  assert.equal(uiZoomShortcut({ ...event, altKey: true }), null);
  assert.equal(uiZoomShortcut({ ...event, ctrlKey: false }), null);
});

test("UI zoom preference persists and loads", (t) => {
  const data = mockLocalStorage(t);
  assert.equal(loadUiZoom(), DEFAULT_UI_ZOOM);
  saveUiZoom(130);
  assert.equal(data.get("devport.ui-zoom.v1"), "130");
  assert.equal(loadUiZoom(), 130);
});
