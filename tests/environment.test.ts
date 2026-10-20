import test from "node:test";
import assert from "node:assert/strict";
import { api, localWorkspace, type WorkspaceRef } from "../src/api";
import { useAppStore } from "../src/store";
import { useTerminalStore } from "../src/terminalStore";
import { useTransferStore } from "../src/transferStore";
import { createEnvironmentController } from "../src/workEnvironment";
import { captureWorkspace, emptyEnvironment, restoredTab, type WorkEnvironment } from "../src/environmentState";
import { fitWindow } from "../src/windowState";
import i18n from "../src/i18n";

test.before(async () => { await i18n.changeLanguage("zh"); });
const workspace = localWorkspace("/work");
const document = (content = "base", revision = "v1") => ({ content, revision, eol: "lf" as const, bom: false });
function snapshot(): WorkEnvironment {
  return { ...emptyEnvironment(), current: workspace, workspaces: [{ workspace, active_file: "src/main.py", expanded: ["src"], tree_scroll: 72,
    files: [{ name: "src/main.py", language: "python", view: { anchor: 3, head: 5, scroll_top: 200, scroll_left: 24 },
      draft: { content: "edited", saved_content: "base", revision: "v1", eol: "lf", bom: false } },
      { name: "other.sh", language: "text" }] }],
    terminals: [{ id: "terminal-old", device_id: "device", workspace: { workspace, subdir: "src" } }], active_terminal: "terminal-old",
    transfer: { device_id: "device", hidden: true, exclude: true } };
}
function reset(t: test.TestContext) {
  const app = useAppStore.getState(), terminals = useTerminalStore.getState(), transfer = useTransferStore.getState();
  const controllers: ReturnType<typeof createEnvironmentController>[] = [];
  useAppStore.setState({ workspace: null, openTabs: [], activeFile: null, workspaceTree: {}, workspaceScroll: 0,
    loading: false, saving: false, starting: false, guarding: false, changePrompt: null,
    environmentError: null, editorError: null, workspaceError: null, devices: [], runs: {}, outputBuffers: {}, activeRunId: null });
  useTerminalStore.setState({ tabs: [], activeTab: "run", mru: ["run"], shuttingDown: false });
  useTransferStore.setState({ options: { device_id: null, hidden: false, exclude: false } });
  t.mock.method(console, "warn", () => {});
  t.mock.method(api, "listWorkspaceDir", async () => []);
  t.mock.method(api, "readWorkspaceFile", async () => document());
  t.after(() => { controllers.forEach((c) => c.stop()); useAppStore.setState(app, true); useTerminalStore.setState(terminals, true); useTransferStore.setState(transfer, true); });
  let saved: WorkEnvironment | null = null;
  const controller = (state: WorkEnvironment | null) => {
    const c = createEnvironmentController({ read: async () => structuredClone(state), write: async (value) => { saved = structuredClone(value); } });
    controllers.push(c);
    return c;
  };
  return { controller, saved: () => saved! };
}

test("restart restores descriptors, drafts, editor positions, tree and transfer options without running or connecting", async (t) => {
  const env = reset(t), reads: string[] = [], directories: string[] = [];
  t.mock.method(api, "readWorkspaceFile", async (_w: WorkspaceRef, name: string) => { reads.push(name); return document(); });
  t.mock.method(api, "listWorkspaceDir", async (_w: WorkspaceRef, name: string) => { directories.push(name); return name ? [] : [{ name: "src", is_dir: true }]; });
  t.mock.method(api, "openTerminal", async () => { assert.fail("no automatic connection"); });
  t.mock.method(api, "openWorkspaceTerminal", async () => { assert.fail("no automatic connection"); });
  t.mock.method(api, "runWorkspace", async () => { assert.fail("no automatic execution"); });
  useAppStore.setState({ activeRunId: "current-run" });
  const c = env.controller(snapshot());
  await c.start();
  const state = useAppStore.getState();
  assert.deepEqual(state.workspace, workspace);
  assert.equal(state.activeRunId, "current-run");
  assert.deepEqual(state.openTabs.map((f) => f.name), ["src/main.py", "other.sh"]);
  assert.deepEqual(reads, ["src/main.py"]);
  assert.deepEqual(directories, ["", "src"]);
  assert.equal(state.openTabs[0].fileContent, "edited");
  assert.equal(state.openTabs[0].savedContent, "base");
  assert.deepEqual(state.openTabs[0].view, snapshot().workspaces[0].files[0].view);
  assert.equal(state.openTabs[1].loaded, false);
  assert.equal(state.openTabs[1].language, "text");
  assert.equal(state.workspaceTree.src.expanded, true);
  assert.equal(state.workspaceScroll, 72);
  assert.equal(useTerminalStore.getState().activeTab, "terminal-old");
  assert.equal(useTerminalStore.getState().tabs[0].status, undefined);
  assert.deepEqual(useTransferStore.getState().options, snapshot().transfer);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft?.content, "edited");
  assert.ok(!JSON.stringify(env.saved()).includes("current-run"));
  useAppStore.getState().activateFile("other.sh");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, ["src/main.py", "other.sh"]);
});

