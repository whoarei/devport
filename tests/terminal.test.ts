import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, deviceWorkspace, localWorkspace, type TerminalStatus, type WorkspaceRef } from "../src/api";
import { useTerminalStore, terminalActive } from "../src/terminalStore";
import { terminalInput, readTerminal } from "../src/terminalIO";
import { createTerminalReconnectKey } from "../src/terminalReconnect";
import { createTerminalDisplay, terminalSessionBoundary } from "../src/terminalDisplay";
import { loadTabCycleOrder, mruCycleOrder, nextMruId, nextSequentialId } from "../src/tabCycle";
import { cycleConsoleTab, endConsoleTabCycle, handleConsoleTabKeyDown, handleConsoleTabKeyUp } from "../src/consoleTabs";
import { terminalCloseTargets } from "../src/terminalTabActions";
import { terminalTabLabel } from "../src/terminalTitle";
import { compactDeviceName, deviceDisplayNames, workspacePresentation } from "../src/workspacePresentation";
import { tabNavigationTarget, revealActiveTab } from "../src/tabStrip";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });

const status = (id: string, state: TerminalStatus["state"] = "connected"): TerminalStatus =>
  ({ session_id: id, device_name: id, state, exit_code: null, error: null });
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
test("device labels disambiguate WSL users and duplicate custom names", () => {
  const names = deviceDisplayNames([
    { id: "a", name: "wsl-root@Ubuntu", transport: "wsl" },
    { id: "b", name: "wsl-dev@Ubuntu", transport: "wsl" },
    { id: "c", name: "Host", transport: "ssh" },
    { id: "d", name: "Host", transport: "ssh" },
    { id: "e", name: "Host · 2", transport: "ssh" },
  ]);
  assert.equal(names.get("a"), "wsl-root@Ubuntu");
  assert.equal(names.get("b"), "wsl-dev@Ubuntu");
  assert.equal(names.get("d"), "Host · 3");
  assert.equal(new Set(names.values()).size, 5);
});

test("tab keyboard navigation wraps, supports endpoints, and ignores unrelated keys", () => {
  assert.equal(tabNavigationTarget(["a", "b", "c"], "c", "ArrowRight"), "a");
  assert.equal(tabNavigationTarget(["a", "b", "c"], "a", "ArrowLeft"), "c");
  assert.equal(tabNavigationTarget(["a", "b"], "b", "Home"), "a");
  assert.equal(tabNavigationTarget(["a", "b"], "a", "End"), "b");
  assert.equal(tabNavigationTarget([], "a", "Home"), undefined);
  assert.equal(tabNavigationTarget(["a"], "a", "Tab"), undefined);
});

test("active tabs reveal horizontally in CSS zoom coordinates with minimal movement", () => {
  const strip = { clientWidth: 200, offsetWidth: 200, clientLeft: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 100, width: 300 }) } as unknown as HTMLElement;
  const tab = (left: number, right: number) => ({ getBoundingClientRect: () => ({ left, right, width: right - left }) }) as HTMLElement;
  revealActiveTab(strip, tab(320, 430)); assert.equal(strip.scrollLeft, 20);
  revealActiveTab(strip, tab(90, 150)); assert.ok(Math.abs(strip.scrollLeft - 13.3333333333) < 1e-8);
  const current = strip.scrollLeft;
  revealActiveTab(strip, tab(150, 250)); assert.equal(strip.scrollLeft, current);
});
function reset(t: test.TestContext) {
  endConsoleTabCycle();
  const before = useTerminalStore.getState();
  useTerminalStore.setState({ tabs: [], activeTab: "run", shuttingDown: false, mru: ["run"] });
  t.after(() => { endConsoleTabCycle(); useTerminalStore.setState(before); });
  return useTerminalStore.getState();
}

