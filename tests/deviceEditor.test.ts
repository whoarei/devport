import test from "node:test";
import assert from "node:assert/strict";
import { api, deviceWorkspace, localWorkspace, type DeviceProfile } from "../src/api";
import { useAppStore } from "../src/store";
import { useTransferStore } from "../src/transferStore";
import { dirtyTab, type EditorTab } from "../src/editorDocument";
import { editorFileKey, editorFileTitle } from "../src/editorSources";
import { appCommandEnabled } from "../src/appCommands";
import { performDeviceFileAction } from "../src/transferFileActions";
import { transferApi, type TransferPlan } from "../src/transferApi";
import { createEnvironmentController } from "../src/workEnvironment";
import { emptyEnvironment, type WorkEnvironment } from "../src/environmentState";
import i18n from "../src/i18n";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "../src/components/Editor";

test.before(async () => { await i18n.changeLanguage("zh"); });
const local = localWorkspace("C:\\source");
const remote = deviceWorkspace("a", "/srv/project");
const device = (id: string): DeviceProfile => ({ id, name: `Device ${id}`, revision: `revision-${id}`, transport: "ssh", is_default: false,
  host: "example", port: 22, username: "user", auth: { type: "key", key_path: null }, workspace_root: "/srv" });
const doc = (content = "base", revision = "v1") => ({ content, revision, eol: "lf" as const, bom: false });
const localTab = (): EditorTab => ({ name: "main.py", fileContent: "local draft", savedContent: "local saved", revision: "local-v1", eol: "lf", bom: false, language: "python", conflict: false, generation: 1, preview: true });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function reset(t: test.TestContext) {
  const app = useAppStore.getState(), transfer = useTransferStore.getState();
  useAppStore.setState({ workspace: local, openTabs: [localTab()], activeFile: "main.py", devices: [device("a"), device("b")], selectedDeviceId: "a",
    loading: false, saving: false, guarding: false, starting: false, updating: false, workspaceMutating: false, runs: {}, workspaceTree: {}, editorError: null, workspaceError: null, changePrompt: null });
  useTransferStore.setState({ deviceMutating: false, planning: false, plan: null, tasks: [], registeredIds: [] });
  const read = t.mock.method(api, "readDeviceEditorFile", async () => doc());
  const write = t.mock.method(api, "writeDeviceEditorFile", async () => ({ revision: "v2" }));
  t.mock.method(api, "listWorkspaceDir", async () => []);
  t.mock.method(api, "readWorkspaceFile", async () => doc("local saved", "local-v1"));
  t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "local-v2" }));
  t.mock.method(api, "renameWorkspaceCommands", async () => {});
  t.after(() => { useAppStore.setState(app, true); useTransferStore.setState(transfer, true); });
  return { read, write };
}

test("local and same-named device files coexist and save to their own fixed origins", async (t) => {
  const { read, write } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  await useAppStore.getState().openDeviceFile(deviceWorkspace("b", "/srv/project"), "main.py");
  const state = useAppStore.getState();
  assert.deepEqual(state.workspace, local);
  assert.equal(state.openTabs.length, 3);
  assert.equal(state.openTabs[0].fileContent, "local draft");
  assert.equal(new Set(state.openTabs.map((tab) => tab.name)).size, 3);
  assert.equal(state.openTabs[1].language, "python");
  assert.deepEqual(read.mock.calls[0].arguments, [remote, "main.py", "revision-a"]);
  const a = state.openTabs[1];
  state.editContent(a.name, "remote draft");
  state.selectDevice("b");
  assert.equal(await useAppStore.getState().saveFile(a.name), true);
  assert.deepEqual(write.mock.calls[0].arguments, [{ workspace: remote, name: "main.py", content: "remote draft", expectedRevision: "v1", eol: "lf", bom: false }, "revision-a"]);
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "local draft");
  assert.equal(editorFileTitle(a, state.devices), "Device a:/srv/project/main.py");
});

test("opening the same physical device file through different roots reuses its tab", async (t) => {
  const { read } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "unsaved");
  await useAppStore.getState().openDeviceFile(deviceWorkspace("a", "/srv"), "project/main.py");
  assert.equal(useAppStore.getState().activeFile, id);
  assert.equal(useAppStore.getState().openTabs.length, 2);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "unsaved");
});

