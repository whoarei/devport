import test from "node:test";
import assert from "node:assert/strict";
import { appendOutput, MAX_OUTPUT_BYTES } from "../src/outputBuffer";
import { useAppStore } from "../src/store";
import { api, localWorkspace } from "../src/api";
import { loadWorkspaceHistory } from "../src/workspaceHistory";
import { anyDirty, dirtyTab, EditorTab, inferLanguage } from "../src/editorDocument";

test("output buffers stay bounded and retain an absolute replay position", () => {
  const first = appendOutput(undefined, new Uint8Array(MAX_OUTPUT_BYTES));
  const second = appendOutput(first, new Uint8Array([65]));
  assert.equal(first.chunks.length, 1);
  assert.equal(first.bytes, MAX_OUTPUT_BYTES);
  assert.equal(second.start, 1);
  assert.equal(second.bytes, 1);
  const third = appendOutput(second, new Uint8Array([66]));
  assert.equal(third.start + third.chunks.length, 3);
  assert.deepEqual(third.chunks.map((chunk) => [...chunk]), [[65], [66]]);
});

test("run output stays isolated and does not mutate previous store snapshots", () => {
  const handle = useAppStore.getState().handleRunEvent;
  handle({ type: "output", run_id: "a", stream: "stdout", data: btoa("A") });
  const previous = useAppStore.getState().outputBuffers;
  handle({ type: "output", run_id: "b", stream: "stderr", data: btoa("B") });
  handle({ type: "output", run_id: "a", stream: "stdout", data: btoa("C") });
  const current = useAppStore.getState().outputBuffers;
  assert.equal(previous.a.chunks.length, 1);
  assert.deepEqual(current.a.chunks.map((chunk) => [...chunk]), [[65], [67]]);
  assert.deepEqual(current.b.chunks.map((chunk) => [...chunk]), [[66]]);
});

test("terminal events update history synchronously and without duplicates", () => {
  const status = { run_id: "finished", device_name: "device", label: "test", state: "exited", exit_code: 0, error: null, started_at: "now", ended_at: "now" };
  useAppStore.getState().handleRunEvent({ type: "status", status });
  useAppStore.getState().handleRunEvent({ type: "status", status });
  assert.equal(useAppStore.getState().history.filter((h) => h.run_id === status.run_id).length, 1);
  assert.equal(useAppStore.getState().runs.finished.exit_code, 0);
});

test("recent workspaces persist successful opens, reorder repeats, and survive failed opens", async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalState = useAppStore.getState();
  // 按键存取的 localStorage 替身：v1 → v2 迁移会同时读写两个键
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    useAppStore.setState(originalState, true);
  });
  t.mock.method(api, "listWorkspaceDir", async (workspace: { type: string; dir?: string }) => {
    if (workspace.type === "local" && workspace.dir === "/missing") throw new Error("Directory no longer exists");
    return [{ name: "main.py", is_dir: false }];
  });
  useAppStore.setState({ recentWorkspaces: [] });
  const { setWorkspace } = useAppStore.getState();
  const pathOf = (workspace: { type: string; dir?: string; path?: string }) =>
    workspace.type === "local" ? workspace.dir : workspace.path;
  for (let i = 0; i < 12; i++) await setWorkspace(localWorkspace(`/workspace/${i}`));
  await setWorkspace(localWorkspace("/workspace/5"));
  const recent = useAppStore.getState().recentWorkspaces;
  assert.equal(recent.length, 10);
  assert.equal(pathOf(recent[0]), "/workspace/5");
  assert.equal(new Set(recent.map(pathOf)).size, 10);
  assert.ok(!recent.some((workspace) => pathOf(workspace) === "/workspace/0"));
  assert.deepEqual(loadWorkspaceHistory(), recent);

  useAppStore.setState({ openTabs: [makeTab("main.py", "print('hello')")], activeFile: "main.py" });
  const beforeFailure = useAppStore.getState();
  await assert.rejects(setWorkspace(localWorkspace("/missing")), /Directory no longer exists/);
  assert.equal(useAppStore.getState().openTabs, beforeFailure.openTabs);
  assert.equal(useAppStore.getState().workspace, beforeFailure.workspace);
  assert.deepEqual(loadWorkspaceHistory(), recent);

  const v1Key = "devport.recent-workspaces.v1";
  const v2Key = "devport.recent-workspaces.v2";
  stored.set(v2Key, "invalid JSON");
  assert.deepEqual(loadWorkspaceHistory(), []);
  stored.set(v2Key, JSON.stringify([null, 7, "", "  ", "/valid", "/valid"]));
  assert.deepEqual(loadWorkspaceHistory(), [localWorkspace("/valid")]);

  // v1（裸字符串数组）自动迁移为 v2：Local 条目 + 合法 Device 条目，非法条目丢弃
  stored.delete(v2Key);
  stored.set(v1Key, JSON.stringify(["/legacy/a", "/legacy/a",
    { type: "device", device_id: "d1", path: "/srv/app" },
    { type: "device", device_id: "d1", path: "relative" }, { type: "other" }, 42]));
  const migrated = [localWorkspace("/legacy/a"), { type: "device" as const, device_id: "d1", path: "/srv/app" }];
  assert.deepEqual(loadWorkspaceHistory(), migrated);
  assert.deepEqual(JSON.parse(stored.get(v2Key)!), migrated);
  assert.equal(stored.has(v1Key), false);

  // 重复条目去重且保持首次出现的顺序
  stored.set(v2Key, JSON.stringify([...migrated, { type: "device", device_id: "d1", path: "/srv/app" }]));
  assert.deepEqual(loadWorkspaceHistory(), migrated);

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => { throw new Error("Storage unavailable"); },
  });
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(loadWorkspaceHistory(), []);
  await setWorkspace(localWorkspace("/still-works"));
  assert.equal(useAppStore.getState().workspace?.type === "local" && useAppStore.getState().workspace.dir, "/still-works");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const diskDocument = (content: string) => ({ content, revision: `revision-${content}`, eol: "lf" as const, bom: false });
