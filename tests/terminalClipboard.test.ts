import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalClipboard, loadTerminalClipboardPreference, saveTerminalClipboardPreference,
  type TerminalClipboardPreferences } from "../src/terminalClipboard";
import { useTerminalStore } from "../src/terminalStore";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const key = (name: string, patch: Partial<KeyboardEvent> = {}) => Object.assign({
  type: "keydown", key: name, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
  repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
  getModifierState: () => false,
  preventDefault() { this.defaultPrevented = true; },
}, patch);

function fixture(t: test.TestContext, preferences?: () => TerminalClipboardPreferences) {
  const state = { text: "", clipboard: "中文\nnext line", context: "session-1" as string | undefined, visible: true, focused: false };
  const prefs = { copyOnCtrlC: true, pasteOnCtrlV: true };
  const sent: string[] = [], copied: string[] = [], pasted: string[] = [];
  const results: { action: string; error: unknown }[] = [];
  let focusCount = 0, readCount = 0;
  let read = async () => state.clipboard;
  let write = async (text: string) => { copied.push(text); state.clipboard = text; };
  const binding = createTerminalClipboard({
    getSelection: () => state.text,
    focus: () => { state.focused = true; focusCount++; },
    paste: text => { pasted.push(text); },
  }, {
    preferences: preferences ?? (() => prefs),
    enabled: () => state.visible,
    context: () => state.context,
    send: data => { if (state.context) sent.push(data); },
    clipboard: { readText: () => { readCount++; return read(); }, writeText: text => write(text) },
    onResult: (action, error) => results.push({ action, error }),
  });
  t.after(() => binding.dispose());
  return { state, prefs, sent, copied, pasted, results, binding,
    handle: binding.handleKey,
    counts: () => ({ focusCount, readCount }),
    read: (callback: typeof read) => { read = callback; },
    write: (callback: typeof write) => { write = callback; },
  };
}

test("clipboard switches default on, persist independently and retain session settings without storage", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = useTerminalStore.getState();
  t.after(() => {
    useTerminalStore.setState(store, true);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  for (const name of ["copyOnCtrlC", "pasteOnCtrlV"] as const) {
    for (const value of [null, "", "true", "0", "FALSE", '"false"']) {
      values.clear();
      if (value !== null) values.set(name === "copyOnCtrlC" ? "remote-runner.copy-on-ctrl-c.v1" : "remote-runner.paste-on-ctrl-v.v1", value);
      assert.equal(loadTerminalClipboardPreference(name), true);
    }
    saveTerminalClipboardPreference(name, false);
    assert.equal(loadTerminalClipboardPreference(name), false);
  }
  values.clear();
  useTerminalStore.getState().setCopyOnCtrlC(false);
  assert.equal(useTerminalStore.getState().copyOnCtrlC, false);
  assert.equal(loadTerminalClipboardPreference("copyOnCtrlC"), false);
  assert.equal(loadTerminalClipboardPreference("pasteOnCtrlV"), true);
  useTerminalStore.getState().setPasteOnCtrlV(false);
  useTerminalStore.getState().setCopyOnCtrlC(true);
  assert.equal(loadTerminalClipboardPreference("pasteOnCtrlV"), false);
  assert.equal(loadTerminalClipboardPreference("copyOnCtrlC"), true);
  assert.equal(useTerminalStore.getState().copyOnSelect, store.copyOnSelect);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("unavailable"); } });
  assert.equal(loadTerminalClipboardPreference("copyOnCtrlC"), true);
  assert.equal(loadTerminalClipboardPreference("pasteOnCtrlV"), true);
  assert.doesNotThrow(() => useTerminalStore.getState().setCopyOnCtrlC(false));
  assert.doesNotThrow(() => useTerminalStore.getState().setPasteOnCtrlV(false));
  assert.equal(useTerminalStore.getState().copyOnCtrlC, false);
  assert.equal(useTerminalStore.getState().pasteOnCtrlV, false);
});