test("device files persist while switching or closing the main workspace and save without any main workspace", async (t) => {
  const { write } = reset(t);
  useAppStore.setState({ openTabs: [], activeFile: null });
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "device draft");
  const prompt = t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => { assert.fail("a workspace switch must not prompt for independent device buffers"); });
  await useAppStore.getState().setWorkspace(localWorkspace("C:\\other"));
  await useAppStore.getState().setWorkspace(null);
  assert.equal(prompt.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs[0].fileContent, "device draft");
  assert.equal(appCommandEnabled("saveFile"), true);
  assert.equal(appCommandEnabled("saveAll"), true);
  assert.equal(await useAppStore.getState().saveFile(), true);
  assert.equal(write.mock.calls[0].arguments[0].workspace, remote);
});

test("the workspace and device trees share an existing buffer without duplicate tabs", async (t) => {
  const { read } = reset(t);
  useAppStore.setState({ workspace: remote, openTabs: [{ ...localTab(), preview: false }] });
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  assert.equal(useAppStore.getState().activeFile, "main.py");
  assert.equal(read.mock.callCount(), 0);
  useAppStore.setState({ openTabs: [], activeFile: null });
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile;
  await useAppStore.getState().openWorkspaceFile("main.py");
  assert.equal(useAppStore.getState().activeFile, id);
  assert.equal(useAppStore.getState().openTabs.length, 1);
});

test("device save conflicts retain drafts and reload reads the fixed device source", async (t) => {
  const { write, read } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "my edits");
  t.mock.method(api, "writeDeviceEditorFile", async () => { throw { code: "conflict", message: "changed on device" }; });
  assert.equal(await useAppStore.getState().saveFile(id), false);
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "my edits");
  assert.equal(useAppStore.getState().openTabs[1].conflict, true);
  t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => true);
  t.mock.method(api, "readDeviceEditorFile", async () => doc("latest on device", "v3"));
  await useAppStore.getState().reloadFile();
  const tab = useAppStore.getState().openTabs[1];
  assert.equal(tab.fileContent, "latest on device");
  assert.equal(tab.revision, "v3");
  assert.equal(dirtyTab(tab), false);
});

test("changing device configuration blocks saves, preserves contents and still permits discard-and-close", async (t) => {
  const { write } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "important draft");
  useAppStore.setState({ devices: [{ ...device("a"), revision: "new connection" }] });
  assert.equal(await useAppStore.getState().saveFile(id), false);
  assert.equal(write.mock.callCount(), 0);
  assert.match(useAppStore.getState().editorError!, /设备连接配置已变化/);
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "important draft");
  const closing = useAppStore.getState().closeFile(id);
  useAppStore.getState().changePrompt!.resolve("discard");
  await closing;
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["main.py"]);
});

test("typing while a device save is pending remains dirty after that save completes", async (t) => {
  reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "first edits");
  const response = deferred<{ revision: string }>();
  t.mock.method(api, "writeDeviceEditorFile", () => response.promise);
  const saving = useAppStore.getState().saveFile(id);
  useAppStore.getState().editContent(id, "later edits");
  response.resolve({ revision: "saved-first" });
  assert.equal(await saving, true);
  const tab = useAppStore.getState().openTabs[1];
  assert.equal(tab.savedContent, "first edits");
  assert.equal(tab.fileContent, "later edits");
  assert.equal(dirtyTab(tab), true);
});

test("a device configuration change during a read cannot create a tab from the obsolete response", async (t) => {
  reset(t);
  const response = deferred<ReturnType<typeof doc>>();
  t.mock.method(api, "readDeviceEditorFile", () => response.promise);
  const opening = useAppStore.getState().openDeviceFile(remote, "main.py");
  useAppStore.setState({ devices: [{ ...device("a"), revision: "changed" }] });
  response.resolve(doc());
  await opening;
  assert.equal(useAppStore.getState().openTabs.length, 1);
  assert.match(useAppStore.getState().editorError!, /设备连接配置已变化/);
});