test("restored terminal reconnects to its original starting directory with a new session", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  await c.start();
  const open = t.mock.method(api, "openWorkspaceTerminal", async () => ({ session_id: "new-session", device_name: "device", state: "connected" as const, exit_code: null, error: null }));
  await useTerminalStore.getState().reconnect("terminal-old");
  assert.deepEqual(open.mock.calls[0].arguments, ["device", workspace, "src"]);
  assert.equal(useTerminalStore.getState().tabs[0].status?.session_id, "new-session");
  await c.flush();
  assert.ok(!JSON.stringify(env.saved()).includes("new-session"));
  t.mock.method(api, "closeAllTerminals", async () => {});
  await useTerminalStore.getState().closeAll();
  assert.equal(useTerminalStore.getState().tabs.length, 0);
  await c.flush();
  assert.equal(env.saved().terminals.length, 1);
});

test("offline drafts and missing clean files remain recoverable without empty file writes", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  t.mock.method(api, "readWorkspaceFile", async () => { throw new Error("offline"); });
  const write = t.mock.method(api, "writeWorkspaceFile", async () => { assert.fail("must not write an unread file"); });
  await c.start();
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "edited");
  assert.equal(useAppStore.getState().openTabs[0].conflict, true);
  useAppStore.getState().editContent("src/main.py", "offline edits");
  useAppStore.getState().activateFile("other.sh");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await useAppStore.getState().saveFile("other.sh"), false);
  assert.equal(write.mock.callCount(), 0);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft?.content, "offline edits");
  assert.equal(env.saved().workspaces[0].files[1].name, "other.sh");
});

test("an external file change preserves the draft and keeps the old revision for overwrite protection", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  t.mock.method(api, "readWorkspaceFile", async () => document("external edit", "v2"));
  const write = t.mock.method(api, "writeWorkspaceFile", async (request) => { assert.equal(request.expectedRevision, "v1"); throw { code: "conflict", message: "changed" }; });
  await c.start();
  assert.equal(write.mock.callCount(), 0);
  const tab = useAppStore.getState().openTabs[0];
  assert.equal(tab.fileContent, "edited");
  assert.equal(tab.savedContent, "external edit");
  assert.equal(tab.conflict, true);
  assert.equal(await useAppStore.getState().saveFile(), false);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft?.revision, "v1");
});

test("saving a lazy draft validates its base version and removes its backup only after success", async (t) => {
  const env = reset(t), state = snapshot();
  state.workspaces[0].active_file = "other.sh";
  const c = env.controller(state);
  await c.start();
  assert.equal(useAppStore.getState().openTabs[0].loaded, false);
  t.mock.method(api, "writeWorkspaceFile", async (request) => { assert.equal(request.expectedRevision, "v1"); assert.equal(request.content, "edited"); return { revision: "v2" }; });
  assert.equal(await useAppStore.getState().saveFile("src/main.py"), true);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft, undefined);
});

test("save on an unread clean tab loads the real contents and never writes its empty placeholder", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  await c.start();
  const write = t.mock.method(api, "writeWorkspaceFile", async () => { assert.fail("must not write an empty placeholder"); });
  assert.equal(await useAppStore.getState().saveFile("other.sh"), true);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "base");
  assert.equal(useAppStore.getState().openTabs[1].savedContent, "base");
});

test("discarded drafts stay discarded, and closing a workspace is remembered independently of recents", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  await c.start();
  const confirm = useAppStore.getState().confirmUnsaved("src/main.py");
  useAppStore.getState().changePrompt!.resolve("discard");
  assert.equal(await confirm, true);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft, undefined);
  // Simulate the final state after a confirmed explicit close.
  useAppStore.setState({ workspace: null, workspaceTree: {}, openTabs: [], activeFile: null });
  await c.flush();
  assert.equal(env.saved().current, null);
  assert.equal(env.saved().workspaces.length, 1);
});

