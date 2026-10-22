import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_SHORTCUTS, matchAppShortcut, shortcutLabel, type AppCommandId, type ShortcutContext } from "../src/shortcuts";
import { handleAppKeyDown, handleAppShortcut, shortcutContext } from "../src/appShortcuts";
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
import { handleRunConsoleKey } from "../src/runConsoleInput";
import { endConsoleTabCycle } from "../src/consoleTabs";
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
  t.after(() => {
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
  assert.equal(matchAppShortcut(key("²", { ctrlKey: true, code: "Backquote" }), false), "focusConsole");
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

test("terminal allowlist only dispatches the explicit focus and new-terminal combinations", () => {
  const executed: string[] = [];
  for (const event of [key("1", { ctrlKey: true }), key("`", { ctrlKey: true }), key("T", { ctrlKey: true, shiftKey: true })]) {
    assert.equal(handleAppShortcut(event, { area: "run", terminal: true }, id => executed.push(id), false), true);
    assert.deepEqual(event.counts(), { prevented: 1, stopped: 1 });
  }
  assert.deepEqual(executed, ["focusEditor", "focusConsole", "newTerminal"]);
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
  const terminal = context([".xterm", ".run-page", "form"]);
  assert.equal(terminal.terminal, true);
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
  for (const [selection, repeat] of [["", false], ["", true], ["text", false]] as const) {
    const event = key("c", { ctrlKey: true, repeat });
    assert.equal(handleAppShortcut(event, { area: "run", terminal: true }, () => assert.fail(), false), false);
    assert.equal(handleRunConsoleKey(event, selection, data => sent.push(data), text => copied.push(text)), false);
  }
  assert.deepEqual(sent, ["\x03"]); assert.deepEqual(copied, ["text"]);
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

test("new terminal follows the default device and honors serial, tab limit and shutdown guards", async t => {
  reset(t);
  const open = t.mock.method(useTerminalStore.getState(), "open", async () => {});
  await executeAppCommand("newTerminal");
  assert.deepEqual(open.mock.calls[0].arguments, ["default", "default"]);
  useAppStore.setState({ devices: [device("serial", true, "serial"), device("other")] });
  assert.equal(appCommandEnabled("newTerminal"), false);
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
  await executeAppCommand("focusConsole");
  assert.equal(useAppStore.getState().layout.panelVisible.console, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.console, false);
  assert.equal(useTerminalStore.getState().activeTab, "keep-this-terminal");
  assert.equal(useCommandUiStore.getState().focus, "console");
  await executeAppCommand("focusEditor");
  assert.equal(useAppStore.getState().layout.panelVisible.editor, true);
  assert.equal(useAppStore.getState().layout.panelCollapsed.editor, false);
  assert.equal(useCommandUiStore.getState().focus, "editor");
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

test("history dialog replay tooltips do not advertise a shortcut blocked by the modal", () => {
  const record = run("legacy", "exited");
  assert.ok(renderToStaticMarkup(createElement(RunReplayButton, { run: record })).includes("Ctrl+F5"));
  assert.ok(!renderToStaticMarkup(createElement(RunReplayButton, { run: record, showShortcut: false })).includes("Ctrl+F5"));
});
