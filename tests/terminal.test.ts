import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, deviceWorkspace, localWorkspace, type TerminalStatus, type WorkspaceRef } from "../src/api";
import { useTerminalStore, terminalActive } from "../src/terminalStore";
import { terminalInput, readTerminal } from "../src/terminalIO";
import { loadTabCycleOrder, mruCycleOrder, nextMruId, nextSequentialId } from "../src/tabCycle";
import { cycleConsoleTab, endConsoleTabCycle, handleConsoleTabKeyDown, handleConsoleTabKeyUp } from "../src/consoleTabs";
import { terminalCloseTargets } from "../src/terminalTabActions";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });

const status = (id: string, state: TerminalStatus["state"] = "connected"): TerminalStatus =>
  ({ session_id: id, device_name: id, state, exit_code: null, error: null });
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
function reset(t: test.TestContext) {
  endConsoleTabCycle();
  const before = useTerminalStore.getState();
  useTerminalStore.setState({ tabs: [], activeTab: "run", shuttingDown: false, mru: ["run"] });
  t.after(() => { endConsoleTabCycle(); useTerminalStore.setState(before); });
  return useTerminalStore.getState();
}

test("terminal page does not restore the duplicate status and close toolbar", () => {
  const component = readFileSync(resolve("src/components/TerminalPage.tsx"), "utf8");
  const styles = readFileSync(resolve("src/styles.css"), "utf8");
  assert.doesNotMatch(component, /terminal-toolbar|t\("terminal\.close"\)/);
  assert.doesNotMatch(styles, /\.terminal-toolbar\b/);
});

test("terminal quick-add targets the default device and keeps a separate device picker", () => {
  const component = readFileSync(resolve("src/components/ConsolePanel.tsx"), "utf8");
  assert.match(component, /defaultDevice = devices\.find\(\(device\) => device\.is_default\)/);
  assert.match(component, /onClick=\{\(\) => defaultDevice && open\(defaultDevice\.id\)\}>＋<\/button>/);
  assert.match(component, /className="terminal-device-picker"/);
  assert.match(component, /aria-label=\{t\("console\.chooseTerminalDevice"\)\}/);
});

test("context submenus escape the scrollable context menu via fixed positioning", () => {
  // .context-menu 的 overflow-y: auto 会把 absolute 子菜单裁掉（工作区「在终端中打开」），
  // 子菜单必须改 fixed 定位并压过父菜单层级
  const component = readFileSync(resolve("src/components/ContextMenu.tsx"), "utf8");
  const styles = readFileSync(resolve("src/styles.css"), "utf8");
  assert.match(styles, /\.context-menu\s*\{[^}]*overflow-y: auto/);
  assert.match(styles, /\.context-submenu\s*\{[^}]*position: fixed/);
  assert.match(component, /menu-subdropdown context-submenu/);
});

test("terminals are independent from runs and do not save or upload the workspace", async (t) => {
  const s = reset(t);
  const runState = useAppStore.getState();
  t.mock.method(api, "openTerminal", async (id) => status(id));
  const save = t.mock.method(api, "writeWorkspaceFile", async () => { throw new Error("must not save"); });
  const run = t.mock.method(api, "runScript", async () => { throw new Error("must not run"); });
  await Promise.all([s.open("a", "Ubuntu"), s.open("b", "Board")]);
  const [a, b] = useTerminalStore.getState().tabs;
  s.select(a.id);
  assert.equal(useTerminalStore.getState().activeTab, a.id);
  assert.equal(b.status?.session_id, "b");
  assert.equal(save.mock.callCount(), 0);
  assert.equal(run.mock.callCount(), 0);
  assert.equal(useAppStore.getState(), runState);
  s.update(a.id, "b", status("b", "failed"));
  assert.equal(useTerminalStore.getState().tabs[0].status?.state, "connected");
});

test("reconnect retires the old session before opening another; stale events cannot change it", async (t) => {
  const s = reset(t);
  const calls: string[] = [];
  t.mock.method(api, "openTerminal", async () => { calls.push("open"); return status(`s${calls.length}`, "exited"); });
  t.mock.method(api, "closeTerminal", async (id) => { calls.push(`close:${id}`); });
  await s.open("a", "A");
  const tab = useTerminalStore.getState().tabs[0];
  await s.reconnect(tab.id);
  assert.deepEqual(calls, ["open", "close:s1", "open"]);
  s.update(tab.id, "s1", status("s1", "failed"));
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "s3");
  await s.close(tab.id);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.equal(useTerminalStore.getState().tabs.length, 0);
});