test("renaming a directory updates independent file identities and later saves use the moved path", async (t) => {
  const { write } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  useAppStore.getState().editContent(useAppStore.getState().activeFile!, "draft");
  t.mock.method(api, "renameWorkspaceEntry", async () => {});
  const result = await performDeviceFileAction(deviceWorkspace("a", "/srv"), "", { type: "rename", name: "project", newName: "moved" }, () => true, (error) => assert.fail(error));
  assert.equal(result.success, true);
  const tab = useAppStore.getState().openTabs[1];
  assert.equal(tab.source!.path, "moved/main.py");
  assert.equal(tab.fileContent, "draft");
  assert.equal(tab.name, useAppStore.getState().activeFile);
  assert.equal(await useAppStore.getState().saveFile(), true);
  assert.equal(write.mock.calls[0].arguments[0].name, "moved/main.py");
  assert.deepEqual(write.mock.calls[0].arguments[0].workspace, deviceWorkspace("a", "/srv"));
});

test("deleting an independent dirty file honors cancel and confirmation while preserving local tabs", async (t) => {
  reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  useAppStore.getState().editContent(useAppStore.getState().activeFile!, "draft");
  const remove = t.mock.method(api, "deleteWorkspaceEntry", async () => {});
  let answer = false;
  t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => answer);
  const action = { type: "delete" as const, name: "main.py" };
  assert.equal((await performDeviceFileAction(remote, "", action, () => true, (error) => assert.fail(error))).success, false);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(useAppStore.getState().openTabs.length, 2);
  answer = true;
  assert.equal((await performDeviceFileAction(remote, "", action, () => true, (error) => assert.fail(error))).success, true);
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["main.py"]);
  assert.equal(useAppStore.getState().activeFile, "main.py");
});

test("device editor tabs are protected from transfer overwrite and cannot run against the local workspace", async (t) => {
  reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  assert.equal(appCommandEnabled("runFile", { area: "editor", filePath: "main.py" }), false);
  const attributes = { kind: "file", size: 4, modified: "", mode: null, identity: "" };
  useTransferStore.setState({ local: { ...useTransferStore.getState().local, endpoint: local, directory: { endpoint: local, entries: [{ name: "main.py", ...attributes }], overwrite: true }, selected: ["main.py"], loading: false },
    device: { ...useTransferStore.getState().device, endpoint: remote, directory: { endpoint: remote, entries: [], overwrite: true }, loading: false } });
  // Only the device file is clean; the unrelated local draft is not selected for download.
  useAppStore.setState({ openTabs: useAppStore.getState().openTabs.map((tab) => ({ ...tab, savedContent: tab.fileContent })) });
  const plan = t.mock.method(transferApi, "plan", async () => ({} as TransferPlan));
  await useTransferStore.getState().prepare("local", false);
  assert.deepEqual(plan.mock.calls[0].arguments[0].protected_paths, ["main.py"]);
});

test("restart restores mixed local/device tabs and drafts, reading the active device file only", async (t) => {
  reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "recovered device draft");
  let saved: WorkEnvironment = emptyEnvironment();
  const capturing = createEnvironmentController({ read: async () => emptyEnvironment(), write: async (value) => { saved = structuredClone(value); } });
  t.after(() => capturing.stop());
  await capturing.start();
  await capturing.flush();
  capturing.stop();
  assert.equal(saved.device_files!.length, 1);
  assert.equal(saved.device_files![0].source!.path, "main.py");
  assert.equal(saved.workspaces[0].files.length, 1);
  assert.equal(saved.workspaces[0].files[0].name, "main.py");
  assert.equal(saved.active_device_file, id);
  useAppStore.setState({ workspace: null, openTabs: [], activeFile: null, workspaceTree: {}, loading: false });
  const read = t.mock.method(api, "readDeviceEditorFile", async () => doc());
  const normalRead = t.mock.method(api, "readWorkspaceFile", async () => { assert.fail("the inactive local file should restore lazily"); });
  const restoring = createEnvironmentController({ read: async () => saved, write: async () => {} });
  t.after(() => restoring.stop());
  await restoring.start();
  assert.deepEqual(useAppStore.getState().workspace, local);
  assert.equal(useAppStore.getState().openTabs.length, 2);
  assert.equal(useAppStore.getState().activeFile, id);
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "recovered device draft");
  assert.equal(useAppStore.getState().openTabs[0].loaded, false);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(normalRead.mock.callCount(), 0);
});

