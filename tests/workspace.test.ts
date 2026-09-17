import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, deviceWorkspace, localWorkspace, RunStatus, type DeviceProfile } from "../src/api";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });
import { EditorTab, inferLanguage } from "../src/editorDocument";
import { DEFAULT_RUN_DRAFT } from "../src/runState";
import { WorkspacePanel, workspacePickerMenuEntries, workspaceSwitchMenuEntries, workspaceTerminalMenuEntries } from "../src/components/WorkspacePanel";
import {
  collectScripts, dropSubtree, isWithin, joinPath, nameOf, parentOf, rekeySubtree, WORKSPACE_ROOT,
} from "../src/workspaceTree";

const runStatus = (state: string): RunStatus => ({
  run_id: "run-1", device_name: "device", label: "task", state,
  exit_code: null, error: null, started_at: "", ended_at: null,
});

const makeTab = (name: string, content: string, saved = content, extra: Partial<EditorTab> = {}): EditorTab => ({
  name, fileContent: content, savedContent: saved, revision: "v1", eol: "lf", bom: false,
  language: inferLanguage(name), conflict: false, generation: 1, ...extra,
});

const treeState = () => ({
  workspace: localWorkspace("/work"),
  workspaceTree: {
    [WORKSPACE_ROOT]: { entries: [{ name: "sub", is_dir: true }, { name: "main.py", is_dir: false }], expanded: true, loaded: true },
    sub: { entries: [{ name: "inner.py", is_dir: false }], expanded: true, loaded: true },
  },
  workspaceError: null,
  workspaceMutating: false,
  openTabs: [] as EditorTab[],
  activeFile: null as string | null,
  editorError: null,
  changePrompt: null,
  loading: false,
  saving: false,
  starting: false,
  guarding: false,
  runs: {},
  runDraft: { ...DEFAULT_RUN_DRAFT },
});

test("workspace path helpers keep relative paths and subtree relations", () => {
  assert.equal(joinPath(WORKSPACE_ROOT, "main.py"), "main.py");
  assert.equal(joinPath("sub", "inner.py"), "sub/inner.py");
  assert.equal(parentOf("sub/inner.py"), "sub");
  assert.equal(parentOf("main.py"), WORKSPACE_ROOT);
  assert.equal(nameOf("sub/inner.py"), "inner.py");
  assert.ok(isWithin("sub", "sub"));
  assert.ok(isWithin("sub/inner.py", "sub"));
  assert.ok(isWithin("main.py", WORKSPACE_ROOT));
  assert.ok(!isWithin("subway/x.py", "sub"));
  assert.ok(isWithin(WORKSPACE_ROOT, WORKSPACE_ROOT));

  const tree = {
    [WORKSPACE_ROOT]: { entries: [], expanded: true, loaded: true },
    sub: { entries: [], expanded: true, loaded: true },
    other: { entries: [], expanded: false, loaded: true },
  };
  const rekeyed = rekeySubtree(tree, "sub", "renamed");
  assert.deepEqual(Object.keys(rekeyed).sort(), ["", "other", "renamed"]);
  assert.equal(rekeyed.renamed.expanded, true);
  assert.deepEqual(Object.keys(dropSubtree(tree, "sub")).sort(), ["", "other"]);

  assert.deepEqual(collectScripts({
    [WORKSPACE_ROOT]: {
      entries: [{ name: "b.sh", is_dir: false }, { name: "a.py", is_dir: false },
        { name: "notes.txt", is_dir: false }, { name: "sub", is_dir: true }],
      expanded: true, loaded: true,
    },
    sub: { entries: [{ name: "deep.py", is_dir: false }], expanded: true, loaded: true },
  }), ["a.py", "b.sh", "sub/deep.py"]);
});

test("workspace panel renders the tree with expansion state and an empty hint", (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  useAppStore.setState({ ...treeState(), activeFile: "sub/inner.py" });
  const html = renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: false, onToggleCollapse: () => {} }));
  assert.match(html, />sub</);
  assert.match(html, /inner\.py/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /class="active"/);
  // 折叠时只渲染标题，未打开工作区时显示提示而不是空白
  const collapsed = renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: true, onToggleCollapse: () => {} }));
  assert.doesNotMatch(collapsed, /inner\.py/);
  useAppStore.setState({ workspace: null, workspaceTree: {} });
  assert.match(renderToStaticMarkup(createElement(WorkspacePanel, { collapsed: false, onToggleCollapse: () => {} })),
    /尚未选择工作区目录/);
});

