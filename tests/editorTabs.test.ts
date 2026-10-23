import test from "node:test";
import assert from "node:assert/strict";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile } from "../src/api";
import { dirtyTab, neighborAfterClose, type EditorTab } from "../src/editorDocument";
import { editorCloseTargets, type EditorCloseScope } from "../src/editorTabActions";
import { captureWorkspace, restoredTab } from "../src/environmentState";
import { useAppStore } from "../src/store";

const tab = (name: string, dirty = false): EditorTab => ({ name, fileContent: dirty ? `${name} edited` : name,
  savedContent: name, revision: "v1", eol: "lf", bom: false, language: "text", conflict: false, generation: 1 });
const names = () => useAppStore.getState().openTabs.map((tab) => tab.name);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const device = (revision: string): DeviceProfile => ({ id: "device", revision, name: "Source", is_default: false,
  transport: "ssh", host: "localhost", port: 22, username: "user", auth: { type: "password", password: "" }, workspace_root: "/work" });
function reset(t: test.TestContext, tabs: EditorTab[], active = tabs[0]?.name ?? null) {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ workspace: localWorkspace("/work"), workspaceTree: {}, workspaceScroll: 0,
    openTabs: tabs, activeFile: active, loading: false, saving: false, starting: false, guarding: false,
    workspaceMutating: false, changePrompt: null, editorError: null, runs: {} });
  return useAppStore.getState();
}
function choose(choice: "save" | "discard" | "cancel", name: string) {
  const prompt = useAppStore.getState().changePrompt;
  assert.equal(prompt?.name, name);
  prompt!.resolve(choice);
}

function mockFileReads(t: test.TestContext) {
  t.mock.method(console, "warn", () => {});
  return t.mock.method(api, "readWorkspaceFile", async (_workspace, name) => ({
    content: name, revision: "v1", eol: "lf" as const, bom: false,
  }));
}

test("tree previews replace one slot while pinned tabs retain their order and identity", async (t) => {
  const left = tab("left"), right = tab("right");
  const state = reset(t, [left, { ...tab("preview"), preview: true }, right]);
  const read = mockFileReads(t);
  await state.openWorkspaceFile("next", { preview: true });
  assert.deepEqual(names(), ["left", "next", "right"]);
  assert.equal(useAppStore.getState().openTabs[1].preview, true);
  assert.equal(useAppStore.getState().activeFile, "next");
  await state.openWorkspaceFile("right", { preview: true });
  assert.equal(useAppStore.getState().openTabs[2], right);
  assert.equal(useAppStore.getState().openTabs[2].preview, undefined);
  assert.deepEqual(names(), ["left", "next", "right"]);
  assert.equal(read.mock.callCount(), 1);
  await state.openWorkspaceFile("last", { preview: true });
  assert.deepEqual(names(), ["left", "last", "right"]);
  assert.equal(useAppStore.getState().openTabs[0], left);
});

test("double-click opening and pinning preserve content and keep future previews separate", async (t) => {
  const preview = { ...tab("preview"), preview: true };
  const state = reset(t, [preview]);
  const read = mockFileReads(t);
  await state.openWorkspaceFile("preview");
  assert.equal(read.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
  assert.equal(useAppStore.getState().openTabs[0].generation, preview.generation);
  await state.openWorkspaceFile("next", { preview: true });
  state.pinFile("next");
  await state.openWorkspaceFile("last", { preview: true });
  assert.deepEqual(names(), ["preview", "next", "last"]);
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.preview), [false, false, true]);
});

test("the first content change pins a preview permanently even after undoing or saving", async (t) => {
  const state = reset(t, [{ ...tab("preview"), preview: true }]);
  mockFileReads(t);
  t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "v2" }));
  state.editContent("preview", "preview");
  assert.equal(useAppStore.getState().openTabs[0].preview, true, "no content change keeps the preview");
  state.editContent("preview", "edited");
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
  state.editContent("preview", "preview");
  assert.equal(dirtyTab(useAppStore.getState().openTabs[0]), false);
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
  state.editContent("preview", "edited again");
  assert.equal(await state.saveFile("preview"), true);
  state.editContent("preview", "preview");
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
  await state.openWorkspaceFile("next", { preview: true });
  assert.deepEqual(names(), ["preview", "next"]);
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "preview");
});