test("canceling a multi-file discard restores draft backup eligibility", async (t) => {
  const env = reset(t), c = env.controller(snapshot());
  await c.start();
  useAppStore.setState((s) => ({ openTabs: s.openTabs.map((tab) => tab.name === "other.sh" ? { ...tab, fileContent: "another draft", loaded: true } : tab) }));
  const confirm = useAppStore.getState().confirmAllUnsaved();
  useAppStore.getState().changePrompt!.resolve("discard");
  await new Promise((resolve) => setImmediate(resolve));
  useAppStore.getState().changePrompt!.resolve("cancel");
  assert.equal(await confirm, false);
  await c.flush();
  assert.equal(env.saved().workspaces[0].files[0].draft?.content, "edited");
});

test("slow startup cannot replace a workspace or terminal opened by the user", async (t) => {
  const env = reset(t);
  let resolve!: (value: WorkEnvironment) => void;
  const read = new Promise<WorkEnvironment>((yes) => { resolve = yes; });
  let saved: WorkEnvironment | undefined;
  const c = createEnvironmentController({ read: () => read, write: async (value) => { saved = value; } });
  t.after(c.stop);
  const starting = c.start();
  await useAppStore.getState().setWorkspace(localWorkspace("/new"));
  useTerminalStore.setState({ tabs: [{ id: "user-tab", deviceId: "new", deviceName: "new", busy: false }], activeTab: "user-tab" });
  resolve(snapshot());
  await starting;
  await c.flush();
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/new"));
  assert.equal(useAppStore.getState().openTabs.length, 0);
  assert.equal(saved!.terminals[0].id, "user-tab");
});

test("write failures preserve the last snapshot and can be retried; corrupt reads never overwrite drafts", async (t) => {
  const env = reset(t);
  let fail = true, saved = snapshot();
  const c = createEnvironmentController({ read: async () => snapshot(), write: async (value) => { if (fail) throw new Error("disk full"); saved = value; } });
  t.after(c.stop);
  await c.start();
  useAppStore.getState().editContent("src/main.py", "newer");
  await assert.rejects(c.flush(), /disk full/);
  assert.equal(saved.workspaces[0].files[0].draft?.content, "edited");
  fail = false;
  await c.flush();
  assert.equal(saved.workspaces[0].files[0].draft?.content, "newer");
  c.stop();
  const corrupt = createEnvironmentController({ read: async () => { throw new Error("corrupt"); }, write: async () => { assert.fail("preserve original file"); } });
  t.after(corrupt.stop);
  await corrupt.start();
  await corrupt.flush();
  assert.match(useAppStore.getState().environmentError!, /原恢复记录已保留/);
});

test("window recovery handles disconnected displays, DPI, negative monitor coordinates and maximized normal bounds", () => {
  const saved = { x: -1800, y: 40, width: 1280, height: 800, maximized: true };
  const screens = [{ x: -1920, y: 0, width: 1920, height: 1040, scale: 1 }, { x: 0, y: 0, width: 2560, height: 1400, scale: 2 }];
  assert.deepEqual(fitWindow(saved, screens), saved);
  const moved = fitWindow(saved, [screens[1]]);
  assert.equal(moved.x, 0);
  assert.equal(moved.width, 1280);
  assert.equal(moved.height, 700);
  assert.equal(moved.maximized, true);
});

test("switching back to a workspace restores its file order, active file and editor view", async (t) => {
  const env = reset(t), state = snapshot();
  delete state.workspaces[0].files[0].draft;
  const c = env.controller(state);
  await c.start();
  useAppStore.setState((s) => ({ openTabs: s.openTabs.map((tab) => tab.name === "src/main.py"
    ? { ...tab, view: { anchor: 2, head: 3, scroll_top: 180, scroll_left: 12 } } : tab) }));
  await useAppStore.getState().setWorkspace(localWorkspace("/another"));
  await useAppStore.getState().openWorkspaceFile("new.py");
  await useAppStore.getState().setWorkspace(workspace);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["src/main.py", "other.sh"]);
  assert.equal(useAppStore.getState().activeFile, "src/main.py");
  assert.equal(useAppStore.getState().openTabs[0].view?.scroll_top, 180);
  await c.flush();
  assert.equal(env.saved().workspaces.length, 2);
});

test("overlapping flushes serialize writes and commit the newest edits last", async (t) => {
  reset(t);
  let release!: () => void;
  const held = new Promise<void>((yes) => { release = yes; });
  const writes: WorkEnvironment[] = [];
  let inFlight = 0, maximum = 0;
  const c = createEnvironmentController({ read: async () => snapshot(), write: async (value) => {
    ++inFlight; maximum = Math.max(maximum, inFlight); writes.push(value);
    if (writes.length === 1) await held;
    --inFlight;
  } });
  t.after(c.stop);
  await c.start();
  const first = c.flush();
  useAppStore.getState().editContent("src/main.py", "latest edits");
  const second = c.flush();
  release();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].workspaces[0].files[0].draft?.content, "latest edits");
});
