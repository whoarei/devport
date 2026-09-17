import test from "node:test";
import assert from "node:assert/strict";
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
import { managedPythonBlocked } from "../src/components/RunToolbar";
import {
  RemoteWorkspaceDialog, isDevicePath, joinDevicePath, parentDevicePath,
} from "../src/components/RemoteWorkspaceDialog";

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

test("in-place runs on the workspace device disable managed python", () => {
  assert.ok(managedPythonBlocked("d1", "d1"));
  assert.ok(!managedPythonBlocked("d1", "d2"));
  assert.ok(!managedPythonBlocked(null, "d1"));
  assert.ok(!managedPythonBlocked(null, null));
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

  // 有宿主设备：设备下拉 + 路径输入；路径为空时不能打开
  useAppStore.setState({ remoteWorkspaceDialogOpen: true, devices: [sshDevice("d1", { name: "board" })] });
  const html = render();
  assert.match(html, /宿主设备/);
  assert.match(html, /设备上的目录/);
  assert.match(html, /board · ssh/);
  assert.match(html, /disabled=""[^>]*>打开</);
});