test("a dirty tab cannot be discarded by preview replacement even if its flag was left set", async (t) => {
  const state = reset(t, [{ ...tab("draft", true), preview: true }]);
  mockFileReads(t);
  await state.openWorkspaceFile("next", { preview: true });
  assert.deepEqual(names(), ["draft", "next"]);
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "draft edited");
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
});

test("failed preview reads keep the previous preview and content", async (t) => {
  const preview = { ...tab("preview"), preview: true };
  const state = reset(t, [preview]);
  t.mock.method(api, "readWorkspaceFile", async () => { throw new Error("read failed"); });
  await state.openWorkspaceFile("missing", { preview: true });
  assert.deepEqual(useAppStore.getState().openTabs, [preview]);
  assert.equal(useAppStore.getState().activeFile, "preview");
  assert.equal(useAppStore.getState().loading, false);
  assert.equal(useAppStore.getState().editorError, "read failed");
});

test("double-click before the preview finishes loading wins over late preview responses", async (t) => {
  const state = reset(t, [{ ...tab("previous"), preview: true }]);
  const reads: (() => void)[] = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(api, "readWorkspaceFile", (_workspace, name) => new Promise((resolve) => {
    reads.push(() => resolve({ content: name, revision: "v1", eol: "lf" as const, bom: false }));
  }));
  const firstClick = state.openWorkspaceFile("slow", { preview: true });
  const secondClick = state.openWorkspaceFile("slow", { preview: true });
  const doubleClick = state.openWorkspaceFile("slow");
  reads[2]();
  await doubleClick;
  reads[0](); reads[1]();
  await Promise.all([firstClick, secondClick]);
  assert.deepEqual(names(), ["slow"]);
  assert.equal(useAppStore.getState().openTabs[0].preview, false);
  assert.equal(useAppStore.getState().loading, false);
});

test("returning to the active preview cancels a different file still being read", async (t) => {
  const state = reset(t, [{ ...tab("preview"), preview: true }]);
  let finish!: () => void;
  t.mock.method(console, "warn", () => {});
  t.mock.method(api, "readWorkspaceFile", () => new Promise((resolve) => {
    finish = () => resolve({ content: "late", revision: "v1", eol: "lf" as const, bom: false });
  }));
  const pending = state.openWorkspaceFile("slow", { preview: true });
  await state.openWorkspaceFile("preview", { preview: true });
  finish();
  await pending;
  assert.deepEqual(names(), ["preview"]);
  assert.equal(useAppStore.getState().activeFile, "preview");
  assert.equal(useAppStore.getState().loading, false);
  assert.equal(useAppStore.getState().openTabs[0].preview, true);
});

test("a restored tab removed during its read cannot replace a different open tab", async (t) => {
  const kept = tab("keep");
  const state = reset(t, [restoredTab({ name: "restored", language: "text" }), kept]);
  let finish!: () => void;
  t.mock.method(api, "readWorkspaceFile", () => new Promise((resolve) => {
    finish = () => resolve({ content: "late", revision: "v1", eol: "lf" as const, bom: false });
  }));
  const pending = state.openWorkspaceFile("restored", { reveal: false });
  useAppStore.setState({ openTabs: [kept], activeFile: "keep" });
  finish();
  await pending;
  assert.deepEqual(useAppStore.getState().openTabs, [kept]);
  assert.equal(useAppStore.getState().activeFile, "keep");
  assert.equal(useAppStore.getState().loading, false);
});

test("all six close scopes use the context tab and visual order, including restored drafts", () => {
  const tabs = [tab("a"), tab("b", true), restoredTab({ name: "c", language: "text" }),
    restoredTab({ name: "d", language: "text", draft: { content: "draft", saved_content: "base", revision: "v1", eol: "lf", bom: false } })];
  const scopes: Record<EditorCloseScope, string[]> = { current: ["b"], others: ["a", "c", "d"],
    left: ["a"], right: ["c", "d"], saved: ["a", "c"], all: ["a", "b", "c", "d"] };
  for (const [scope, expected] of Object.entries(scopes)) {
    assert.deepEqual(editorCloseTargets(tabs, "b", scope as EditorCloseScope), expected);
    assert.deepEqual(editorCloseTargets(tabs, "missing", scope as EditorCloseScope), []);
  }
  assert.deepEqual(editorCloseTargets(tabs, "a", "left"), []);
  assert.deepEqual(editorCloseTargets(tabs, "d", "right"), []);
  assert.deepEqual(editorCloseTargets([tab("only", true)], "only", "saved"), []);
  assert.deepEqual(editorCloseTargets([tab("only")], "only", "others"), []);
});