test("terminal labels compact Windows programs and Linux locations without guessing custom titles", () => {
  const cases: [string | undefined, string][] = [
    [String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, "pwsh"],
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', "pwsh"],
    ["C:/Windows/System32/CMD.EXE", "CMD"],
    [String.raw`\\server\tools\powershell.exe`, "powershell"],
    ["/usr/bin/bash", "bash"],
    ["/bin/zsh", "zsh"],
    ["mmeng@xuess-msi:/usr/share/applications", "xuess-msi · applications"],
    ["mmeng@xuess-msi:~/projects/remote runner/", "xuess-msi · remote runner"],
    ["mmeng@xuess-msi:~", "xuess-msi · ~"],
    ["mmeng@xuess-msi:~/", "xuess-msi · ~"],
    ["root@host:/", "host · /"],
    ["user@[fd00::1]:/opt/app/", "[fd00::1] · app"],
    ["编译日志", "编译日志"],
    ["vim /tmp/main.py", "vim /tmp/main.py"],
    ["Build / Deploy", "Build / Deploy"],
    ["/usr/bin/bash /usr/bin/zsh", "/usr/bin/bash /usr/bin/zsh"],
    ["user@host:building", "user@host:building"],
    [String.raw`C:\tools\pwsh.exe -NoLogo`, String.raw`C:\tools\pwsh.exe -NoLogo`],
    [String.raw`C:\tools\pwsh.exe -File build.exe`, String.raw`C:\tools\pwsh.exe -File build.exe`],
    [String.raw`C:\tools\pwsh.exe -File C:\build.exe`, String.raw`C:\tools\pwsh.exe -File C:\build.exe`],
    [String.raw`C:\tools\.exe`, String.raw`C:\tools\.exe`],
    ["  htop  ", "htop"],
    [undefined, "本机"], ["", "本机"], ["  ", "本机"],
  ];
  for (const [title, expected] of cases) {
    assert.equal(terminalTabLabel({ title, deviceName: "本机" }), expected, title);
  }
});

test("SSH and WSL labels retain the configured device identity and do not repeat identical titles", () => {
  const tab = { deviceName: "原设备名", title: "mmeng@xuess-msi:/usr/share/applications" };
  assert.equal(terminalTabLabel(tab, { name: "开发机", transport: "ssh" }), "开发机 · applications");
  assert.equal(terminalTabLabel(tab, { name: "Ubuntu", transport: "wsl" }), "Ubuntu · applications");
  assert.equal(terminalTabLabel({ ...tab, title: "htop" }, { name: "Ubuntu", transport: "wsl" }), "Ubuntu · htop");
  assert.equal(terminalTabLabel({ ...tab, title: "Ubuntu" }, { name: "Ubuntu", transport: "wsl" }), "Ubuntu");
  assert.equal(terminalTabLabel({ ...tab, title: undefined }, { name: "新设备名", transport: "ssh" }), "新设备名");
  assert.equal(terminalTabLabel({ ...tab, title: String.raw`C:\tools\pwsh.exe` }, { name: "Windows", transport: "ssh" }), "Windows · pwsh");
});

test("generated device names compact without changing custom names or source paths", () => {
  const device = { id: "ubuntu", name: "wsl-dev@Ubuntu-24.04", transport: "wsl" as const };
  assert.equal(terminalTabLabel({ deviceName: device.name, title: "dev@workstation:~/project/tools" }, device), "Ubuntu-24.04 · tools");
  assert.equal(terminalTabLabel({ deviceName: device.name, title: device.name }, device), "Ubuntu-24.04");
  assert.equal(compactDeviceName("ssh-dev@[fd00::1]", "ssh"), "dev@[fd00::1]");
  assert.equal(compactDeviceName("ssh-lab", "ssh"), "ssh-lab");
  assert.equal(compactDeviceName("我的开发环境", "wsl"), "我的开发环境");
  assert.deepEqual(workspacePresentation({ type: "device", device_id: "ubuntu", path: "/home/dev/project/" }, [device]),
    { name: "project", path: "/home/dev/project/", device: "Ubuntu-24.04", transport: "wsl" });
  assert.equal(workspacePresentation({ type: "local", dir: "C:\\" }, []).name, "C:\\");
  assert.equal(workspacePresentation({ type: "local", dir: "/" }, []).name, "/");
});