const makeTab = (name: string, content: string, saved = content, extra: Partial<EditorTab> = {}): EditorTab => ({
  name, fileContent: content, savedContent: saved, revision: "v1", eol: "lf", bom: false,
  language: inferLanguage(name), conflict: false, generation: 1, ...extra,
});
const editorState = () => ({ workspace: localWorkspace("/work"), openTabs: [makeTab("main.py", "original")], activeFile: "main.py" as string | null,
  loading: false, saving: false, starting: false, guarding: false, changePrompt: null,
  editorError: null, runs: {} });
const tabNamed = (name: string) => useAppStore.getState().openTabs.find((t) => t.name === name);

test("latest file selection wins including stale failures and cross-workspace reads", async (t) => {
  t.mock.method(console, "warn", () => {});
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(editorState());
  const a = deferred<ReturnType<typeof diskDocument>>();
  const b = deferred<ReturnType<typeof diskDocument>>();
  t.mock.method(api, "readWorkspaceFile", (_dir: string, name: string) => name === "a.py" ? a.promise : b.promise);
  const first = useAppStore.getState().openWorkspaceFile("a.py");
  await Promise.resolve();
  const second = useAppStore.getState().openWorkspaceFile("b.sh");
  b.resolve(diskDocument("B"));
  await second;
  a.reject(new Error("stale failure"));
  await first;
  // 迟到的失败不会留下标签，也不报错误；b.sh 正常打开并激活
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["main.py", "b.sh"]);
  assert.equal(useAppStore.getState().activeFile, "b.sh");
  assert.equal(tabNamed("b.sh")!.language, "shell");
  assert.equal(useAppStore.getState().editorError, null);
  const late = deferred<ReturnType<typeof diskDocument>>();
  t.mock.method(api, "readWorkspaceFile", () => late.promise);
  t.mock.method(api, "listWorkspaceDir", async () => []);
  const oldRead = useAppStore.getState().openWorkspaceFile("c.py");
  await Promise.resolve();
  await useAppStore.getState().setWorkspace(localWorkspace("/new"));
  late.resolve(diskDocument("old workspace"));
  await oldRead;
  assert.equal(useAppStore.getState().workspace?.type === "local" && useAppStore.getState().workspace.dir, "/new");
  assert.deepEqual(useAppStore.getState().openTabs, []);
  assert.equal(useAppStore.getState().activeFile, null);
});

test("save preserves newer edits, serializes writes, and undo to baseline clears dirty", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(editorState());
  const pending = deferred<{ revision: string }>();
  let calls = 0;
  t.mock.method(api, "writeWorkspaceFile", (request) => {
    calls++;
    assert.equal(request.content, "saved snapshot");
    assert.equal(request.expectedRevision, "v1");
    assert.deepEqual(request.workspace, localWorkspace("/work"));
    return pending.promise;
  });
  const state = useAppStore.getState();
  state.editContent("main.py", "saved snapshot");
  const save = state.saveFile();
  assert.equal(await state.saveFile(), false);
  state.editContent("main.py", "new typing");
  pending.resolve({ revision: "v2" });
  assert.equal(await save, true);
  assert.equal(calls, 1);
  assert.equal(tabNamed("main.py")!.savedContent, "saved snapshot");
  assert.equal(tabNamed("main.py")!.fileContent, "new typing");
  assert.equal(dirtyTab(tabNamed("main.py")!), true);
  state.editContent("main.py", "saved snapshot");
  assert.equal(dirtyTab(tabNamed("main.py")!), false);
});