test("empty workspace context menu offers open and recent workspaces", () => {
  const withRecent = workspacePickerMenuEntries((key) => i18n.t(key), [localWorkspace("/a"), localWorkspace("/b")]);
  assert.deepEqual(withRecent.map((entry) => entry === "separator" ? "|" : entry.label),
    ["打开工作区…", "打开设备工作区…", "|", "/a", "/b"]);

  const empty = workspacePickerMenuEntries((key) => i18n.t(key), []);
  assert.deepEqual(empty.map((entry) => entry === "separator" ? "|" : entry.label),
    ["打开工作区…", "打开设备工作区…", "|", "（无最近记录）"]);
  const placeholder = empty[3];
  assert.ok(placeholder !== "separator" && placeholder.disabled);
});

test("recent device workspaces are labelled with their host device", () => {
  const device: DeviceProfile = {
    id: "d1", name: "board", is_default: false, transport: "ssh",
    host: "10.0.0.2", port: 22, username: "root", auth: { type: "key", key_path: null },
    workspace_root: "/srv",
  };
  const entries = workspacePickerMenuEntries(
    (key) => i18n.t(key), [deviceWorkspace("d1", "/srv/app"), localWorkspace("/local")], [device]);
  assert.deepEqual(entries.map((entry) => entry === "separator" ? "|" : entry.label),
    ["打开工作区…", "打开设备工作区…", "|", "board:/srv/app", "/local"]);
});

test("open workspace blank-area menu adds close, open and recent entries for switching", () => {
  const entries = workspaceSwitchMenuEntries((key) => i18n.t(key), [localWorkspace("/a"), localWorkspace("/b")]);
  assert.deepEqual(entries.map((entry) => entry === "separator" ? "|" : entry.label),
    ["打开工作区…", "打开设备工作区…", "关闭工作区", "|", "/a", "/b"]);

  const empty = workspaceSwitchMenuEntries((key) => i18n.t(key), []);
  assert.deepEqual(empty.map((entry) => entry === "separator" ? "|" : entry.label),
    ["打开工作区…", "打开设备工作区…", "关闭工作区", "|", "（无最近记录）"]);
});

test("workspace terminal submenu lists only local devices with fallbacks for full or none", () => {
  const localDevice = (id: string, is_default = false): DeviceProfile => ({
    id, name: id, is_default, transport: "local", local: { shell: "bash" },
    host: "", port: 0, username: "", auth: { type: "key", key_path: null }, workspace_root: "",
  });
  const t = (key: string) => i18n.t(key);

  // 标签已满：唯一的置灰占位项
  const full = workspaceTerminalMenuEntries(t, [localDevice("l1")], localWorkspace("/work"), true, () => {});
  assert.ok(full[0] !== "separator" && full[0].disabled && full[0].label === i18n.t("terminal.maxTabs"));

  // 本机工作区但没有本机设备：置灰占位；SSH/WSL 不出现在子菜单里
  const none = workspaceTerminalMenuEntries(t, [{ ...localDevice("s1"), transport: "ssh", local: null }],
    localWorkspace("/work"), false, () => {});
  assert.ok(none[0] !== "separator" && none[0].disabled && none[0].label === i18n.t("workspace.noLocalDevices"));

  // 正常：只列本机设备，默认设备带后缀，选择回调带出设备
  const opened: string[] = [];
  const entries = workspaceTerminalMenuEntries(t, [
    { ...localDevice("s1"), transport: "ssh", local: null },
    localDevice("l1", true),
    localDevice("l2"),
  ], localWorkspace("/work"), false, (device) => opened.push(device.id));
  assert.deepEqual(entries.map((entry) => entry !== "separator" && entry.label),
    ["l1 (Local · bash) · 默认", "l2 (Local · bash)"]);
  const first = entries[0];
  assert.ok(first !== "separator" && first.onSelect);
  first.onSelect!();
  assert.deepEqual(opened, ["l1"]);

  // 设备工作区：只列托管它的那台设备（SSH/WSL 终端启动后 cd 到工作区目录）
  const ssh: DeviceProfile = {
    ...localDevice("s1"), transport: "ssh", local: null, host: "10.0.0.2", username: "root",
  };
  const hosted = workspaceTerminalMenuEntries(t, [ssh, localDevice("l1")],
    deviceWorkspace("s1", "/srv/app"), false, (device) => opened.push(device.id));
  assert.deepEqual(hosted.map((entry) => entry !== "separator" && entry.label), ["s1 (root@10.0.0.2)"]);
  const hostedEntry = hosted[0];
  assert.ok(hostedEntry !== "separator" && hostedEntry.onSelect);
  hostedEntry.onSelect!();
  assert.deepEqual(opened, ["l1", "s1"]);

  // 设备工作区在本机设备上打开：没有宿主设备可列
  const missing = workspaceTerminalMenuEntries(t, [localDevice("l1")],
    deviceWorkspace("gone", "/srv/app"), false, () => {});
  assert.ok(missing[0] !== "separator" && missing[0].disabled);
});

