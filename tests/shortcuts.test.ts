import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_SHORTCUTS, matchAppShortcut, shortcutLabel, type AppCommandId, type ShortcutContext } from "../src/shortcuts";
import { endAppTabCycle, handleAppKeyDown, handleAppKeyUp, handleAppShortcut, shortcutContext } from "../src/appShortcuts";
import { appCommandEnabled, executeAppCommand, scriptCommand } from "../src/appCommands";
import { api, localWorkspace, type DeviceProfile, type RunStatus } from "../src/api";
import { useAppStore } from "../src/store";
import { useWorkspaceRunStore } from "../src/workspaceRunStore";
import { useRunHistoryStore } from "../src/runHistoryStore";
import { useTerminalStore } from "../src/terminalStore";
import { useCommandUiStore } from "../src/commandUiStore";
import { DEFAULT_LAYOUT } from "../src/layoutState";
import { type EditorTab } from "../src/editorDocument";
import { ShortcutsDialog } from "../src/components/ShortcutsDialog";
import { createTerminalClipboard } from "../src/terminalClipboard";
import { endConsoleTabCycle } from "../src/consoleTabs";
import { trackEditorTabUsage } from "../src/editorTabCycle";
import { restoredTab } from "../src/environmentState";
import { RunReplayButton } from "../src/components/RunReplayButton";
import i18n from "../src/i18n";

test.before(async () => { await i18n.changeLanguage("zh"); });

function key(key: string, patch: Partial<KeyboardEvent> = {}) {
  let prevented = 0, stopped = 0;
  return Object.assign({ key, code: key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, type: "keydown", keyCode: 0,
    getModifierState: () => false,
    preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; },
  }, patch, { counts: () => ({ prevented, stopped }) }) as KeyboardEvent & { counts: () => { prevented: number; stopped: number } };
}

const device = (id: string, is_default = false, transport: DeviceProfile["transport"] = "ssh"): DeviceProfile => ({
  id, name: id, revision: "v1", transport, is_default, host: "localhost", port: 22, username: "user",
  auth: { type: "password", password: "" }, workspace_root: "/work",
});
const file = (name: string, dirty = true): EditorTab => ({ name, fileContent: dirty ? "new" : "base", savedContent: "base",
  revision: "v1", eol: "lf", bom: false, language: "python", conflict: false, generation: 1 });
const run = (id: string, state = "running"): RunStatus => ({ run_id: id, device_name: "original", label: id, state,
  exit_code: null, error: null, started_at: "", ended_at: null });
function reset(t: test.TestContext) {
  const app = useAppStore.getState(), feature = useWorkspaceRunStore.getState(), history = useRunHistoryStore.getState();
  const terminals = useTerminalStore.getState(), ui = useCommandUiStore.getState();
  let stopTracking = () => {};
  t.after(() => {
    endAppTabCycle(); stopTracking();
    useAppStore.setState(app, true); useWorkspaceRunStore.setState(feature, true);
    useRunHistoryStore.setState(history, true); useTerminalStore.setState(terminals, true); useCommandUiStore.setState(ui, true);
  });
  useAppStore.setState({ workspace: localWorkspace("/work"), openTabs: [file("main.py")], activeFile: "main.py",
    runs: {}, activeRunId: null, devices: [device("other"), device("default", true)], selectedDeviceId: "other",
    layout: structuredClone(DEFAULT_LAYOUT), loading: false, saving: false, starting: false, guarding: false,
    workspaceMutating: false, updating: false, editorError: null });
  useRunHistoryStore.setState({ busy: false, error: null });
  useTerminalStore.setState({ tabs: [], activeTab: "run", shuttingDown: false });
  useCommandUiStore.setState({ focus: null, shortcutsOpen: false });
  stopTracking = trackEditorTabUsage();
}

