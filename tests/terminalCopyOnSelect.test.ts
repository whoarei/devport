import test from "node:test";
import assert from "node:assert/strict";
import { attachTerminalCopyOnSelect, loadCopyOnSelect, saveCopyOnSelect } from "../src/terminalCopyOnSelect";
import { useTerminalStore } from "../src/terminalStore";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const mouse = (type: string, values: Record<string, unknown> = {}) => Object.assign(new Event(type), {
  button: 0, shiftKey: false, altKey: false, detail: 1, ...values,
});

function fixture(t: test.TestContext) {
  const window = Object.assign(new EventTarget(), { navigator: { platform: "Win32" } });
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false });
  let selectable = true;
  const screen = { contains: () => selectable };
  const element = Object.assign(new EventTarget(), { ownerDocument: document, querySelector: () => screen });
  const state = { enabled: true, visible: true, context: "session-1", text: "", tracking: "none", macForce: false };
  const term = {
    element,
    getSelection: () => state.text,
    get modes() { return { mouseTrackingMode: state.tracking }; },
    get options() { return { macOptionClickForcesSelection: state.macForce }; },
  } as unknown as Parameters<typeof attachTerminalCopyOnSelect>[0];
  const copied: string[] = [], results: unknown[] = [];
  let write = async (text: string) => { copied.push(text); };
  let finalSelection: string | undefined;
  // Simulate xterm registering its final-selection callback before our binding.
  element.addEventListener("mousedown", () => {
    document.addEventListener("mouseup", () => {
      if (finalSelection !== undefined) state.text = finalSelection;
    }, { once: true });
  });
  const binding = attachTerminalCopyOnSelect(term, {
    enabled: () => state.enabled && state.visible,
    context: () => state.context,
    copy: (text) => write(text),
    onResult: (error) => results.push(error),
  });
  t.after(() => binding.dispose());
  return { state, copied, results, document, window, element, binding,
    down: (values?: Record<string, unknown>) => element.dispatchEvent(mouse("mousedown", values)),
    up: (values?: Record<string, unknown>) => document.dispatchEvent(mouse("mouseup", values)),
    write: (callback: typeof write) => { write = callback; },
    final: (text: string) => { finalSelection = text; },
    selectable: (value: boolean) => { selectable = value; },
  };
}

test("copy-on-select defaults off, persists only explicit booleans and survives unavailable storage", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = useTerminalStore.getState();
  t.after(() => { useTerminalStore.setState(store, true); if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  let value: string | null = null;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } } });
  for (const invalid of [null, "", "false", "1", "TRUE", '"true"']) { value = invalid; assert.equal(loadCopyOnSelect(), false); }
  useTerminalStore.getState().setCopyOnSelect(true);
  assert.equal(value, "true");
  assert.equal(loadCopyOnSelect(), true);
  assert.equal(useTerminalStore.getState().copyOnSelect, true);
  useTerminalStore.getState().setCopyOnSelect(false);
  assert.equal(loadCopyOnSelect(), false);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("unavailable"); } });
  assert.equal(loadCopyOnSelect(), false);
  assert.doesNotThrow(() => saveCopyOnSelect(true));
  assert.doesNotThrow(() => useTerminalStore.getState().setCopyOnSelect(true));
  assert.equal(useTerminalStore.getState().copyOnSelect, true);
});

test("mouse selection copies exactly once on release and sees xterm's final Unicode text", async (t) => {
  const f = fixture(t);
  f.down();
  f.state.text = "partial";
  f.document.dispatchEvent(new Event("mousemove"));
  assert.deepEqual(f.copied, []);
  f.final("  中文错误 /tmp/test.py\r\nnext line  ");
  f.up();
  f.up();
  await flush();
  assert.deepEqual(f.copied, ["  中文错误 /tmp/test.py\r\nnext line  "]);
  assert.deepEqual(f.results, [null]);
});