test("Ctrl+C copies and retains a selection, otherwise interrupts once per physical press", t => {
  const f = fixture(t);
  for (const patch of [{}, { repeat: true }, { type: "keypress" }, { type: "keyup" }]) {
    const event = key("c", patch);
    assert.equal(f.handle(event), false);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(f.sent, ["\x03"]);
  f.handle(key("c"));
  assert.deepEqual(f.sent, ["\x03", "\x03"]);
  f.state.text = "  中文\nselected  ";
  f.handle(key("C"));
  f.handle(key("C", { repeat: true }));
  assert.deepEqual(f.copied, [f.state.text]);
  assert.equal(f.state.text, "  中文\nselected  ");
  assert.equal(f.sent.length, 2);
  f.prefs.copyOnCtrlC = false;
  f.handle(key("c"));
  assert.equal(f.sent.length, 3, "disabling selection-copy sends Ctrl+C even with a selection");
  assert.equal(f.copied.length, 1);
});

test("Ctrl+V pastes once and prevents native duplicates, or passes to xterm when disabled", async t => {
  const f = fixture(t);
  for (const patch of [{}, { repeat: true }, { type: "keypress" }, { type: "keyup" }]) {
    const event = key("v", patch);
    assert.equal(f.handle(event), false);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(f.counts(), { readCount: 1, focusCount: 1 });
  f.state.focused = false;
  await flush();
  assert.deepEqual(f.pasted, ["中文\nnext line"]);
  assert.equal(f.state.focused, false, "clipboard completion never steals focus");
  f.prefs.pasteOnCtrlV = false;
  const event = key("v");
  assert.equal(f.handle(event), true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.counts().readCount, 1);
});

test("Ctrl+Shift+C/V and menu actions work with both switches off; empty copy is inert", async t => {
  const f = fixture(t);
  f.prefs.copyOnCtrlC = f.prefs.pasteOnCtrlV = false;
  f.handle(key("c", { shiftKey: true }));
  assert.deepEqual(f.copied, []);
  f.state.text = "selection";
  f.handle(key("c", { shiftKey: true }));
  f.handle(key("v", { shiftKey: true }));
  await flush();
  assert.deepEqual(f.copied, ["selection"]);
  assert.deepEqual(f.pasted, ["selection"]);
  assert.deepEqual(f.sent, []);
  f.binding.copy(); f.binding.paste();
  await flush();
  assert.equal(f.copied.length, 2);
  assert.equal(f.pasted.length, 2);
});

test("IME, other modifiers, handled events and unrelated keys stay with xterm", t => {
  const f = fixture(t);
  for (const name of ["c", "v"]) {
    for (const patch of [{ ctrlKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true },
      { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: () => true }]) {
      assert.equal(f.handle(key(name, patch)), true);
    }
  }
  for (const name of ["d", "s", "w", "Tab", "Enter"]) assert.equal(f.handle(key(name)), true);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.copied, []);
  assert.equal(f.counts().readCount, 0);
});

test("existing terminal and run bindings immediately use independent global switches", async t => {
  const original = useTerminalStore.getState();
  t.after(() => useTerminalStore.setState(original, true));
  useTerminalStore.setState({ copyOnCtrlC: true, pasteOnCtrlV: true });
  const views = [fixture(t, useTerminalStore.getState), fixture(t, useTerminalStore.getState)];
  for (const f of views) { f.state.text = "text"; f.handle(key("c")); }
  useTerminalStore.setState({ copyOnCtrlC: false });
  for (const f of views) { f.handle(key("c")); f.handle(key("v")); }
  await flush();
  useTerminalStore.setState({ pasteOnCtrlV: false });
  for (const f of views) {
    assert.equal(f.handle(key("v")), true);
    assert.deepEqual(f.sent, ["\x03"]);
    assert.deepEqual(f.copied, ["text"]);
    assert.deepEqual(f.pasted, ["text"]);
  }
});

test("pending pastes cannot reach a replaced/finished session, hidden view or disposed terminal", async t => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => { f.state.context = "session-2"; },
    (f: ReturnType<typeof fixture>) => { f.state.context = undefined; },
    (f: ReturnType<typeof fixture>) => { f.state.visible = false; },
    (f: ReturnType<typeof fixture>) => { f.binding.dispose(); },
  ]) {
    const f = fixture(t);
    let resolve!: (text: string) => void;
    f.read(() => new Promise(done => { resolve = done; }));
    f.handle(key("v"));
    invalidate(f);
    resolve("stale paste");
    await flush();
    assert.deepEqual(f.pasted, []);
    assert.deepEqual(f.results, []);
  }
});

test("disconnected scrollback can be copied but cannot read or send clipboard input", async t => {
  const f = fixture(t);
  f.state.context = undefined;
  f.state.text = "old output";
  f.handle(key("c")); f.handle(key("v"));
  await flush();
  assert.deepEqual(f.copied, ["old output"]);
  assert.equal(f.counts().readCount, 0);
  assert.deepEqual(f.pasted, []);
});

test("clipboard failures preserve selection and never interrupt; later success clears the error", async t => {
  const f = fixture(t), error = new Error("clipboard denied");
  f.state.text = "preserved";
  f.write(() => Promise.reject(error));
  f.read(() => { throw error; });
  f.handle(key("c")); f.handle(key("v"));
  await flush();
  assert.ok(f.results.some(result => result.action === "copy" && result.error === error));
  assert.ok(f.results.some(result => result.action === "paste" && result.error === error));
  assert.equal(f.state.text, "preserved");
  assert.deepEqual(f.sent, []); assert.deepEqual(f.pasted, []);
  f.write(async () => {}); f.read(async () => "recovered");
  f.handle(key("c")); f.handle(key("v"));
  await flush();
  assert.deepEqual(f.results.slice(-2), [{ action: "copy", error: null }, { action: "paste", error: null }]);
  assert.deepEqual(f.pasted, ["recovered"]);
});