test("workspace terminals open with the workspace cwd and reconnect replays it", async (t) => {
  const s = reset(t);
  const calls: Array<{ id: string; workspace: WorkspaceRef; subdir: string }> = [];
  // 以 exited 状态打开：reconnect 对活跃会话是 no-op，只有非活跃会话才会重开
  t.mock.method(api, "openWorkspaceTerminal", async (id: string, workspace: WorkspaceRef, subdir: string) => {
    calls.push({ id, workspace, subdir });
    return status(`ws${calls.length}`, "exited");
  });
  t.mock.method(api, "openTerminal", async () => { throw new Error("must use the workspace entry"); });
  t.mock.method(api, "closeTerminal", async () => {});
  // 本机工作区与设备工作区都走同一个入口：来源原样透传，重连时原样复放
  for (const workspace of [localWorkspace("/work"), deviceWorkspace("board", "/srv/app")]) {
    await s.open("local", "本机", { workspace, subdir: "sub/inner" });
    const tab = useTerminalStore.getState().tabs.at(-1)!;
    assert.deepEqual(tab.workspace, { workspace, subdir: "sub/inner" });
    await s.reconnect(tab.id);
  }
  assert.deepEqual(calls, [
    { id: "local", workspace: localWorkspace("/work"), subdir: "sub/inner" },
    { id: "local", workspace: localWorkspace("/work"), subdir: "sub/inner" },
    { id: "local", workspace: deviceWorkspace("board", "/srv/app"), subdir: "sub/inner" },
    { id: "local", workspace: deviceWorkspace("board", "/srv/app"), subdir: "sub/inner" },
  ]);
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "ws2");
});

test("workspace terminal IPC payload carries the workspace source, not an undefined key", async (t) => {
  const s = reset(t);
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return status("ws1"); },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await s.open("board", "板子", { workspace: deviceWorkspace("board", "/srv/app"), subdir: "sub/inner" });
  assert.deepEqual(calls.map((call) => call.command), ["open_workspace_terminal"]);
  // workspace 必须是对象：值缺失会被 JSON 丢掉这个键，后端只能回 “missing required key workspace”
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), {
    deviceId: "board",
    workspace: { type: "device", device_id: "board", path: "/srv/app" },
    subdir: "sub/inner",
    cols: 80,
    rows: 24,
  });
});

test("failed close preserves the tab; simultaneous opens reserve the session limit", async (t) => {
  const s = reset(t);
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeTerminal", async () => { throw new Error("cleanup pending"); });
  await Promise.all(Array.from({ length: 8 }, (_, i) => s.open(String(i), "A")));
  await assert.rejects(s.open("9", "B"), /8/);
  const tab = useTerminalStore.getState().tabs[0];
  await s.close(tab.id);
  assert.equal(useTerminalStore.getState().tabs.length, 8);
  assert.match(useTerminalStore.getState().tabs[0].error!, /cleanup pending/);
  assert.equal(terminalActive(useTerminalStore.getState().tabs[0]), true);
});

test("application shutdown waits for in-flight opens and refuses additional terminals", async (t) => {
  const s = reset(t);
  let resolve!: (value: TerminalStatus) => void;
  t.mock.method(api, "openTerminal", () => new Promise<TerminalStatus>((r) => { resolve = r; }));
  const close = t.mock.method(api, "closeAllTerminals", async () => {});
  const opening = s.open("a", "A");
  const closing = s.closeAll();
  await assert.rejects(s.open("b", "B"), /关闭/);
  assert.equal(close.mock.callCount(), 0);
  resolve(status("a"));
  await Promise.all([opening, closing]);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(useTerminalStore.getState().tabs.length, 0);
});

test("update confirmation and installation prevent terminal opens and reconnects", async (t) => {
  const s = reset(t), app = useAppStore.getState();
  t.after(() => useAppStore.setState(app));
  const open = t.mock.method(api, "openTerminal", async () => status("new"));
  useTerminalStore.setState({ tabs: [{ id: "old", deviceId: "a", deviceName: "A", busy: false, status: status("old", "exited") }] });
  useAppStore.setState({ updating: true });
  await assert.rejects(s.open("a", "A"), /升级/);
  await s.reconnect("old");
  assert.equal(open.mock.callCount(), 0);
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "old");
});