test("empty selections, secondary clicks, scrollbars and programmatic selection never copy", (t) => {
  const f = fixture(t);
  f.down(); f.up();
  f.state.text = "select all / background selection";
  f.element.dispatchEvent(new Event("selectionchange"));
  f.up();
  f.down({ button: 2 }); f.up({ button: 2 });
  f.down({ button: 1 }); f.up({ button: 1 });
  f.selectable(false); f.down(); f.up();
  assert.deepEqual(f.copied, []);
});

test("word, line, rectangular and repeated selections copy without clearing the selection", (t) => {
  const f = fixture(t);
  for (const values of [{ detail: 2 }, { detail: 3 }, { altKey: true }, {}]) {
    f.down(values); f.state.text = "same selection"; f.up(values);
    assert.equal(f.state.text, "same selection");
  }
  assert.deepEqual(f.copied, Array(4).fill("same selection"));
});

test("an open view observes the live setting and rejects hidden or replaced sessions/runs", (t) => {
  const f = fixture(t);
  f.state.text = "selected";
  f.state.enabled = false; f.down(); f.up();
  f.state.enabled = true; f.down(); f.state.enabled = false; f.up();
  f.state.enabled = true; f.down(); f.state.visible = false; f.up();
  f.state.visible = true; f.down(); f.state.context = "session-2"; f.up();
  assert.deepEqual(f.copied, []);
  f.down(); f.up();
  assert.deepEqual(f.copied, ["selected"]);
});

test("mouse-reporting applications retain their clicks; only xterm's selection modifier opts in", (t) => {
  const f = fixture(t);
  f.state.text = "selected";
  f.state.tracking = "vt200";
  f.down(); f.up();
  assert.deepEqual(f.copied, []);
  f.down({ shiftKey: true }); f.up({ shiftKey: true });
  assert.deepEqual(f.copied, ["selected"]);
  f.window.navigator.platform = "MacIntel";
  f.down({ shiftKey: true }); f.up({ shiftKey: true });
  f.down({ altKey: true }); f.up({ altKey: true });
  assert.equal(f.copied.length, 1);
  f.state.macForce = true; f.down({ altKey: true }); f.up({ altKey: true });
  assert.equal(f.copied.length, 2);
});

test("cancelled, blurred, backgrounded and disposed gestures leave the clipboard alone", (t) => {
  const f = fixture(t);
  f.state.text = "selected";
  f.down(); f.document.dispatchEvent(new Event("pointercancel")); f.up();
  f.down(); f.window.dispatchEvent(new Event("blur")); f.up();
  f.down(); f.document.hidden = true; f.document.dispatchEvent(new Event("visibilitychange")); f.up();
  f.document.hidden = false; f.down(); f.binding.dispose(); f.up();
  f.down(); f.up();
  assert.deepEqual(f.copied, []);
});

test("clipboard failures are recoverable and obsolete async results do not affect a new selection", async (t) => {
  const f = fixture(t);
  f.state.text = "selected";
  const failure = new Error("permission denied");
  f.write(() => { throw failure; });
  assert.doesNotThrow(() => { f.down(); f.up(); });
  assert.deepEqual(f.results, [failure]);
  f.write(async () => { throw failure; });
  f.down(); f.up(); await flush();
  assert.deepEqual(f.results, [failure, failure]);
  let reject!: (error: unknown) => void;
  f.write(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  f.down(); f.up();
  f.write(async (text) => { f.copied.push(text); });
  f.down(); f.up(); await flush();
  reject(failure); await flush();
  assert.deepEqual(f.results, [failure, failure, null]);
  assert.deepEqual(f.copied, ["selected"]);
});

test("disposed views and replaced sessions suppress pending clipboard errors", async (t) => {
  const f = fixture(t);
  f.state.text = "selected";
  let fail!: (error: unknown) => void;
  f.write(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  f.down(); f.up(); f.state.context = "session-2"; fail(new Error("old session")); await flush();
  f.down(); f.up(); f.binding.dispose(); fail(new Error("disposed")); await flush();
  assert.deepEqual(f.results, []);
});