test("batch neighbor selection follows original positions despite gaps from other closed tabs", () => {
  const tabs = ["a", "b", "c", "d", "e", "f"].map((name) => tab(name));
  assert.equal(neighborAfterClose(tabs, "d", [tabs[2], tabs[4], tabs[5]]), "e");
  assert.equal(neighborAfterClose(tabs, "e", [tabs[0], tabs[2]]), "c");
  assert.equal(neighborAfterClose(tabs, "a", []), null);
});

test("batch cancellation keeps all tabs and every discarded draft eligible for recovery", async (t) => {
  const state = reset(t, [tab("a"), tab("b", true), tab("c", true)], "a");
  const closing = state.closeFiles(["a", "b", "c"]);
  await tick();
  choose("discard", "b");
  await tick();
  assert.deepEqual(names(), ["a", "b", "c"]);
  const captured = captureWorkspace(useAppStore.getState())!;
  assert.equal(captured.files[1].draft?.content, "b edited");
  choose("cancel", "c");
  await closing;
  assert.deepEqual(names(), ["a", "b", "c"]);
  assert.equal(useAppStore.getState().activeFile, "a");
  assert.equal(captureWorkspace(useAppStore.getState())!.files[1].draft?.content, "b edited");
  assert.equal(useAppStore.getState().guarding, false);
  assert.equal(useAppStore.getState().changePrompt, null);
});

test("successful saves survive a later cancellation without removing any tabs", async (t) => {
  const state = reset(t, [tab("a", true), tab("b", true)]);
  const write = t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "v2" }));
  const closing = state.closeFiles(["b", "a", "a"]);
  choose("save", "a");
  await tick();
  assert.equal(write.mock.callCount(), 1);
  assert.equal(dirtyTab(useAppStore.getState().openTabs[0]), false);
  choose("cancel", "b");
  await closing;
  assert.deepEqual(names(), ["a", "b"]);
  assert.equal(useAppStore.getState().openTabs[0].revision, "v2");
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "b edited");
});

test("save conflict aborts the entire batch and preserves earlier discarded drafts", async (t) => {
  const state = reset(t, [tab("a", true), tab("b", true), tab("c")]);
  t.mock.method(api, "writeWorkspaceFile", async () => { throw { code: "conflict", message: "external change" }; });
  const closing = state.closeFiles(["a", "b", "c"]);
  choose("discard", "a");
  await tick();
  choose("save", "b");
  await closing;
  assert.deepEqual(names(), ["a", "b", "c"]);
  assert.equal(useAppStore.getState().editorError, "external change");
  assert.equal(useAppStore.getState().openTabs[1].conflict, true);
  assert.equal(captureWorkspace(useAppStore.getState())!.files[0].draft?.content, "a edited");
  assert.equal(useAppStore.getState().guarding, false);
});

test("batch closes once after every choice and holds the guard across prompts and saves", async (t) => {
  const state = reset(t, [tab("a", true), tab("b", true), tab("keep")], "a");
  let finishSave!: (value: { revision: string }) => void;
  t.mock.method(api, "writeWorkspaceFile", () => new Promise<{ revision: string }>((resolve) => { finishSave = resolve; }));
  const closed: string[][] = [];
  const unlisten = useAppStore.subscribe((next, previous) => {
    if (next.openTabs.length !== previous.openTabs.length) closed.push(next.openTabs.map((tab) => tab.name));
  });
  t.after(unlisten);
  const closing = state.closeFiles(["b", "a"]);
  choose("save", "a");
  await tick();
  assert.equal(useAppStore.getState().saving, true);
  assert.equal(useAppStore.getState().guarding, true);
  state.editContent("a", "ignored");
  state.activateFile("keep");
  await state.closeFile("keep");
  await state.setWorkspace(localWorkspace("/other"));
  assert.equal(useAppStore.getState().activeFile, "a");
  assert.equal(useAppStore.getState().workspace, state.workspace);
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "a edited");
  assert.deepEqual(names(), ["a", "b", "keep"]);
  finishSave({ revision: "v2" });
  await tick();
  assert.equal(useAppStore.getState().guarding, true);
  choose("discard", "b");
  await closing;
  assert.deepEqual(closed, [["keep"]]);
  assert.equal(useAppStore.getState().activeFile, "keep");
  assert.equal(useAppStore.getState().guarding, false);
});