test("fixed bindings match exact modifiers, Mac primary keys and physical terminal control keys", () => {
  assert.equal(matchAppShortcut(key("O", { ctrlKey: true, shiftKey: true }), false), "openRemoteWorkspace");
  assert.equal(matchAppShortcut(key("s", { ctrlKey: true }), false), "saveFile");
  assert.equal(matchAppShortcut(key("s", { metaKey: true }), true), "saveFile");
  assert.equal(matchAppShortcut(key("s", { ctrlKey: true }), true), null);
  assert.equal(matchAppShortcut(key("F5", { ctrlKey: true }), true), "rerun");
  assert.equal(matchAppShortcut(key("F5", { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(matchAppShortcut(key("s", { ctrlKey: true, altKey: true }), false), null);
  assert.equal(matchAppShortcut(key("Enter", { ctrlKey: true }), false), null);
  assert.equal(matchAppShortcut(key("²", { ctrlKey: true, code: "Backquote" }), false), "toggleConsole");
  assert.equal(matchAppShortcut(key("`", { metaKey: true, code: "Backquote" }), true), "toggleConsole");
  assert.equal(shortcutLabel("saveAll", true), "⌘+Shift+S");
  assert.equal(shortcutLabel("rerun", true), "Ctrl+F5");
});

test("terminal shell and TUI keys pass through without preventing or stopping an event", () => {
  const events = ["c", "d", "z", "l", "r", "s", "w", "b", "o"].map(value => key(value, { ctrlKey: true }));
  events.push(key("s", { ctrlKey: true, shiftKey: true }), key("o", { ctrlKey: true, shiftKey: true }),
    key("F5"), key("F5", { shiftKey: true }), key("F5", { ctrlKey: true }), key("F5", { altKey: true }));
  for (const event of events) {
    assert.equal(handleAppShortcut(event, { area: "run", terminal: true }, () => assert.fail("terminal key triggered an action"), false), false, event.key);
    assert.deepEqual(event.counts(), { prevented: 0, stopped: 0 });
  }
});

test("the complete capture route passes terminal editing, clipboard, navigation and function keys through", () => {
  const events = [..."abcdefghijklmnopqrstuvwxyz"].flatMap(letter => [key(letter, { ctrlKey: true }),
    ...(letter === "t" ? [] : [key(letter.toUpperCase(), { ctrlKey: true, shiftKey: true })])]);
  for (let number = 1; number <= 12; number++) {
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { altKey: true }]) events.push(key(`F${number}`, modifiers));
  }
  for (const name of ["Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    events.push(key(name), key(name, { shiftKey: true }));
  }
  for (const event of events) {
    assert.equal(handleAppKeyDown(event, () => assert.fail("a terminal key changed zoom"), { area: "run", terminal: true }), false, `${event.key}, shift=${event.shiftKey}`);
    assert.deepEqual(event.counts(), { prevented: 0, stopped: 0 });
  }
});

test("the complete route consumes zoom and Ctrl+Tab exactly once, preserves repeat, and pauses them for dialogs and IME", t => {
  reset(t);
  endConsoleTabCycle(); t.after(endConsoleTabCycle);
  useTerminalStore.setState({ tabs: [{ id: "a", deviceId: "default", deviceName: "default", busy: false }], tabCycleOrder: "sequential" });
  const zooms: string[] = [];
  const zoom = (action: string) => { zooms.push(action); };
  const context: ShortcutContext = { area: "run", terminal: true };
  const next = key("Tab", { ctrlKey: true });
  assert.equal(handleAppKeyDown(next, zoom, context), true);
  assert.equal(useTerminalStore.getState().activeTab, "a");
  assert.deepEqual(next.counts(), { prevented: 1, stopped: 1 });
  handleAppKeyDown(key("Tab", { ctrlKey: true, repeat: true }), zoom, context);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  for (const [name, repeat] of [["=", false], ["=", true], ["-", false], ["0", false]] as const) {
    const event = key(name, { ctrlKey: true, repeat });
    assert.equal(handleAppKeyDown(event, zoom, context), true);
    assert.deepEqual(event.counts(), { prevented: 1, stopped: 1 });
  }
  assert.deepEqual(zooms, ["in", "in", "out", "reset"]);
  for (const name of ["Tab", "0"]) {
    for (const patch of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: () => true }]) {
      const event = key(name, { ctrlKey: true, ...patch });
      assert.equal(handleAppKeyDown(event, zoom, context), false);
      assert.deepEqual(event.counts(), { prevented: 0, stopped: 0 });
    }
    assert.equal(handleAppKeyDown(key(name, { ctrlKey: true }), zoom, { ...context, modal: true }), false);
  }
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.deepEqual(zooms, ["in", "in", "out", "reset"]);
});

test("Ctrl+Tab follows editor focus, wraps both ways and keeps dirty documents and console selection", t => {
  reset(t);
  const tabs = [file("a.py"), file("b.py"), file("c.py")];
  useAppStore.setState({ openTabs: tabs, activeFile: "a.py" });
  useTerminalStore.setState({ tabs: [{ id: "terminal", deviceId: "default", deviceName: "default", busy: false }],
    activeTab: "terminal", tabCycleOrder: "sequential" });
  const zoom = () => assert.fail("tab switching changed zoom");
  for (const [patch, expected] of [
    [{}, "b.py"], [{ repeat: true }, "c.py"], [{}, "a.py"], [{ shiftKey: true }, "c.py"],
  ] as const) {
    const event = key("Tab", { ctrlKey: true, ...patch });
    assert.equal(handleAppKeyDown(event, zoom, { area: "editor" }), true);
    assert.equal(useAppStore.getState().activeFile, expected);
    assert.equal(useTerminalStore.getState().activeTab, "terminal");
    assert.equal(useCommandUiStore.getState().focus, "editor");
    assert.deepEqual(event.counts(), { prevented: 1, stopped: 1 });
    assert.equal(useAppStore.getState().openTabs, tabs, "switching must retain unsaved edits and document identity");
  }
  handleAppKeyDown(key("Tab", { ctrlKey: true }), zoom, { area: "run", terminal: true });
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.equal(useAppStore.getState().activeFile, "c.py");
});

test("editor MRU stays stable until Control release and commits the final choice on window blur", t => {
  reset(t);
  useAppStore.setState({ openTabs: [file("a"), file("b"), file("c")], activeFile: "a" });
  const select = useAppStore.getState().activateFile;
  select("c"); select("b"); // Most recent: b, c, a; visual order differs.
  useTerminalStore.setState({ tabCycleOrder: "mru" });
  const cycle = (reverse = false) => handleAppKeyDown(key("Tab", { ctrlKey: true, shiftKey: reverse }), () => {}, { area: "editor" });
  cycle(); assert.equal(useAppStore.getState().activeFile, "c");
  cycle(); assert.equal(useAppStore.getState().activeFile, "a");
  cycle(true); assert.equal(useAppStore.getState().activeFile, "c");
  assert.equal(handleAppKeyUp(key("Tab")), false);
  assert.equal(handleAppKeyUp(key("Control")), true); // Commit c, b, a.
  cycle(); assert.equal(useAppStore.getState().activeFile, "b");
  endAppTabCycle(); // Same path as window blur; commit b, c, a.
  cycle(); assert.equal(useAppStore.getState().activeFile, "c");
});

test("editor cycles filter closed tabs, include new tabs and reset MRU when the workspace changes", t => {
  reset(t);
  const tabs = [file("a"), file("b"), file("c")];
  useAppStore.setState({ openTabs: tabs, activeFile: "a" });
  useAppStore.getState().activateFile("c"); useAppStore.getState().activateFile("b");
  useTerminalStore.setState({ tabCycleOrder: "mru" });
  const cycle = () => handleAppKeyDown(key("Tab", { ctrlKey: true }), () => {}, { area: "editor" });
  cycle(); assert.equal(useAppStore.getState().activeFile, "c");
  useAppStore.setState({ openTabs: [tabs[1], tabs[2], file("d")] });
  cycle(); assert.equal(useAppStore.getState().activeFile, "d");
  useAppStore.setState({ workspace: localWorkspace("/other"), openTabs: tabs, activeFile: "b" });
  cycle(); assert.equal(useAppStore.getState().activeFile, "a", "old workspace history must not leak");
});

test("empty, single-file and guarded editors never fall through to terminal switching", t => {
  reset(t);
  useTerminalStore.setState({ tabs: [{ id: "terminal", deviceId: "default", deviceName: "default", busy: false }] });
  for (const patch of [
    { openTabs: [], activeFile: null }, { openTabs: [file("a")], activeFile: "a" },
    { openTabs: [file("a"), file("b")], activeFile: "a", guarding: true },
  ]) {
    useAppStore.setState(patch);
    const event = key("Tab", { ctrlKey: true });
    assert.equal(handleAppKeyDown(event, () => {}, { area: "editor" }), true);
    assert.equal(useAppStore.getState().activeFile, patch.activeFile);
    assert.equal(useTerminalStore.getState().activeTab, "run");
  }
});

test("editor tab switching respects dialogs, composition and exact modifiers", t => {
  reset(t);
  useAppStore.setState({ openTabs: [file("a"), file("b")], activeFile: "a" });
  for (const patch of [{ ctrlKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true },
    { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: () => true }]) {
    const event = key("Tab", { ctrlKey: true, ...patch });
    assert.equal(handleAppKeyDown(event, () => {}, { area: "editor" }), false);
    assert.deepEqual(event.counts(), { prevented: 0, stopped: 0 });
  }
  assert.equal(handleAppKeyDown(key("Tab", { ctrlKey: true }), () => {}, { area: "editor", modal: true }), false);
  assert.equal(useAppStore.getState().activeFile, "a");
});

test("cycling to a restored file loads it through the existing file path without saving drafts", async t => {
  reset(t);
  const draft = restoredTab({ name: "draft.py", language: "python", draft: {
    content: "unsaved", saved_content: "disk", revision: "v1", eol: "lf", bom: false,
  } });
  useAppStore.setState({ openTabs: [file("a"), draft], activeFile: "a" });
  useTerminalStore.setState({ tabCycleOrder: "sequential" });
  const read = t.mock.method(api, "readWorkspaceFile", async () => ({ content: "disk", revision: "v1", eol: "lf" as const, bom: false }));
  t.mock.method(api, "writeWorkspaceFile", async () => assert.fail("switching saved a draft"));
  handleAppKeyDown(key("Tab", { ctrlKey: true }), () => {}, { area: "editor" });
  await new Promise(resolve => setImmediate(resolve));
  const state = useAppStore.getState();
  assert.equal(read.mock.callCount(), 1);
  assert.equal(state.activeFile, "draft.py");
  assert.equal(state.openTabs[1].loaded, true);
  assert.equal(state.openTabs[1].fileContent, "unsaved");
  assert.equal(state.openTabs[1].savedContent, "disk");
});

test("cycling past a loading restored file cancels its stale activation", async t => {
  reset(t);
  useAppStore.setState({ openTabs: [file("a"), restoredTab({ name: "b", language: "text" }), file("c")], activeFile: "a" });
  useTerminalStore.setState({ tabCycleOrder: "sequential" });
  let complete!: (doc: { content: string; revision: string; eol: "lf"; bom: boolean }) => void;
  t.mock.method(api, "readWorkspaceFile", () => new Promise(resolve => { complete = resolve; }));
  const cycle = () => handleAppKeyDown(key("Tab", { ctrlKey: true }), () => {}, { area: "editor" });
  cycle(); assert.equal(useAppStore.getState().activeFile, "b");
  cycle(); assert.equal(useAppStore.getState().activeFile, "c");
  complete({ content: "disk", revision: "v1", eol: "lf", bom: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(useAppStore.getState().activeFile, "c");
  assert.equal(useAppStore.getState().loading, false);
});

test("terminal allowlist only dispatches the explicit focus, panel toggle and new-terminal combinations", () => {
  const executed: string[] = [];
  for (const event of [key("1", { ctrlKey: true }), key("`", { ctrlKey: true }), key("T", { ctrlKey: true, shiftKey: true })]) {
    assert.equal(handleAppShortcut(event, { area: "run", terminal: true }, id => executed.push(id), false), true);
    assert.deepEqual(event.counts(), { prevented: 1, stopped: 1 });
  }
  assert.deepEqual(executed, ["focusEditor", "toggleConsole", "newTerminal"]);
});

test("DOM context distinguishes the xterm textarea and CodeMirror content from ordinary form fields", t => {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  class Target {
    constructor(private regions: string[]) {}
    closest(selector: string) {
      if (selector.startsWith("input,")) return this.regions.includes("form") ? this : null;
      return this.regions.includes(selector) ? this : null;
    }
  }
  Object.defineProperty(globalThis, "Element", { configurable: true, value: Target });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
  t.after(() => {
    if (originalElement) Object.defineProperty(globalThis, "Element", originalElement); else Reflect.deleteProperty(globalThis, "Element");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  });
  const context = (regions: string[]) => shortcutContext(new Target(regions) as unknown as EventTarget);
  const terminal = context([".xterm", ".run-page", ".console-panel", "form"]);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.console, true);
  assert.equal(context([".console-panel"]).console, true, "console tab headers also return focus when hidden");
  assert.equal(context([".editor"]).console, false);
  assert.equal(terminal.input, false, "xterm's textarea must not block the application navigation allowlist");
  let focused = false;
  handleAppShortcut(key("`", { ctrlKey: true }), terminal, () => { focused = true; }, false);
  assert.equal(focused, true);
  assert.equal(context([".editor", ".cm-content", "form"]).input, false);
  assert.equal(context([".editor", "form"]).input, true, "editor search inputs remain ordinary forms");
  assert.equal(context([".workspace-panel", "form"]).input, true);
});

test("Ctrl+C keeps selection-copy and single interrupt semantics after application dispatch", () => {
  const sent: string[] = [], copied: string[] = [];
  let selected = "";
  const clipboard = createTerminalClipboard({ getSelection: () => selected, focus() {}, paste() {} }, {
    preferences: () => ({ copyOnCtrlC: true, pasteOnCtrlV: true }), enabled: () => true, context: () => "run",
    send: data => sent.push(data), clipboard: { readText: async () => "", writeText: async text => { copied.push(text); } },
  });
  for (const [selection, repeat] of [["", false], ["", true], ["text", false]] as const) {
    selected = selection;
    const event = key("c", { ctrlKey: true, repeat });
    assert.equal(handleAppShortcut(event, { area: "run", terminal: true }, () => assert.fail(), false), false);
    assert.equal(clipboard.handleKey(event), false);
  }
  assert.deepEqual(sent, ["\x03"]); assert.deepEqual(copied, ["text"]);
  clipboard.dispose();
});

test("IME, AltGraph, dialogs, forms and handled events never dispatch background actions", () => {
  const reject = () => assert.fail("blocked key dispatched an action");
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: () => true }]) {
    const event = key("s", { ctrlKey: true, ...patch });
    assert.equal(handleAppShortcut(event, { area: "editor" }, reject, false), false);
    assert.deepEqual(event.counts(), { prevented: 0, stopped: 0 });
  }
  for (const context of [{ area: "editor", modal: true }, { area: "workspace", input: true }] as ShortcutContext[]) {
    assert.equal(handleAppShortcut(key("s", { ctrlKey: true }), context, reject, false), false);
    const refresh = key("F5");
    assert.equal(handleAppShortcut(refresh, context, reject, false), true);
    assert.deepEqual(refresh.counts(), { prevented: 1, stopped: 1 });
  }
});