test("input keeps Ctrl+C as data, serializes Unicode paste and rejects excessive pending input", async () => {
  const sent: string[] = [];
  const errors: unknown[] = [];
  let finish!: () => void;
  const input = terminalInput(async (chunk) => { sent.push(chunk); if (sent.length === 1) await new Promise<void>((r) => { finish = r; }); }, (e) => errors.push(e));
  const text = "a".repeat(4095) + "😀" + "中".repeat(5000);
  input.send(text);
  input.send("\x03");
  assert.equal(sent.length, 1);
  input.send("z".repeat(65536));
  assert.equal(errors.length, 1);
  finish();
  await delay();
  assert.equal(sent.join(""), text + "\x03");
  for (const chunk of sent) {
    assert.ok(new TextEncoder().encode(chunk).length <= 16384);
    assert.equal(chunk.includes("\ufffd"), false);
    assert.equal(Buffer.from(chunk).toString(), chunk);
  }
  input.dispose(); input.send("must not send");
  assert.equal(sent.join(""), text + "\x03");
});

test("terminal polling waits for parsing and drains final output without replay/reset", async () => {
  let reads = 0;
  let finish!: () => void;
  const writes: number[][] = [];
  const states: string[] = [];
  const errors: unknown[] = [];
  const stop = readTerminal(async () => ({ status: status("a", "exited"), data: ++reads <= 2 ? Buffer.from([255, 0, 27, 13, 10]).toString("base64") : "" }),
    async (bytes) => { writes.push([...bytes]); if (writes.length === 1) await new Promise<void>((r) => { finish = r; }); },
    (read) => states.push(read.status.state), (e) => errors.push(e));
  await delay(20);
  assert.equal(reads, 1);
  finish();
  await delay(40);
  stop();
  assert.equal(reads, 3);
  assert.deepEqual(writes, [[255, 0, 27, 13, 10], [255, 0, 27, 13, 10]]);
  assert.deepEqual(states, ["exited", "exited", "exited"]);
  assert.deepEqual(errors, []);
});

test("StrictMode setup/cleanup does not consume native terminal output", async () => {
  let calls = 0;
  const stop = readTerminal(async () => { calls++; return { status: status("a"), data: "" }; }, async () => {}, () => {}, () => {});
  stop(); await delay(); assert.equal(calls, 0);
});

test("tab cycle order preference falls back to sequential on missing or invalid storage", () => {
  assert.equal(loadTabCycleOrder(), "sequential");
});

test("sequential cycling wraps in both directions and falls back for unknown tabs", () => {
  const ids = ["run", "a", "b"];
  assert.equal(nextSequentialId(ids, "run", false), "a");
  assert.equal(nextSequentialId(ids, "b", false), "run");
  assert.equal(nextSequentialId(ids, "run", true), "b");
  assert.equal(nextSequentialId(ids, "a", true), "run");
  assert.equal(nextSequentialId(ids, "missing", false), "run");
  assert.equal(nextSequentialId([], "run", false), "run");
});

test("mru cycling builds a stable complete snapshot and moves in both directions", () => {
  assert.deepEqual(mruCycleOrder(["run", "A", "B", "C"], ["A", "B"], "B"), ["B", "A", "run", "C"]);
  const mru = ["A", "B", "C"];
  assert.equal(nextMruId(mru, "A", false), "B");
  assert.equal(nextMruId(mru, "C", false), "A");
  assert.equal(nextMruId(mru, "A", true), "C");
  assert.equal(nextMruId(mru, "B", true), "A");
  assert.equal(nextMruId(["A", "B"], "X", false), "A");
  assert.equal(nextMruId([], "X", true), "X");
});

test("closing the active terminal selects its right neighbor, then left, then Run", async (t) => {
  const s = reset(t);
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeTerminal", async () => {});
  await s.open("a", "A");
  await s.open("b", "B");
  await s.open("c", "C");
  const [ta, tb, tc] = useTerminalStore.getState().tabs;
  s.select(tb.id);
  await useTerminalStore.getState().close(tb.id);
  assert.equal(useTerminalStore.getState().activeTab, tc.id);
  await useTerminalStore.getState().close(tc.id);
  assert.equal(useTerminalStore.getState().activeTab, ta.id);
  await useTerminalStore.getState().close(ta.id);
  assert.equal(useTerminalStore.getState().activeTab, "run");
});

test("tab context-menu close scopes preserve visual order", () => {
  const tabs = ["a", "b", "c"].map((id) => ({ id, deviceId: id, deviceName: id, busy: false }));
  assert.deepEqual(terminalCloseTargets(tabs, "b", "current"), ["b"]);
  assert.deepEqual(terminalCloseTargets(tabs, "b", "others"), ["a", "c"]);
  assert.deepEqual(terminalCloseTargets(tabs, "b", "right"), ["c"]);
  assert.deepEqual(terminalCloseTargets(tabs, "b", "all"), ["a", "b", "c"]);
  assert.deepEqual(terminalCloseTargets(tabs, "missing", "all"), []);
});