test("close guard handles cancel and save failure without losing buffer; reload discards", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...editorState(), openTabs: [makeTab("main.py", "my edits", "original")] });
  t.mock.method(api, "readWorkspaceFile", async () => { throw new Error("missing file"); });
  t.mock.method(api, "writeWorkspaceFile", async () => { throw { code: "conflict", message: "external change" }; });
  const state = useAppStore.getState();
  for (const choice of ["cancel", "save"] as const) {
    const closing = state.closeFile();
    assert.ok(useAppStore.getState().changePrompt);
    state.editContent("main.py", "ignored while confirming");
    useAppStore.getState().changePrompt!.resolve(choice);
    await closing;
    assert.equal(useAppStore.getState().activeFile, "main.py");
    assert.equal(tabNamed("main.py")!.fileContent, "my edits");
    assert.equal(useAppStore.getState().guarding, false);
  }
  // 保存失败（冲突）后标签保留并标记冲突
  assert.equal(tabNamed("main.py")!.conflict, true);
  // 放弃修改：标签关闭
  const closing = state.closeFile();
  useAppStore.getState().changePrompt!.resolve("discard");
  await closing;
  assert.deepEqual(useAppStore.getState().openTabs, []);
  assert.equal(useAppStore.getState().activeFile, null);
  // 重新打开后 reload 用磁盘内容替换（放弃当前修改）
  useAppStore.setState({ openTabs: [makeTab("main.py", "my edits", "original", { conflict: true })], activeFile: "main.py" });
  t.mock.method(api, "readWorkspaceFile", async () => diskDocument("external"));
  const reload = state.reloadFile();
  useAppStore.getState().changePrompt!.resolve("discard");
  await reload;
  assert.equal(tabNamed("main.py")!.fileContent, "external");
  assert.equal(tabNamed("main.py")!.conflict, false);
});

test("save-and-continue writes before switching workspace and the unsaved guard supports all choices", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...editorState(), openTabs: [makeTab("main.py", "edits", "original")] });
  const order: string[] = [];
  t.mock.method(api, "writeWorkspaceFile", async () => { order.push("save"); return { revision: "v2" }; });
  t.mock.method(api, "listWorkspaceDir", async () => { order.push("list"); return []; });
  const switching = useAppStore.getState().setWorkspace(localWorkspace("/new"));
  useAppStore.getState().changePrompt!.resolve("save");
  await switching;
  assert.deepEqual(order, ["save", "list"]);
  assert.deepEqual(useAppStore.getState().openTabs, []);
  useAppStore.setState(editorState());
  for (const choice of ["cancel", "discard", "save"] as const) {
    useAppStore.getState().editContent("main.py", `edit ${choice}`);
    const allowed = useAppStore.getState().confirmUnsaved();
    useAppStore.getState().changePrompt!.resolve(choice);
    assert.equal(await allowed, choice !== "cancel");
  }
});

test("closeFile refuses while busy, keeps buffer on cancel, and activates a neighbor tab", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  // 忙时拒绝关闭
  useAppStore.setState({ ...editorState(), saving: true });
  await useAppStore.getState().closeFile();
  assert.equal(useAppStore.getState().activeFile, "main.py");
  // 取消：保留标签与未保存内容
  useAppStore.setState({ saving: false, openTabs: [makeTab("main.py", "unsaved edits", "original")] });
  const canceled = useAppStore.getState().closeFile();
  assert.ok(useAppStore.getState().changePrompt);
  useAppStore.getState().changePrompt!.resolve("cancel");
  await canceled;
  assert.equal(useAppStore.getState().activeFile, "main.py");
  assert.equal(tabNamed("main.py")!.fileContent, "unsaved edits");
  // 保存：先写盘再关闭
  t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "v2" }));
  const saved = useAppStore.getState().closeFile();
  useAppStore.getState().changePrompt!.resolve("save");
  await saved;
  assert.deepEqual(useAppStore.getState().openTabs, []);
  assert.equal(useAppStore.getState().activeFile, null);
  // 已全部关闭时再次调用为空操作
  await useAppStore.getState().closeFile();
  // 关闭活动标签后激活右侧邻居，并清掉残留错误
  useAppStore.setState({ openTabs: [makeTab("a.py", "a"), makeTab("b.py", "b edits", "b"), makeTab("c.sh", "c")],
    activeFile: "b.py", editorError: "stale error" });
  const discarded = useAppStore.getState().closeFile();
  useAppStore.getState().changePrompt!.resolve("discard");
  await discarded;
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["a.py", "c.sh"]);
  assert.equal(useAppStore.getState().activeFile, "c.sh");
  assert.equal(useAppStore.getState().editorError, null);
  // 关闭非活动标签不改变活动标签；关闭末尾标签回退到左侧邻居
  await useAppStore.getState().closeFile("a.py");
  assert.equal(useAppStore.getState().activeFile, "c.sh");
  await useAppStore.getState().closeFile("c.sh");
  assert.deepEqual(useAppStore.getState().openTabs, []);
  assert.equal(useAppStore.getState().activeFile, null);
});