test("run commands honor focus scope and repeated keydowns are consumed without running twice", () => {
  const executed: Array<[string, ShortcutContext]> = [];
  const execute = (id: AppCommandId, context: ShortcutContext) => { executed.push([id, context]); };
  const context = { area: "workspace" as const, filePath: "sub/task.sh" };
  handleAppShortcut(key("F5"), context, execute, false);
  handleAppShortcut(key("F5", { repeat: true }), context, execute, false);
  handleAppShortcut(key("F5"), { area: "other" }, execute, false);
  handleAppShortcut(key("F5", { shiftKey: true }), { area: "editor" }, execute, false);
  assert.deepEqual(executed, [["runFile", context]]);
  const refresh = key("F5");
  assert.equal(handleAppShortcut(refresh, { area: "history" }, execute, false), true);
  assert.equal(refresh.counts().prevented, 1);
});

test("script launch uses focused tree file, while argument editing reuses that script's last arguments", async t => {
  reset(t);
  const launch = t.mock.method(useWorkspaceRunStore.getState(), "run", () => {});
  await executeAppCommand("runFile", { area: "workspace", filePath: "tools/job.sh" });
  assert.deepEqual(launch.mock.calls[0].arguments, [
    { entry: { type: "bash_script", path: "tools/job.sh" }, args: [] }, { type: "file", path: "tools/job.sh" },
  ]);
  await executeAppCommand("runFile", { area: "workspace" });
  assert.equal(launch.mock.callCount(), 1, "a directory must not fall back to the active editor file");
  useWorkspaceRunStore.setState({ commands: { revision: "v1", entries: [
    { id: "old", entry: { type: "bash_script", path: "tools/job.sh" }, args: ["a b", ""], sources: [], last_used_at: "" },
  ] } });
  await executeAppCommand("runWithArgs", { area: "workspace", filePath: "tools/job.sh" });
  assert.deepEqual(useWorkspaceRunStore.getState().args?.command.args, ["a b", ""]);
  assert.deepEqual(useWorkspaceRunStore.getState().args?.source, { type: "file", path: "tools/job.sh" });
  assert.equal(scriptCommand("notes.txt"), null);
});

