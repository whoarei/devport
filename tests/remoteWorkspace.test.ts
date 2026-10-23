import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  api, deviceWorkspace, isRemoteWorkspaceHost, localWorkspace, workspaceRefEquals,
  type DeviceProfile,
} from "../src/api";
import { useAppStore, workspaceLabel } from "../src/store";
import i18n from "../src/i18n";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });
import {
  RemoteWorkspaceDialog, isDevicePath, joinDevicePath, parentDevicePath, resolveDeviceWorkspacePath,
} from "../src/components/RemoteWorkspaceDialog";
import { transferApi } from "../src/transferApi";
import { DirectoryListingCache, directoryCompletionQuery, directorySuggestions } from "../src/directoryCompletion";

const sshDevice = (id: string, extra: Partial<DeviceProfile> = {}): DeviceProfile => ({
  id, name: id, is_default: false, transport: "ssh",
  host: "10.0.0.2", port: 22, username: "root", auth: { type: "key", key_path: null },
  workspace_root: "/srv/app", ...extra,
});

test("workspace references compare structurally and classify their host", () => {
  assert.ok(workspaceRefEquals(localWorkspace("/work"), { type: "local", dir: "/work" }));
  assert.ok(!workspaceRefEquals(localWorkspace("/work"), localWorkspace("/other")));
  assert.ok(!workspaceRefEquals(localWorkspace("/work"), deviceWorkspace("d1", "/work")));
  assert.ok(workspaceRefEquals(deviceWorkspace("d1", "/srv"), { type: "device", device_id: "d1", path: "/srv" }));
  assert.ok(!workspaceRefEquals(deviceWorkspace("d1", "/srv"), deviceWorkspace("d2", "/srv")));
  assert.ok(!workspaceRefEquals(deviceWorkspace("d1", "/srv"), deviceWorkspace("d1", "/srv/app")));
  // null 与 undefined 等价：未打开工作区时相当于「无变化」
  assert.ok(workspaceRefEquals(null, null));
  assert.ok(workspaceRefEquals(null, undefined));
  assert.ok(!workspaceRefEquals(null, localWorkspace("/work")));
  assert.ok(!workspaceRefEquals(localWorkspace("/work"), null));

  assert.ok(isRemoteWorkspaceHost(sshDevice("s1")));
  assert.ok(isRemoteWorkspaceHost({ ...sshDevice("w1"), transport: "wsl", wsl: { distribution: "Ubuntu", user: "" } }));
  // 串口没有文件操作通道，本机设备不需要远端文件服务
  assert.ok(!isRemoteWorkspaceHost({ ...sshDevice("p1"), transport: "serial" }));
  assert.ok(!isRemoteWorkspaceHost({ ...sshDevice("l1"), transport: "local" }));
});

test("workspace labels show the path locally and device:/path remotely", () => {
  const devices = [sshDevice("d1", { name: "board" })];
  assert.equal(workspaceLabel(localWorkspace("D:\\proj"), devices), "D:\\proj");
  assert.equal(workspaceLabel(deviceWorkspace("d1", "/srv/app"), devices), "board:/srv/app");
  // 设备已被删除时退回设备 id，标签仍然可读
  assert.equal(workspaceLabel(deviceWorkspace("gone", "/srv/app"), devices), "gone:/srv/app");
  assert.equal(workspaceLabel(null, devices), null);
});

test("device path helpers mirror the backend path rules", () => {
  assert.ok(isDevicePath("/srv/app"));
  assert.ok(isDevicePath("/"));
  assert.ok(isDevicePath("/srv/my.project"));       // 点号只作为独立组件被拒绝
  for (const bad of ["relative", "", "/a/../b", "/a/./b", "/a\nb"]) {
    assert.ok(!isDevicePath(bad), `should reject ${JSON.stringify(bad)}`);
  }

  assert.equal(parentDevicePath("/srv/app"), "/srv");
  assert.equal(parentDevicePath("/srv/app/"), "/srv");
  assert.equal(parentDevicePath("/srv"), "/");
  assert.equal(parentDevicePath("/"), "/");
  assert.equal(joinDevicePath("/srv", "app"), "/srv/app");
  assert.equal(joinDevicePath("/", "app"), "/app");
  assert.equal(joinDevicePath("/srv/", "app"), "/srv/app");
});