test("compacting a terminal label keeps the full original title available for hover and rejects stale sessions", async (t) => {
  const s = reset(t);
  t.mock.method(api, "openTerminal", async (id) => status(id));
  t.mock.method(api, "closeTerminal", async () => {});
  await s.open("local", "本机");
  const tab = useTerminalStore.getState().tabs[0];
  const raw = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
  s.setTitle(tab.id, "local", raw);
  const titled = useTerminalStore.getState().tabs[0];
  assert.equal(terminalTabLabel(titled), "pwsh");
  assert.equal(titled.title, raw);
  assert.ok(i18n.t("console.terminalTitle", { name: titled.title, device: titled.deviceName, index: 1 }).includes(raw));
  s.setTitle(tab.id, "stale-session", "old shell");
  assert.equal(useTerminalStore.getState().tabs[0].title, raw);
  s.setTitle(tab.id, "local", "   ");
  assert.equal(terminalTabLabel(useTerminalStore.getState().tabs[0]), "本机");
  s.update(tab.id, "local", status("local", "exited"));
  s.setTitle(tab.id, "local", raw);
  await s.reconnect(tab.id);
  assert.equal(useTerminalStore.getState().tabs[0].title, undefined);
});

test("terminal page does not restore the duplicate status and close toolbar", () => {
  const component = readFileSync(resolve("src/components/TerminalPage.tsx"), "utf8");
  const styles = readFileSync(resolve("src/styles.css"), "utf8");
  assert.doesNotMatch(component, /terminal-toolbar|t\("terminal\.close"\)/);
  assert.doesNotMatch(styles, /\.terminal-toolbar\b/);
});

test("terminal quick-add targets the default device and keeps a separate device picker", () => {
  const component = readFileSync(resolve("src/components/ConsolePanel.tsx"), "utf8");
  assert.match(component, /defaultDevice = devices\.find\(\(device\) => device\.is_default\)/);
  assert.match(component, /onClick=\{\(\) => void executeAppCommand\("newTerminal"\)\}/);
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

const enterKey = { type: "keydown", key: "Enter", repeat: false, isComposing: false, keyCode: 13,
  ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} };

test("Enter reconnects once and consumes the entire press even when the new session connects immediately", () => {
  let disconnected = true, calls = 0, prevented = 0;
  const key = { ...enterKey, preventDefault() { prevented++; } };
  const handle = createTerminalReconnectKey(() => disconnected, () => { calls++; disconnected = false; });
  assert.equal(handle(key), false);
  assert.equal(handle({ ...key, type: "keypress" }), false);
  assert.equal(handle({ ...key, repeat: true }), false);
  assert.equal(handle({ ...key, type: "keyup" }), false);
  assert.equal(calls, 1);
  assert.equal(prevented, 4);
  assert.equal(handle(key), true, "a fresh Enter in the connected shell remains normal input");
  disconnected = true;
  assert.equal(handle(key), false);
  assert.equal(calls, 2);
});

test("reconnect ignores IME confirmation, modifiers, repeats and non-keydown Enter; a failed attempt can retry", () => {
  let calls = 0, allowed = true;
  const handle = createTerminalReconnectKey(() => allowed, () => { calls++; });
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true },
    { shiftKey: true }, { altKey: true }, { metaKey: true }, { type: "keypress" }, { type: "keyup" }, { key: "x" }]) {
    assert.equal(handle({ ...enterKey, ...extra }), true);
  }
  assert.equal(calls, 0);
  allowed = false;
  assert.equal(handle(enterKey), true, "connecting, closing, hidden or update-blocked tabs cannot reconnect");
  allowed = true;
  assert.equal(handle(enterKey), false);
  assert.equal(handle({ ...enterKey, type: "keyup" }), false);
  assert.equal(handle(enterKey), false);
  assert.equal(calls, 2);
});