test("shared guards block actions during save/start/update and only offer replay for complete snapshots", async t => {
  reset(t);
  for (const field of ["loading", "saving", "starting", "guarding", "workspaceMutating", "updating"] as const) {
    useAppStore.setState({ [field]: true });
    for (const id of ["saveFile", "saveAll", "runFile", "runWithArgs", "closeFile", "openWorkspace"] as const) {
      assert.equal(appCommandEnabled(id, { area: "editor" }), false, `${field}: ${id}`);
    }
    useAppStore.setState({ [field]: false });
  }
  useAppStore.setState({ runs: { active: run("active"), legacy: run("legacy", "exited") } });
  assert.equal(appCommandEnabled("rerun", { area: "run", runId: "legacy" }), false);
  assert.equal(appCommandEnabled("stop", { area: "run", runId: "legacy" }), false);
  assert.equal(appCommandEnabled("stop", { area: "history", runId: "active" }), true);
});

test("stop suppresses duplicate requests for one task while different tasks can stop independently", async t => {
  reset(t);
  useAppStore.setState({ runs: { visible: run("visible"), focused: run("focused") }, activeRunId: "visible" });
  const finishes: Array<() => void> = [];
  const stop = t.mock.method(api, "stopRun", async () => new Promise<void>(resolve => { finishes.push(resolve); }));
  const first = executeAppCommand("stop", { area: "history", runId: "focused" });
  await executeAppCommand("stop", { area: "history", runId: "focused" });
  assert.equal(stop.mock.callCount(), 1);
  assert.deepEqual(stop.mock.calls[0].arguments, ["focused"]);
  const second = executeAppCommand("stop", { area: "run", runId: "visible" });
  assert.equal(stop.mock.callCount(), 2);
  assert.deepEqual(stop.mock.calls[1].arguments, ["visible"]);
  for (const finish of finishes) finish();
  await Promise.all([first, second]);
});