test("opening a workspace loads the root and expanding a directory loads it once", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(console, "warn", () => {});
  const listed: string[] = [];
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) => {
    listed.push(subdir);
    return subdir === WORKSPACE_ROOT
      ? [{ name: "sub", is_dir: true }, { name: "main.py", is_dir: false }]
      : [{ name: "deep.py", is_dir: false }];
  });
  await useAppStore.getState().setWorkspace(localWorkspace("/work"));
  assert.deepEqual(listed, [""]);
  assert.deepEqual(useAppStore.getState().workspaceTree[""].entries.map((e) => e.name), ["sub", "main.py"]);

  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.deepEqual(listed, ["", "sub"]);
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, true);
  assert.deepEqual(useAppStore.getState().workspaceTree.sub.entries.map((e) => e.name), ["deep.py"]);

  // 折叠再展开复用已加载内容，不重复读取
  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, false);
  await useAppStore.getState().toggleWorkspaceDir("sub");
  assert.deepEqual(listed, ["", "sub"]);
  assert.equal(useAppStore.getState().workspaceTree.sub.expanded, true);
});

test("closing the workspace clears tabs, tree and entry draft without touching disk or recent history", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    ...treeState(),
    recentWorkspaces: [localWorkspace("/work")],
    openTabs: [makeTab("main.py")],
    activeFile: "main.py",
    runDraft: { ...DEFAULT_RUN_DRAFT, entry: "main.py" },
  });
  const listed: string[] = [];
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) => { listed.push(subdir); return []; });
  await useAppStore.getState().setWorkspace(null);
  const state = useAppStore.getState();
  assert.equal(state.workspace, null);
  assert.deepEqual(state.workspaceTree, {});
  assert.deepEqual(state.openTabs, []);
  assert.equal(state.activeFile, null);
  assert.equal(state.runDraft.entry, "");
  assert.deepEqual(state.recentWorkspaces, [localWorkspace("/work")]);
  assert.deepEqual(listed, []);

  // 有未保存修改时复用保存 / 放弃 / 取消确认；取消则保留当前工作区
  useAppStore.setState({ ...treeState(), openTabs: [makeTab("dirty.py", "changed", "saved")], activeFile: "dirty.py" });
  const closing = useAppStore.getState().setWorkspace(null);
  const prompt = useAppStore.getState().changePrompt;
  assert.ok(prompt);
  prompt.resolve("cancel");
  await closing;
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/work"));
});

test("create refreshes the parent directory and surfaces backend errors", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(treeState());
  const created: string[][] = [];
  t.mock.method(api, "createWorkspaceEntry", async (workspace: unknown, name: string, kind: string) => {
    created.push([JSON.stringify(workspace), name, kind]);
  });
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) =>
    subdir === "sub" ? [{ name: "new.py", is_dir: false }] : []);

  assert.equal(await useAppStore.getState().createWorkspaceEntry("sub", "new.py", "file"), true);
  assert.deepEqual(created, [[JSON.stringify(localWorkspace("/work")), "sub/new.py", "file"]]);
  const node = useAppStore.getState().workspaceTree.sub;
  assert.equal(node.expanded, true);
  assert.deepEqual(node.entries.map((e) => e.name), ["new.py"]);
  assert.equal(useAppStore.getState().workspaceMutating, false);

  t.mock.method(api, "createWorkspaceEntry", async () => { throw { code: "exists", message: "同名文件或目录已存在" }; });
  assert.equal(await useAppStore.getState().createWorkspaceEntry("sub", "new.py", "file"), false);
  assert.equal(useAppStore.getState().workspaceError, "同名文件或目录已存在");
  assert.equal(useAppStore.getState().workspaceMutating, false);
  assert.equal(created.length, 1);

  useAppStore.getState().dismissWorkspaceError();
  assert.equal(useAppStore.getState().workspaceError, null);
});