test("file tabs keep their type icons and add compact device names with full origin tooltips", async (t) => {
  reset(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const html = renderToStaticMarkup(createElement(Editor));
  assert.equal((html.match(/file-icon-code/g) ?? []).length, 2);
  assert.equal((html.match(/class="editor-tab-device"/g) ?? []).length, 1);
  assert.match(html, /class="editor-tab-name">main\.py<\/span><span class="editor-tab-device" aria-hidden="true">· Device a<\/span>/);
  assert.match(html, /title="Device a:\/srv\/project\/main.py"/);
  useAppStore.setState({ workspace: remote, openTabs: [localTab()], activeFile: "main.py" });
  const workspaceHtml = renderToStaticMarkup(createElement(Editor));
  assert.match(workspaceHtml, /file-icon-code/);
  assert.match(workspaceHtml, /class="editor-tab-device" aria-hidden="true">· Device a<\/span>/);
  const wsl = { ...device("a"), name: "wsl-dev@Ubuntu-24.04", transport: "wsl" as const };
  useAppStore.setState({ devices: [wsl] });
  assert.match(renderToStaticMarkup(createElement(Editor)), /class="editor-tab-device" aria-hidden="true">· Ubuntu-24.04<\/span>/);
  useAppStore.setState({ devices: [wsl, { ...wsl, id: "b", name: "wsl-root@Ubuntu-24.04" }] });
  assert.match(renderToStaticMarkup(createElement(Editor)), /class="editor-tab-device" aria-hidden="true">· wsl-dev@Ubuntu-24.04<\/span>/);
});

test("running a local workspace saves its own buffers without contacting unrelated device drafts", async (t) => {
  const { write } = reset(t);
  await useAppStore.getState().openDeviceFile(remote, "main.py");
  const id = useAppStore.getState().activeFile!;
  useAppStore.getState().editContent(id, "unrelated device draft");
  t.mock.method(api, "runScript", async () => "local-run");
  t.mock.method(api, "getRunStatus", async () => null);
  assert.equal(await useAppStore.getState().startRun({ workspace: local, device_id: "a", kind: "python", entry: "main.py", console_mode: "pipe" }), "local-run");
  assert.equal(write.mock.callCount(), 0);
  assert.equal(dirtyTab(useAppStore.getState().openTabs[1]), true);
});

test("restoring independent drafts preserves a local workspace already selected by the user", async (t) => {
  reset(t);
  const source = { workspace: remote, path: "main.py", device_revision: "revision-a" };
  const name = editorFileKey(source);
  const snapshot: WorkEnvironment = { ...emptyEnvironment(), device_files: [{ name, source, language: "python", draft: { content: "saved device draft", saved_content: "base", revision: "v1", eol: "lf", bom: false } }], active_device_file: name };
  const controller = createEnvironmentController({ read: async () => snapshot, write: async () => {} });
  t.after(() => controller.stop());
  await controller.start();
  assert.deepEqual(useAppStore.getState().workspace, local);
  assert.equal(useAppStore.getState().activeFile, "main.py");
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "saved device draft");
  assert.equal(useAppStore.getState().openTabs[1].loaded, false);
});

test("main workspace directory mutations also follow independent device buffers", async (t) => {
  reset(t);
  useAppStore.setState({ workspace: remote });
  await useAppStore.getState().openDeviceFile(remote, "src/main.py");
  useAppStore.getState().editContent(useAppStore.getState().activeFile!, "device draft");
  t.mock.method(api, "renameWorkspaceEntry", async () => {});
  t.mock.method(api, "deleteWorkspaceEntry", async () => {});
  assert.equal(await useAppStore.getState().renameWorkspaceEntry("src", "moved"), true);
  assert.equal(useAppStore.getState().openTabs[1].source!.path, "moved/main.py");
  assert.equal(useAppStore.getState().openTabs[1].fileContent, "device draft");
  t.mock.method(useAppStore.getState(), "confirmUnsaved", async () => true);
  assert.equal(await useAppStore.getState().deleteWorkspaceEntry("moved"), true);
  assert.deepEqual(useAppStore.getState().openTabs.map((tab) => tab.name), ["main.py"]);
});