test("workspace picker resolves home defaults before using absolute workspace paths", async (t) => {
  const calls: unknown[] = [];
  t.mock.method(transferApi, "list", async (endpoint) => {
    calls.push(endpoint);
    return { endpoint: deviceWorkspace("d1", "/srv/custom user/devrunner/workspaces"), entries: [], overwrite: true };
  });
  const resolved = await resolveDeviceWorkspacePath("d1", "~/devrunner/workspaces");
  assert.equal(resolved, "/srv/custom user/devrunner/workspaces");
  assert.ok(isDevicePath(resolved));
  assert.deepEqual(calls, [deviceWorkspace("d1", "~/devrunner/workspaces")]);
  assert.equal(await resolveDeviceWorkspacePath("d1", "/tmp/devrunner/workspaces"), "/tmp/devrunner/workspaces");
  assert.equal(calls.length, 1);
});

test("opening a device workspace releases the previous remote session", async (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(console, "warn", () => {});
  t.mock.method(api, "listWorkspaceDir", async () => [{ name: "main.py", is_dir: false }]);
  let closed = 0;
  t.mock.method(api, "closeWorkspaceSession", async () => { closed++; });

  await useAppStore.getState().setWorkspace(deviceWorkspace("d1", "/srv/app"));
  const state = useAppStore.getState();
  assert.deepEqual(state.workspace, deviceWorkspace("d1", "/srv/app"));
  assert.deepEqual(state.workspaceTree[""].entries.map((entry) => entry.name), ["main.py"]);
  assert.deepEqual(state.recentWorkspaces[0], deviceWorkspace("d1", "/srv/app"));
  // 首次打开没有可释放的会话
  assert.equal(closed, 0);

  // 切换到另一台设备工作区：释放旧会话，避免后端停留在旧设备上
  await useAppStore.getState().setWorkspace(deviceWorkspace("d2", "/srv/other"));
  assert.equal(closed, 1);

  // 关闭工作区同样释放
  await useAppStore.getState().setWorkspace(null);
  assert.equal(closed, 2);
  assert.equal(useAppStore.getState().workspace, null);

  // 本机工作区之间切换不触碰远端会话
  await useAppStore.getState().setWorkspace(localWorkspace("/a"));
  await useAppStore.getState().setWorkspace(localWorkspace("/b"));
  assert.equal(closed, 2);
});

test("remote workspace dialog renders the host picker and the no-device hint", (t) => {
  const previous = useAppStore.getState();
  t.after(() => useAppStore.setState(previous, true));
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  const render = () => renderToStaticMarkup(createElement(RemoteWorkspaceDialog));

  // 对话框关闭时不渲染任何内容
  useAppStore.setState({ remoteWorkspaceDialogOpen: false, devices: [sshDevice("d1")] });
  assert.equal(render(), "");

  // 没有 SSH/WSL 设备时给出提示而不是空的设备下拉
  useAppStore.setState({ remoteWorkspaceDialogOpen: true, devices: [{ ...sshDevice("s1"), transport: "serial" }] });
  const empty = render();
  assert.match(empty, /打开设备工作区/);
  assert.match(empty, /没有可作为工作区宿主的设备/);
  assert.doesNotMatch(empty, /宿主设备/);

  // 精简目录选择器保留设备、路径和操作，删去重复导航及说明。
  useAppStore.setState({ remoteWorkspaceDialogOpen: true, devices: [sshDevice("d1", { name: "board" })] });
  const html = render();
  assert.match(html, /宿主设备/);
  assert.match(html, /设备上的目录/);
  assert.match(html, /board · SSH/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /打开工作区/);
  assert.doesNotMatch(html, /在设备上就地打开|已选择的目录|支持路径补全/);
});

/** 取出样式表中某个选择器的规则体（第一个匹配的规则块） */
function cssRule(stylesheet: string, selector: string): string {
  const index = stylesheet.indexOf(`${selector} {`);
  assert.ok(index >= 0, `${selector} has no rule in styles.css`);
  return stylesheet.slice(index, stylesheet.indexOf("}", index));
}