test("mru stack tracks selection, opens, closes and shutdown", async (t) => {
  const s = reset(t);
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeTerminal", async () => {});
  t.mock.method(api, "closeAllTerminals", async () => {});
  await s.open("a", "A");
  await s.open("b", "B");
  const [ta, tb] = useTerminalStore.getState().tabs;
  assert.deepEqual(useTerminalStore.getState().mru, [tb.id, ta.id, "run"]);
  s.select(ta.id);
  assert.deepEqual(useTerminalStore.getState().mru, [ta.id, tb.id, "run"]);
  // 关闭活动标签：优先选中右侧相邻标签，并同步 MRU。
  await useTerminalStore.getState().close(ta.id);
  const after = useTerminalStore.getState();
  assert.equal(after.activeTab, tb.id);
  assert.deepEqual(after.mru, [tb.id, "run"]);
  await useTerminalStore.getState().close(tb.id);
  assert.deepEqual(useTerminalStore.getState().mru, ["run"]);
  await s.open("c", "C");
  await useTerminalStore.getState().closeAll();
  assert.deepEqual(useTerminalStore.getState().mru, ["run"]);
});

test("Ctrl+Tab cycles run console and terminals sequentially in both directions", async (t) => {
  const s = reset(t);
  s.setTabCycleOrder("sequential");
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeAllTerminals", async () => {});
  await s.open("a", "A");
  await s.open("b", "B");
  const [ta, tb] = useTerminalStore.getState().tabs;
  s.select("run");
  cycleConsoleTab(false);
  assert.equal(useTerminalStore.getState().activeTab, ta.id);
  cycleConsoleTab(false);
  assert.equal(useTerminalStore.getState().activeTab, tb.id);
  cycleConsoleTab(false);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  cycleConsoleTab(true);
  assert.equal(useTerminalStore.getState().activeTab, tb.id);
  // 无终端标签时 no-op
  await useTerminalStore.getState().closeAll();
  cycleConsoleTab(false);
  cycleConsoleTab(true);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  s.setTabCycleOrder("sequential");
});

test("Ctrl+Tab in mru mode traverses a stable snapshot and commits only on Ctrl release", async (t) => {
  const s = reset(t);
  s.setTabCycleOrder("mru");
  t.mock.method(api, "openTerminal", async (id) => status(id));
  await s.open("a", "A");
  await s.open("b", "B");
  const [ta, tb] = useTerminalStore.getState().tabs;
  const originalMru = [tb.id, ta.id, "run"];
  assert.deepEqual(useTerminalStore.getState().mru, originalMru);
  // Ctrl 按住期间按冻结顺序 tb -> ta -> run，再反向回到 ta；预览不污染 MRU。
  cycleConsoleTab(false);
  assert.equal(useTerminalStore.getState().activeTab, ta.id);
  assert.deepEqual(useTerminalStore.getState().mru, originalMru);
  cycleConsoleTab(false);
  assert.equal(useTerminalStore.getState().activeTab, "run");
  assert.deepEqual(useTerminalStore.getState().mru, originalMru);
  cycleConsoleTab(true);
  assert.equal(useTerminalStore.getState().activeTab, ta.id);
  endConsoleTabCycle();
  assert.deepEqual(useTerminalStore.getState().mru, [ta.id, tb.id, "run"]);
  s.setTabCycleOrder("sequential");
});

test("the capture key handler consumes one Ctrl+Tab exactly once and commits on keyup", async (t) => {
  const s = reset(t);
  s.setTabCycleOrder("mru");
  t.mock.method(api, "openTerminal", async (id) => status(id));
  await s.open("a", "A");
  s.select("run");
  const tab = useTerminalStore.getState().tabs[0];
  let prevented = 0;
  let stopped = 0;
  const event = {
    ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: "Tab",
    preventDefault: () => { prevented++; },
    stopPropagation: () => { stopped++; },
  } as unknown as KeyboardEvent;
  assert.equal(handleConsoleTabKeyDown(event), true);
  assert.equal(useTerminalStore.getState().activeTab, tab.id);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(handleConsoleTabKeyUp({ key: "Control" } as KeyboardEvent), true);
  assert.deepEqual(useTerminalStore.getState().mru, [tab.id, "run"]);
  assert.equal(handleConsoleTabKeyUp({ key: "Tab" } as KeyboardEvent), false);
  assert.equal(handleConsoleTabKeyDown({ ...event, ctrlKey: false } as KeyboardEvent), false);
  s.setTabCycleOrder("sequential");
});