test("generateWorkspaceConfig creates the template, refreshes the root, and opens the file", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState(treeState());
  const called: string[] = [];
  t.mock.method(api, "generateWorkspaceConfig", async (workspace: unknown) => { called.push(JSON.stringify(workspace)); });
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) =>
    subdir === WORKSPACE_ROOT ? [{ name: "pyproject.toml", is_dir: false }] : []);
  t.mock.method(api, "readWorkspaceFile", async (_dir: string, name: string) => {
    assert.equal(name, "pyproject.toml");
    return { content: "[project]\n", revision: "v1", eol: "lf" as const, bom: false };
  });

  assert.equal(await useAppStore.getState().generateWorkspaceConfig(), true);
  assert.deepEqual(called, [JSON.stringify(localWorkspace("/work"))]);
  const state = useAppStore.getState();
  assert.deepEqual(state.workspaceTree[WORKSPACE_ROOT].entries.map((e) => e.name), ["pyproject.toml"]);
  assert.equal(state.activeFile, "pyproject.toml");
  assert.equal(state.workspaceMutating, false);

  // 后端拒绝（配置已存在）时显示错误且不打开文件
  t.mock.method(api, "generateWorkspaceConfig", async () => { throw { code: "exists", message: "同名文件或目录已存在" }; });
  assert.equal(await useAppStore.getState().generateWorkspaceConfig(), false);
  assert.equal(useAppStore.getState().workspaceError, "同名文件或目录已存在");
  assert.equal(useAppStore.getState().workspaceMutating, false);
});

test("workspace changes are refused while a run is preparing, syncing, or stopping", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ ...treeState(), runs: { "run-1": runStatus("syncing") } });
  let calls = 0;
  t.mock.method(api, "createWorkspaceEntry", async () => { calls++; });
  t.mock.method(api, "renameWorkspaceEntry", async () => { calls++; });
  t.mock.method(api, "deleteWorkspaceEntry", async () => { calls++; });
  const state = useAppStore.getState();
  assert.equal(await state.createWorkspaceEntry(WORKSPACE_ROOT, "new.py", "file"), false);
  assert.equal(await state.renameWorkspaceEntry("main.py", "other.py"), false);
  assert.equal(await state.deleteWorkspaceEntry("main.py"), false);
  assert.equal(calls, 0);
  assert.equal(useAppStore.getState().workspaceError, "任务正在准备、同步或停止，请稍后修改工作区");
  assert.equal(useAppStore.getState().workspaceMutating, false);
});

test("rename moves every open tab, entry draft, and cached subtree", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    ...treeState(), openTabs: [makeTab("sub/inner.py", "print(1)"), makeTab("main.py", "main")],
    activeFile: "sub/inner.py", runDraft: { ...DEFAULT_RUN_DRAFT, entry: "sub/inner.py" },
  });
  const renamed: string[][] = [];
  t.mock.method(api, "renameWorkspaceEntry", async (_dir: string, oldName: string, newName: string) => {
    renamed.push([oldName, newName]);
  });
  t.mock.method(api, "listWorkspaceDir", async () => []);

  assert.equal(await useAppStore.getState().renameWorkspaceEntry("sub", "scripts"), true);
  assert.deepEqual(renamed, [["sub", "scripts"]]);
  const state = useAppStore.getState();
  assert.equal(state.activeFile, "scripts/inner.py");
  // 受影响标签跟随移动；未受影响的标签保持不动
  assert.deepEqual(state.openTabs.map((tab) => tab.name), ["scripts/inner.py", "main.py"]);
  assert.equal(state.runDraft.entry, "scripts/inner.py");
  assert.equal(state.workspaceTree.scripts.expanded, true);
  assert.equal(state.workspaceTree.sub, undefined);
  // 内容未变：不重挂载编辑器（代次不变），也不清空缓冲区
  const movedTab = state.openTabs[0];
  assert.equal(movedTab.generation, 1);
  assert.equal(movedTab.fileContent, "print(1)");

  await useAppStore.getState().renameWorkspaceEntry("scripts/inner.py", "inner.sh");
  const renamedTab = useAppStore.getState().openTabs[0];
  assert.equal(renamedTab.name, "scripts/inner.sh");
  assert.equal(renamedTab.language, "shell");
  assert.equal(useAppStore.getState().activeFile, "scripts/inner.sh");
  // 同名重命名是空操作，不访问后端
  assert.equal(await useAppStore.getState().renameWorkspaceEntry("main.py", "main.py"), true);
  assert.equal(renamed.length, 2);
});