test("replay always uses the original target path rather than the currently selected device", async t => {
  reset(t);
  const complete = { ...run("complete", "exited"), replay: {} } as RunStatus;
  useAppStore.setState({ runs: { complete }, activeRunId: "complete" });
  const replay = t.mock.method(useRunHistoryStore.getState(), "rerun", async () => {});
  await executeAppCommand("rerun", { area: "run", runId: "complete" });
  assert.deepEqual(replay.mock.calls[0].arguments, [complete, "original"]);
});

test("save-all uses the existing serial save pipeline and stops on a failed file", async t => {
  reset(t);
  useAppStore.setState({ openTabs: [file("a.py"), file("b.py"), file("c.py")] });
  const write = t.mock.method(api, "writeWorkspaceFile", async (request: { name: string }) => {
    if (request.name === "b.py") throw new Error("conflict");
    return { revision: "v2" };
  });
  await executeAppCommand("saveAll", { area: "editor" });
  assert.deepEqual(write.mock.calls.map(call => call.arguments[0].name), ["a.py", "b.py"]);
  assert.deepEqual(useAppStore.getState().openTabs.map(tab => tab.savedContent), ["new", "base", "base"]);
});

test("new terminal follows the default device including serial and honors tab limit and shutdown guards", async t => {
  reset(t);
  const open = t.mock.method(useTerminalStore.getState(), "open", async () => {});
  await executeAppCommand("newTerminal");
  assert.deepEqual(open.mock.calls[0].arguments, ["default", "default"]);
  useAppStore.setState({ devices: [device("serial", true, "serial"), device("other")] });
  assert.equal(appCommandEnabled("newTerminal"), true);
  await executeAppCommand("newTerminal");
  assert.deepEqual(open.mock.calls[1].arguments, ["serial", "serial"]);
  useAppStore.setState({ devices: [device("fallback")] });
  useTerminalStore.setState({ shuttingDown: true });
  assert.equal(appCommandEnabled("newTerminal"), false);
  useTerminalStore.setState({ shuttingDown: false, tabs: Array.from({ length: 8 }, (_, i) => ({ id: String(i) })) as never });
  assert.equal(appCommandEnabled("newTerminal"), false);
});