test("the directory browser in the dialog is actually scrollable", () => {
  // 目录项可能成百上千：列表必须有高度上限和自己的滚动条，
  // 否则会被对话框裁掉且无法选择（这类问题只能在浏览器里看出来，
  // 所以这里用样式断言兜底）。
  // 测试以仓库根目录为工作目录运行（esbuild 打包后没有 import.meta.url）
  const stylesheet = readFileSync("src/components/RemoteWorkspaceDialog.css", "utf8");
  const list = cssRule(stylesheet, ".remote-directory-list");
  assert.match(list, /max-height:\s*\d/, "list needs a bounded height");
  assert.match(list, /overflow(-y)?:\s*(auto|scroll)/, "list needs its own scrollbar");

  // 内容仍然高于视口时，对话框自身也要能滚动
  const modal = cssRule(stylesheet, ".remote-workspace-dialog");
  assert.match(modal, /max-height:/, "modal needs a height cap");
  assert.match(modal, /overflow:\s*(auto|scroll)/, "modal must scroll instead of clipping");

  // 长目录名不撑破布局
  const item = cssRule(stylesheet, ".remote-directory-name > span");
  assert.match(item, /text-overflow:\s*ellipsis/);
  assert.match(item, /overflow:\s*hidden/);
});

test("directory completion splits POSIX, device HOME, Windows and UNC paths at their last component", () => {
  const remote = deviceWorkspace("d1", "/srv");
  assert.deepEqual(directoryCompletionQuery(remote, "/srv/pro"), { endpoint: deviceWorkspace("d1", "/srv"), prefix: "pro", windows: false });
  assert.deepEqual(directoryCompletionQuery(remote, "/srv/"), { endpoint: deviceWorkspace("d1", "/srv"), prefix: "", windows: false });
  assert.deepEqual(directoryCompletionQuery(remote, "/"), { endpoint: deviceWorkspace("d1", "/"), prefix: "", windows: false });
  assert.deepEqual(directoryCompletionQuery(remote, "~/pro"), { endpoint: deviceWorkspace("d1", "~/"), prefix: "pro", windows: false });
  assert.deepEqual(directoryCompletionQuery(localWorkspace("C:\\work"), "C:\\Program Fi"), { endpoint: localWorkspace("C:\\"), prefix: "Program Fi", windows: true });
  assert.deepEqual(directoryCompletionQuery(localWorkspace("C:/work"), "C:/work/pro"), { endpoint: localWorkspace("C:/work"), prefix: "pro", windows: true });
  assert.deepEqual(directoryCompletionQuery(localWorkspace("\\\\host\\share"), "\\\\host\\share\\pro"), { endpoint: localWorkspace("\\\\host\\share"), prefix: "pro", windows: true });
  assert.equal(directoryCompletionQuery(localWorkspace("C:\\"), "\\\\host\\sh"), null);
  for (const bad of ["", "relative", "/a/../b", "/a/./b", "/a\nb", "C:\\folder"]) assert.equal(directoryCompletionQuery(remote, bad), null, bad);
});

test("directory suggestions use resolved paths, preserve spaces and skip links and files", () => {
  const entries = ["project 2", "project 10", "Projects"].map((name) => ({ name, kind: "dir", size: 0, modified: "", mode: null, identity: "" }));
  const directory = { endpoint: deviceWorkspace("d1", "/real home"), overwrite: true, entries: [...entries,
    { ...entries[0], name: "project-link", kind: "link" }, { ...entries[0], name: "project.py", kind: "file" }] };
  assert.deepEqual(directorySuggestions(directory, "pro"), ["/real home/project 2", "/real home/project 10"]);
  assert.deepEqual(directorySuggestions({ ...directory, endpoint: localWorkspace("C:\\work") }, "PRO", true), ["C:\\work\\project 2", "C:\\work\\project 10", "C:\\work\\Projects"]);
});

test("completion listings coalesce parent reads, isolate hosts, refresh and retry failures", async (t) => {
  const calls: unknown[] = [];
  let fail = false;
  t.mock.method(transferApi, "list", async (endpoint) => {
    calls.push(endpoint);
    if (fail) throw new Error("offline");
    return { endpoint, entries: [], overwrite: true };
  });
  const cache = new DirectoryListingCache();
  const first = deviceWorkspace("d1", "/srv");
  const pending = cache.list(first);
  assert.equal(cache.list(first), pending);
  await pending;
  await cache.list(first);
  assert.equal(calls.length, 1);
  await cache.list(deviceWorkspace("d2", "/srv"));
  await cache.list(localWorkspace("/srv"));
  assert.equal(calls.length, 3);
  await cache.list(first, true);
  assert.equal(calls.length, 4);
  cache.seed({ endpoint: first, entries: [], overwrite: true });
  await cache.list(first);
  assert.equal(calls.length, 4);
  cache.clear(); fail = true;
  await assert.rejects(cache.list(first), /offline/);
  fail = false;
  await cache.list(first);
  assert.equal(calls.length, 6);
});