test("delete confirms unsaved changes, then closes the affected tabs and drops cached subtree", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({
    ...treeState(), openTabs: [makeTab("main.py", "main"), makeTab("sub/inner.py", "edits", "saved")],
    activeFile: "sub/inner.py", runDraft: { ...DEFAULT_RUN_DRAFT, entry: "sub/inner.py" },
  });
  const deleted: string[] = [];
  t.mock.method(api, "deleteWorkspaceEntry", async (_dir: string, name: string) => { deleted.push(name); });
  t.mock.method(api, "listWorkspaceDir", async () => []);

  const canceled = useAppStore.getState().deleteWorkspaceEntry("sub");
  assert.ok(useAppStore.getState().changePrompt, "包含未保存修改时必须先确认");
  useAppStore.getState().changePrompt!.resolve("cancel");
  await canceled;
  assert.deepEqual(deleted, []);
  assert.equal(useAppStore.getState().activeFile, "sub/inner.py");
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "edits");
  assert.equal(useAppStore.getState().guarding, false);

  const confirmed = useAppStore.getState().deleteWorkspaceEntry("sub");
  useAppStore.getState().changePrompt!.resolve("discard");
  assert.equal(await confirmed, true);
  assert.deepEqual(deleted, ["sub"]);
  const state = useAppStore.getState();
  // 被删子树内的标签移除，活动标签落到未受影响的标签
  assert.deepEqual(state.openTabs.map((tab) => tab.name), ["main.py"]);
  assert.equal(state.activeFile, "main.py");
  assert.equal(state.runDraft.entry, "");
  assert.equal(state.workspaceTree.sub, undefined);
  assert.equal(state.workspaceMutating, false);

  // 与打开文件无关的删除不需要确认，但会清掉指向被删文件的入口草稿
  useAppStore.getState().closeFile("main.py");
  useAppStore.setState({ runDraft: { ...DEFAULT_RUN_DRAFT, entry: "main.py" } });
  assert.equal(await useAppStore.getState().deleteWorkspaceEntry("main.py"), true);
  assert.deepEqual(deleted, ["sub", "main.py"]);
  assert.equal(useAppStore.getState().changePrompt, null);
  assert.equal(useAppStore.getState().runDraft.entry, "");
});

test("a workspace switch discards in-flight directory loads and mutations", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(console, "warn", () => {});
  useAppStore.setState(treeState());
  let finishCreate!: () => void;
  t.mock.method(api, "createWorkspaceEntry", () => new Promise<void>((resolve) => { finishCreate = resolve; }));
  t.mock.method(api, "listWorkspaceDir", async (_dir: string, subdir: string) =>
    subdir === WORKSPACE_ROOT ? [{ name: "other.py", is_dir: false }] : []);

  const creating = useAppStore.getState().createWorkspaceEntry("sub", "late.py", "file");
  assert.equal(useAppStore.getState().workspaceMutating, true);
  const switching = useAppStore.getState().setWorkspace(localWorkspace("/elsewhere"));
  finishCreate();
  await creating;
  await switching;
  const state = useAppStore.getState();
  assert.deepEqual(state.workspace, localWorkspace("/elsewhere"));
  assert.deepEqual(state.workspaceTree[""].entries.map((e) => e.name), ["other.py"]);
  assert.equal(state.workspaceTree.sub, undefined);
  assert.equal(state.workspaceMutating, false);
});