test("both run modes save non-entry edits first; failed saves never launch and startup locks editing", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  const order: string[] = [];
  t.mock.method(api, "writeWorkspaceFile", async () => { order.push("save"); return { revision: "v2" }; });
  t.mock.method(api, "runScript", async () => { order.push("run"); return "run-1"; });
  t.mock.method(api, "getRunStatus", async () => null);
  for (const kind of ["python", "command"] as const) {
    useAppStore.setState({ ...editorState(), openTabs: [makeTab("helper.py", "edited helper", "original")], activeFile: "helper.py" });
    const request = { device_id: "device", workspace: localWorkspace("/work"), kind, entry: "main.py", command: "python3 main.py" };
    const starting = useAppStore.getState().startRun(request);
    useAppStore.getState().editContent("helper.py", "ignored during launch");
    assert.equal(tabNamed("helper.py")!.fileContent, "edited helper");
    await starting;
    assert.equal(useAppStore.getState().runs["run-1"].state, "preparing");
    useAppStore.getState().editContent("helper.py", "next run");
    assert.equal(await useAppStore.getState().saveFile(), false);
  }
  assert.deepEqual(order, ["save", "run", "save", "run"]);
  useAppStore.setState({ ...editorState(), openTabs: [makeTab("main.py", "edits", "original")] });
  t.mock.method(api, "writeWorkspaceFile", async () => { throw new Error("disk full"); });
  await assert.rejects(useAppStore.getState().startRun({ device_id: "device", workspace: localWorkspace("/work"), kind: "python", entry: "main.py" }), /disk full/);
  assert.equal(order.length, 4);
  assert.equal(useAppStore.getState().starting, false);
  assert.equal(tabNamed("main.py")!.fileContent, "edits");
});

test("startRun saves every dirty tab and aborts on the first failure", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  const order: string[] = [];
  t.mock.method(api, "writeWorkspaceFile", async (request) => { order.push(`save ${request.name}`); return { revision: "v2" }; });
  t.mock.method(api, "runScript", async () => { order.push("run"); return "run-1"; });
  t.mock.method(api, "getRunStatus", async () => null);
  // 两个脏标签（其中一个是入口）都先保存再启动；干净标签不重复写盘
  useAppStore.setState({ ...editorState(), openTabs: [
    makeTab("helper.py", "helper edits", "original"),
    makeTab("main.py", "main edits", "original"),
    makeTab("notes.txt", "clean"),
  ], activeFile: "main.py" });
  await useAppStore.getState().startRun({ device_id: "device", workspace: localWorkspace("/work"), kind: "python", entry: "main.py" });
  assert.deepEqual(order, ["save helper.py", "save main.py", "run"]);
  assert.equal(anyDirty(useAppStore.getState()), false);
  // 第一个保存失败即中止：不写第二个标签，也不启动
  order.length = 0;
  useAppStore.setState({ openTabs: [makeTab("a.py", "a edits", "a"), makeTab("b.py", "b edits", "b")], activeFile: "a.py", runs: {} });
  t.mock.method(api, "writeWorkspaceFile", async (request) => {
    order.push(`save ${request.name}`);
    throw new Error("disk full");
  });
  await assert.rejects(
    useAppStore.getState().startRun({ device_id: "device", workspace: localWorkspace("/work"), kind: "python", entry: "a.py" }),
    /disk full/);
  assert.deepEqual(order, ["save a.py"]);
  assert.equal(dirtyTab(tabNamed("b.py")!), true);
});

test("editor language detection does not change execution inference", () => {
  assert.equal(inferLanguage("HELLO.PY"), "python");
  assert.equal(inferLanguage("run.BASH"), "shell");
  assert.equal(inferLanguage("config.txt"), "text");
});