test("multiple explicit new-terminal actions can connect concurrently without losing tabs", async t => {
  reset(t);
  const finishes: Array<() => void> = [];
  const open = t.mock.method(api, "openTerminal", async (deviceId: string) => new Promise<{
    session_id: string; device_name: string; state: "connected"; exit_code: null; error: null;
  }>(resolve => { const sessionId = `s${finishes.length}`;
    finishes.push(() => resolve({ session_id: sessionId, device_name: deviceId, state: "connected", exit_code: null, error: null })); }));
  const first = executeAppCommand("newTerminal");
  const second = executeAppCommand("newTerminal");
  assert.equal(open.mock.callCount(), 2);
  assert.equal(useTerminalStore.getState().tabs.length, 2);
  assert.equal(useTerminalStore.getState().tabs.every(tab => tab.busy), true);
  for (const finish of finishes) finish();
  await Promise.all([first, second]);
  assert.equal(useTerminalStore.getState().tabs.length, 2);
  assert.equal(useTerminalStore.getState().tabs.every(tab => tab.status?.state === "connected" && !tab.busy), true);
});

test("focus commands reveal a collapsed panel and request focus without changing the console tab", async t => {
  reset(t);
  useAppStore.setState({ layout: { ...structuredClone(DEFAULT_LAYOUT), panelVisible: { ...DEFAULT_LAYOUT.panelVisible, console: false, editor: false },
    panelCollapsed: { ...DEFAULT_LAYOUT.panelCollapsed, console: true, editor: true } } });
  useTerminalStore.setState({ activeTab: "keep-this-terminal" });
  await executeAppCommand("toggleConsole");
  assert.equal(useAppStore.getState().layout.panelVisible.console, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.console, false);
  assert.equal(useTerminalStore.getState().activeTab, "keep-this-terminal");
  assert.equal(useCommandUiStore.getState().focus, "console");
  await executeAppCommand("focusEditor");
  assert.equal(useAppStore.getState().layout.panelVisible.editor, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.editor, false);
  assert.equal(useCommandUiStore.getState().focus, "editor");
});