test("reconnect is single-flight through close and open; failed opens remain retryable on the same tab", async t => {
  const s = reset(t);
  useTerminalStore.setState({ tabs: [{ id: "tab", deviceId: "device", deviceName: "A", busy: false, status: status("old", "failed") }] });
  let finishClose!: () => void;
  const close = t.mock.method(api, "closeTerminal", () => new Promise<void>(resolve => { finishClose = resolve; }));
  const open = t.mock.method(api, "openTerminal", async () => { throw new Error("Connection refused"); });
  const pending = s.reconnect("tab");
  await s.reconnect("tab");
  assert.equal(close.mock.callCount(), 1);
  assert.equal(open.mock.callCount(), 0);
  finishClose();
  await pending;
  assert.equal(useTerminalStore.getState().tabs[0].error, "Connection refused");
  assert.equal(useTerminalStore.getState().tabs[0].busy, false);
  assert.equal(useTerminalStore.getState().tabs[0].status, undefined);
  open.mock.mockImplementation(async device => { assert.equal(device, "device"); return status("new"); });
  await s.reconnect("tab");
  assert.equal(close.mock.callCount(), 1);
  assert.equal(useTerminalStore.getState().tabs[0].id, "tab");
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "new");
});

test("persistent display serializes old output, session boundary and new output and attributes late OSC titles correctly", async t => {
  const s = reset(t);
  useTerminalStore.setState({ tabs: [{ id: "tab", deviceId: "a", deviceName: "A", busy: false, status: status("new") }] });
  const writes: Array<string | Uint8Array> = [];
  const callbacks: Array<() => void> = [];
  const display = createTerminalDisplay({ write(data, done) { writes.push(data); callbacks.push(done); } });
  const old = display.write("old output", "old");
  const boundary = terminalSessionBoundary(24, "新会话");
  const separator = display.write(boundary);
  const fresh = display.write("new output", "new");
  assert.deepEqual(writes, ["old output"]);
  s.setTitle("tab", display.sessionId!, "stale title");
  assert.equal(useTerminalStore.getState().tabs[0].title, undefined);
  callbacks.shift()!();
  assert.equal(display.sessionId, undefined, "local separators cannot update session titles or send replies");
  callbacks.shift()!();
  assert.equal(display.sessionId, "new");
  s.setTitle("tab", display.sessionId!, "new title");
  callbacks.shift()!();
  await Promise.all([old, separator, fresh]);
  assert.deepEqual(writes, ["old output", boundary, "new output"]);
  assert.equal(useTerminalStore.getState().tabs[0].title, "new title");
  assert.equal(display.writing, false);
  display.dispose();
});

test("closing a display settles pending writes and never writes queued output into a disposed terminal", async () => {
  const writes: string[] = [];
  let finish!: () => void;
  const display = createTerminalDisplay({ write(data, done) { writes.push(String(data)); finish = done; } });
  const active = display.write("active", "old");
  const queued = display.write("queued", "new");
  display.dispose();
  finish();
  await Promise.all([active, queued, display.write("late", "new")]);
  assert.deepEqual(writes, ["active"]);
});

test("a real xterm keeps the old viewport and separator after the new shell clears its screen and resets input modes", async t => {
  // xterm's browser bundle can parse output without opening a DOM renderer.
  const before = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
  const { Terminal } = await import("@xterm/xterm");
  const term = new Terminal({ cols: 60, rows: 4, scrollback: 100 });
  const display = createTerminalDisplay(term);
  t.after(() => {
    display.dispose(); term.dispose();
    if (before) Object.defineProperty(globalThis, "self", before);
    else Reflect.deleteProperty(globalThis, "self");
  });
  await display.write("old output\r\nlast output\x1b[?1h\x1b[?2004h\x1b]0;unfinished title", "old");
  assert.equal(term.modes.applicationCursorKeysMode, true);
  assert.equal(term.modes.bracketedPasteMode, true);
  await display.write(terminalSessionBoundary(term.rows, "New session"));
  await display.write("\x1b[2J\x1b[Hnew shell ready", "new");
  const lines = Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)!.translateToString(true));
  assert.ok(lines.includes("old output"));
  assert.ok(lines.includes("last output"));
  assert.ok(lines.includes("── New session ──"));
  assert.ok(lines.includes("new shell ready"));
  assert.equal(term.modes.applicationCursorKeysMode, false);
  assert.equal(term.modes.bracketedPasteMode, false);
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