test("close operations refuse busy states and share the same single-file entry point", async (t) => {
  const state = reset(t, [tab("a"), tab("b")]);
  for (const flag of ["loading", "saving", "starting", "guarding", "workspaceMutating"] as const) {
    useAppStore.setState({ [flag]: true });
    await state.closeFiles(["a", "b"]);
    await state.closeFile("b");
    assert.deepEqual(names(), ["a", "b"]);
    useAppStore.setState({ [flag]: false });
  }
  const close = t.mock.method(useAppStore.getState(), "closeFiles", async () => {});
  await useAppStore.getState().closeFile();
  assert.deepEqual(close.mock.calls[0].arguments, [["a"]]);
});

test("closing saved tabs skips restored drafts and does not read or write closed placeholders", async (t) => {
  const draft = restoredTab({ name: "draft", language: "text", draft: {
    content: "draft", saved_content: "base", revision: "v1", eol: "lf", bom: false } });
  const state = reset(t, [tab("a"), draft, restoredTab({ name: "clean", language: "text" })], "draft");
  const read = t.mock.method(api, "readWorkspaceFile", async () => { assert.fail("must not read"); });
  const write = t.mock.method(api, "writeWorkspaceFile", async () => { assert.fail("must not write"); });
  await state.closeFiles(editorCloseTargets(state.openTabs, "a", "saved"));
  assert.deepEqual(names(), ["draft"]);
  assert.equal(useAppStore.getState().activeFile, "draft");
  assert.equal(read.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 0);
});

test("saving a restored draft can change its generation before the batch commits", async (t) => {
  const draft = restoredTab({ name: "draft", language: "text", draft: {
    content: "edited", saved_content: "base", revision: "v1", eol: "lf", bom: false } });
  const state = reset(t, [draft, tab("keep")]);
  t.mock.method(api, "readWorkspaceFile", async () => ({ content: "base", revision: "v1", eol: "lf" as const, bom: false }));
  const write = t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "v2" }));
  const closing = state.closeFiles(["draft"]);
  choose("save", "draft");
  await closing;
  assert.deepEqual(names(), ["keep"]);
  assert.equal(write.mock.calls[0].arguments[0].content, "edited");
});

test("closing the active tab loads its restored neighbor and closing all hides the editor", async (t) => {
  const state = reset(t, [tab("a"), restoredTab({ name: "b", language: "text" })]);
  t.mock.method(console, "warn", () => {});
  useAppStore.setState({ layout: { ...state.layout, panelVisible: { ...state.layout.panelVisible, editor: true } } });
  t.mock.method(api, "readWorkspaceFile", async () => ({ content: "disk content", revision: "v1", eol: "lf" as const, bom: false }));
  await state.closeFile("a");
  assert.equal(useAppStore.getState().activeFile, "b");
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "disk content");
  assert.equal(useAppStore.getState().openTabs[0].loaded, true);
  await state.closeFiles(["b"]);
  assert.equal(useAppStore.getState().activeFile, null);
  assert.equal(useAppStore.getState().layout.panelVisible.editor, false);
});

test("batch targets are fixed at invocation and unknown names cannot close newly opened tabs", async (t) => {
  const state = reset(t, [tab("a", true), tab("keep")], "keep");
  const closing = state.closeFiles(["a", "new", "a"]);
  useAppStore.setState((s) => ({ openTabs: [...s.openTabs, tab("new")] }));
  choose("discard", "a");
  await closing;
  assert.deepEqual(names(), ["keep", "new"]);
  assert.equal(useAppStore.getState().activeFile, "keep");
});

test("stale workspace or document changes invalidate pending close choices before writing", async (t) => {
  reset(t, []);
  const write = t.mock.method(api, "writeWorkspaceFile", async () => { assert.fail("must not write"); });
  for (const change of ["workspace", "document", "connection"] as const) {
    useAppStore.setState({ workspace: deviceWorkspace("device", "/work"), devices: [device("v1")],
      openTabs: [tab("a", true), tab("b")], activeFile: "a" });
    const closing = useAppStore.getState().closeFiles(["a", "b"]);
    if (change === "workspace") useAppStore.setState({ workspace: localWorkspace("/other") });
    else if (change === "document") useAppStore.setState({ openTabs: [ { ...tab("a", true), generation: 2 }, tab("b")] });
    else useAppStore.setState({ devices: [device("v2")] });
    choose("save", "a");
    await closing;
    assert.deepEqual(names(), ["a", "b"]);
    assert.equal(useAppStore.getState().guarding, false);
  }
  assert.equal(write.mock.callCount(), 0);
});
