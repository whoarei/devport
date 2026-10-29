import test from "node:test";
import assert from "node:assert/strict";
import { api, localWorkspace, type WorkspaceOpenRequest, type WorkspaceRef } from "../src/api";
import { useAppStore } from "../src/store";
import { listenForWorkspaceLaunches } from "../src/workspaceLaunch";
import i18n from "../src/i18n";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = (dir: string): WorkspaceOpenRequest => ({ type: "open", workspace: localWorkspace(dir) });
const draft = { name: "main.py", fileContent: "edited", savedContent: "saved", revision: "v1",
  eol: "lf" as const, bom: false, language: "python" as const, conflict: false, generation: 1 };

test.before(async () => { await i18n.changeLanguage("zh"); });

function fixture(t: test.TestContext, initial: WorkspaceOpenRequest | null, ready = Promise.resolve()) {
  const original = useAppStore.getState();
  useAppStore.setState({ workspace: localWorkspace("/original"), workspaceTree: {}, openTabs: [], activeFile: null,
    loading: false, saving: false, starting: false, guarding: false, workspaceMutating: false, updating: false,
    editorError: null, workspaceError: null, changePrompt: null, recentWorkspaces: [] });
  t.mock.method(console, "warn", () => {});
  const directories: WorkspaceRef[] = [];
  t.mock.method(api, "listWorkspaceDir", async (workspace: WorkspaceRef) => { directories.push(workspace); return []; });
  let pending = initial, notify = () => {}, reads = 0, unlistened = false;
  const stop = listenForWorkspaceLaunches(ready, {
    take: async () => { ++reads; const value = pending; pending = null; return value; },
    listen: async (callback) => { notify = callback; return () => { unlistened = true; }; },
  });
  t.after(() => { stop(); useAppStore.setState(original, true); });
  return { directories, stop, reads: () => reads, unlistened: () => unlistened,
    send: (value: WorkspaceOpenRequest) => { pending = value; notify(); } };
}

test("a cold-start directory waits for recovery and supersedes the restored workspace", async (t) => {
  let restored!: () => void;
  const ready = new Promise<void>((resolve) => { restored = resolve; });
  const f = fixture(t, request("/selected folder/中文"), ready);
  useAppStore.setState({ workspace: null });
  await tick();
  assert.equal(f.reads(), 0);
  useAppStore.setState({ workspace: localWorkspace("/restored") });
  restored();
  await tick();
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/selected folder/中文"));
  assert.deepEqual(f.directories, [localWorkspace("/selected folder/中文")]);
});

test("restored drafts use the existing unsaved prompt and cancel keeps the original workspace", async (t) => {
  let restored!: () => void;
  const f = fixture(t, request("/selected"), new Promise<void>((resolve) => { restored = resolve; }));
  useAppStore.setState({ openTabs: [draft], activeFile: draft.name });
  restored();
  await tick();
  assert.equal(useAppStore.getState().changePrompt?.name, draft.name);
  assert.deepEqual(f.directories, []);
  useAppStore.getState().changePrompt!.resolve("cancel");
  await tick();
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/original"));
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "edited");
});

test("a running instance opens a new directory after the user discards its draft", async (t) => {
  const f = fixture(t, null);
  await tick();
  useAppStore.setState({ openTabs: [draft], activeFile: draft.name });
  f.send(request("/selected"));
  await tick();
  useAppStore.getState().changePrompt!.resolve("discard");
  await tick();
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/selected"));
  assert.equal(useAppStore.getState().openTabs.length, 0);
});

test("reopening the current directory preserves its tabs without another prompt", async (t) => {
  const f = fixture(t, request("/original"));
  useAppStore.setState({ openTabs: [draft], activeFile: draft.name });
  await tick();
  assert.equal(useAppStore.getState().changePrompt, null);
  assert.equal(useAppStore.getState().openTabs[0], draft);
  assert.deepEqual(f.directories, []);
});

test("busy operations defer directory requests and use the latest pending selection", async (t) => {
  const f = fixture(t, request("/initial"));
  useAppStore.setState({ saving: true });
  await tick();
  f.send(request("/intermediate"));
  f.send(request("/latest"));
  assert.equal(f.reads(), 0);
  useAppStore.setState({ saving: false });
  await tick();
  assert.deepEqual(f.directories, [localWorkspace("/latest")]);
});

test("requests arriving during an unsaved prompt are handled after it resolves", async (t) => {
  const f = fixture(t, request("/first"));
  useAppStore.setState({ openTabs: [draft], activeFile: draft.name });
  await tick();
  f.send(request("/second"));
  f.send(request("/last"));
  useAppStore.getState().changePrompt!.resolve("discard");
  await tick();
  assert.deepEqual(f.directories, [localWorkspace("/first"), localWorkspace("/last")]);
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/last"));
});

test("invalid and inaccessible directories report errors without closing current files", async (t) => {
  const f = fixture(t, { type: "error", message: "directory does not exist" });
  useAppStore.setState({ openTabs: [{ ...draft, savedContent: draft.fileContent }] });
  await tick();
  assert.match(useAppStore.getState().editorError!, /directory does not exist/);
  assert.deepEqual(f.directories, []);
  t.mock.method(api, "listWorkspaceDir", async () => { throw new Error("permission denied"); });
  f.send(request("/inaccessible"));
  await tick();
  assert.match(useAppStore.getState().editorError!, /permission denied/);
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/original"));
  assert.equal(useAppStore.getState().openTabs.length, 1);
});

test("StrictMode cleanup before recovery finishes leaves the launch request unconsumed", async (t) => {
  let restored!: () => void;
  const f = fixture(t, request("/selected"), new Promise<void>((resolve) => { restored = resolve; }));
  f.stop();
  restored();
  await tick();
  assert.equal(f.reads(), 0);
  assert.equal(f.unlistened(), true);
  assert.deepEqual(f.directories, []);
});