test("console toggle expands hidden or collapsed panels without switching their tab or resetting the split", async t => {
  reset(t);
  for (const [visible, collapsed] of [[false, false], [false, true], [true, true]]) {
    const layout = structuredClone(DEFAULT_LAYOUT);
    layout.panelVisible.console = visible;
    layout.panelCollapsed.console = collapsed;
    layout.splits.center = 0.73;
    useAppStore.setState({ layout });
    useTerminalStore.setState({ activeTab: "keep-this-terminal" });
    await executeAppCommand("toggleConsole");
    const next = useAppStore.getState().layout;
    assert.equal(next.panelVisible.console, true);
    assert.equal(next.panelCollapsed.console, false);
    assert.equal(next.splits.center, 0.73);
    assert.equal(useTerminalStore.getState().activeTab, "keep-this-terminal");
    assert.equal(useCommandUiStore.getState().focus, "console");
  }
});

test("mouse layout controls can reveal the console without requesting editing focus", async t => {
  reset(t);
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.panelVisible.console = false;
  layout.panelCollapsed.console = true;
  useAppStore.setState({ layout });
  useTerminalStore.setState({ activeTab: "keep-this-terminal" });
  await executeAppCommand("toggleConsole", { area: "editor", preserveFocus: true });
  assert.equal(useAppStore.getState().layout.panelVisible.console, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.console, false);
  assert.equal(useTerminalStore.getState().activeTab, "keep-this-terminal");
  assert.equal(useCommandUiStore.getState().focus, null);
});

test("hiding the focused console restores the editor and preserves terminal sessions, running tasks and layout sizes", async t => {
  reset(t);
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.panelVisible.editor = false;
  layout.panelCollapsed.editor = true;
  layout.splits.center = 0.73;
  useAppStore.setState({ layout, runs: { running: run("running") }, activeRunId: "running" });
  useTerminalStore.setState({ tabs: [{ id: "terminal", deviceId: "default", deviceName: "default", sessionId: "live-session", busy: false }], activeTab: "terminal" });
  useCommandUiStore.setState({ focus: "console" });
  const before = useAppStore.getState(), terminals = useTerminalStore.getState();
  await executeAppCommand("toggleConsole", { area: "other", console: true, terminal: true });
  const after = useAppStore.getState();
  assert.equal(after.layout.panelVisible.console, false);
  assert.equal(after.layout.panelCollapsed.console, false);
  assert.equal(after.layout.panelVisible.editor, true);
  assert.equal(after.layout.panelCollapsed.editor, false);
  assert.equal(useCommandUiStore.getState().focus, "editor");
  assert.equal(after.layout.splits.center, 0.73);
  assert.equal(after.layout.sidebarWidth, before.layout.sidebarWidth);
  assert.equal(after.openTabs, before.openTabs);
  assert.equal(after.activeFile, before.activeFile);
  assert.equal(after.runs, before.runs);
  assert.equal(after.activeRunId, "running");
  assert.equal(useTerminalStore.getState(), terminals);
});

test("hiding the console without an editor reveals and focuses the workspace instead of opening an empty editor", async t => {
  reset(t);
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.sidebarVisible = false;
  layout.panelVisible.workspace = false;
  layout.panelCollapsed.workspace = true;
  useAppStore.setState({ layout, openTabs: [], activeFile: null });
  await executeAppCommand("toggleConsole", { area: "run", console: true });
  const after = useAppStore.getState();
  assert.equal(after.layout.panelVisible.console, false);
  assert.equal(after.layout.sidebarVisible, true);
  assert.equal(after.layout.panelVisible.workspace, true);
  assert.equal(after.layout.panelCollapsed.workspace, false);
  assert.equal(after.layout.panelVisible.editor, false);
  assert.equal(after.openTabs.length, 0);
  assert.equal(useCommandUiStore.getState().focus, "workspace");
});

test("hiding the console from outside it preserves focus and clears a pending console focus request", async t => {
  reset(t);
  for (const focus of [null, "editor", "console"] as const) {
    useAppStore.getState().setLayout({ panelVisible: { ...DEFAULT_LAYOUT.panelVisible, console: true } });
    useCommandUiStore.setState({ focus });
    await executeAppCommand("toggleConsole", { area: "editor" });
    assert.equal(useAppStore.getState().layout.panelVisible.console, false);
    assert.equal(useCommandUiStore.getState().focus, focus === "console" ? null : focus);
  }
});

test("console toggle ignores dialogs, form inputs, IME and key repeat", () => {
  const executed: string[] = [];
  const execute = (id: AppCommandId) => executed.push(id);
  for (const context of [{ area: "run", console: true, modal: true }, { area: "run", console: true, input: true }] as ShortcutContext[]) {
    assert.equal(handleAppShortcut(key("`", { ctrlKey: true }), context, execute, false), false);
  }
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { getModifierState: () => true }]) {
    assert.equal(handleAppShortcut(key("`", { ctrlKey: true, ...patch }), { area: "editor" }, execute, false), false);
  }
  const repeated = key("`", { ctrlKey: true, repeat: true });
  assert.equal(handleAppShortcut(repeated, { area: "other", console: true, terminal: true }, execute, false), true);
  assert.deepEqual(repeated.counts(), { prevented: 1, stopped: 1 });
  assert.deepEqual(executed, []);
});

test("shortcut overview includes all registered commands with translated labels and scope in both languages", async () => {
  for (const language of ["zh", "en"]) {
    await i18n.changeLanguage(language);
    const markup = renderToStaticMarkup(createElement(ShortcutsDialog));
    for (const id of Object.keys(APP_SHORTCUTS)) assert.ok(markup.includes(i18n.t(`shortcuts.${id}`)), id);
    assert.doesNotMatch(markup, />shortcuts\./);
    assert.ok(markup.includes("Ctrl+Tab"));
    assert.ok(markup.includes("Ctrl+Shift+C"));
  }
  await i18n.changeLanguage("zh");
});

test("shortcut overview describes the current terminal clipboard switches", async t => {
  // React's server renderer reads Zustand's initial snapshot rather than its live state.
  const initial = useTerminalStore.getInitialState();
  const original = { copyOnCtrlC: initial.copyOnCtrlC, pasteOnCtrlV: initial.pasteOnCtrlV };
  t.after(() => Object.assign(initial, original));
  for (const language of ["zh", "en"]) {
    await i18n.changeLanguage(language);
    for (const enabled of [true, false]) {
      Object.assign(initial, { copyOnCtrlC: enabled, pasteOnCtrlV: enabled });
      const markup = renderToStaticMarkup(createElement(ShortcutsDialog));
      assert.ok(markup.includes(i18n.t(enabled ? "shortcuts.copyOrInterrupt" : "shortcuts.interrupt")));
      assert.ok(markup.includes(i18n.t(enabled ? "shortcuts.paste" : "shortcuts.passThrough")));
      assert.ok(markup.includes(i18n.t("shortcuts.scope_terminal")));
      assert.ok(markup.includes("Ctrl+Shift+C / Ctrl+Shift+V"));
    }
  }
  await i18n.changeLanguage("zh");
});

test("history dialog replay tooltips do not advertise a shortcut blocked by the modal", () => {
  const record = run("legacy", "exited");
  assert.ok(renderToStaticMarkup(createElement(RunReplayButton, { run: record })).includes("Ctrl+F5"));
  assert.ok(!renderToStaticMarkup(createElement(RunReplayButton, { run: record, showShortcut: false })).includes("Ctrl+F5"));
});
