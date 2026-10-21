import assert from "node:assert/strict";
import test from "node:test";
import { checkForAvailableUpdate, directUpdateAction, formatBytes, formatDownloadProgress, installWithProgress, updateButtonLabel, updateInstallBlocker } from "../src/updateStatus";
import type { AppUpdateInfo } from "../src/api";
import i18n from "../src/i18n";
import { mockIPC } from "@tauri-apps/api/mocks";
import { api } from "../src/api";
import { installCheckedUpdate, startOneClickUpdate } from "../src/updateFlow";
import { useAppStore } from "../src/store";
import { useTerminalStore } from "../src/terminalStore";
import { useTransferStore } from "../src/transferStore";
import { transferApi } from "../src/transferApi";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });

test("installation protects unsaved files and all active run phases", () => {
  const state = { openTabs: [{ fileContent: "saved", savedContent: "saved" }], loading: false, saving: false, starting: false, guarding: false, workspaceMutating: false, runs: {} };
  assert.equal(updateInstallBlocker(state), null);
  assert.match(updateInstallBlocker({ ...state, openTabs: [{ fileContent: "edited", savedContent: "saved" }] })!, /保存/);
  for (const flag of ["loading", "saving", "starting", "guarding", "workspaceMutating"]) assert.ok(updateInstallBlocker({ ...state, [flag]: true }));
  for (const phase of ["preparing", "syncing", "running", "stopping"]) assert.ok(updateInstallBlocker({ ...state, runs: { run: { state: phase } } }));
  assert.equal(updateInstallBlocker({ ...state, runs: { run: { state: "exited" } } }), null);
});

test("progress listener is ready before installing the reviewed version and always cleaned up", async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const result = installWithProgress("0.3.0", async () => { calls.push("listen"); return () => { calls.push("unlisten"); }; }, async (version) => {
      calls.push(version); if (fail) throw new Error("invalid signature");
    });
    if (fail) await assert.rejects(result, /signature/); else await result;
    assert.deepEqual(calls, ["listen", "0.3.0", "unlisten"]);
  }
  await assert.rejects(installWithProgress("0.3.0", async () => { throw new Error("listener failed"); }, async () => { assert.fail("must not install"); }), /listener failed/);
});

test("formatBytes renders human readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(-1), "0 B");
});

test("formatDownloadProgress with known total shows percent", () => {
  assert.equal(formatDownloadProgress(512, 1024), "已下载 512 B / 1.0 KB（50%）");
});

test("formatDownloadProgress clamps percent at 100", () => {
  assert.match(formatDownloadProgress(2048, 1024), /（100%）$/);
});

test("formatDownloadProgress without total shows downloaded only", () => {
  assert.equal(formatDownloadProgress(1024, null), "已下载 1.0 KB");
  assert.equal(formatDownloadProgress(1024, 0), "已下载 1.0 KB");
});

const sampleUpdate: AppUpdateInfo = {
  current_version: "0.3.1",
  latest_version: "0.3.2",
  notes: null,
  published_at: null,
  download_url: "https://github.com/whoarei/remote-runner/releases/latest",
  can_auto_install: true,
};

test("startup check surfaces only an available update", async () => {
  const seen: AppUpdateInfo[] = [];
  await checkForAvailableUpdate(async () => sampleUpdate, (info) => seen.push(info));
  assert.deepEqual(seen, [sampleUpdate]);
  await checkForAvailableUpdate(async () => null, (info) => seen.push(info));
  assert.deepEqual(seen, [sampleUpdate]);
});

test("startup check swallows failures silently", async () => {
  await checkForAvailableUpdate(async () => { throw new Error("offline"); }, () => assert.fail("must not notify on failure"));
});

test("one-click update blocks with reason, falls back to download page, or installs", () => {
  assert.deepEqual(directUpdateAction(sampleUpdate, "请先保存编辑器中的修改，再安装更新。"),
    { kind: "blocked", reason: "请先保存编辑器中的修改，再安装更新。" });
  assert.deepEqual(directUpdateAction({ ...sampleUpdate, can_auto_install: false }, null),
    { kind: "manual", url: sampleUpdate.download_url });
  assert.deepEqual(directUpdateAction(sampleUpdate, null), { kind: "install" });
  // A blocker wins over the portable fallback so the reason is always explained.
  assert.deepEqual(directUpdateAction({ ...sampleUpdate, can_auto_install: false }, "忙"),
    { kind: "blocked", reason: "忙" });
});

test("updateButtonLabel renders each phase compactly", () => {
  assert.equal(updateButtonLabel(null), "更新");
  assert.equal(updateButtonLabel({ kind: "checking" }), "正在检查…");
  assert.equal(updateButtonLabel({ kind: "closingTerminals" }), "正在关闭终端…");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 512, total: 1024 }), "下载中 50%");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 2048, total: 1024 }), "下载中 100%");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 1024, total: null }), "下载中 1.0 KB");
  assert.equal(updateButtonLabel({ kind: "downloading", downloaded: 1024, total: 0 }), "下载中 1.0 KB");
  assert.equal(updateButtonLabel({ kind: "verifying" }), "验证签名…");
  assert.equal(updateButtonLabel({ kind: "installing" }), "正在安装…");
});

function updateSetup(t: test.TestContext, active = true) {
  const app = useAppStore.getState(), terminals = useTerminalStore.getState(), transfers = useTransferStore.getState();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { crypto: globalThis.crypto } });
  useAppStore.setState({ updating: false, openTabs: [], loading: false, saving: false, starting: false,
    guarding: false, workspaceMutating: false, runs: {}, editorError: null });
  useTerminalStore.setState({ tabs: active ? [{ id: "terminal", deviceId: "local", deviceName: "Local", busy: false,
    status: { session_id: "session", device_name: "Local", state: "connected", exit_code: null, error: null } }] : [],
    activeTab: active ? "terminal" : "run", shuttingDown: false });
  useTransferStore.setState({ tasks: [] });
  t.mock.method(transferApi, "snapshot", async () => []);
  t.after(() => {
    useAppStore.setState(app, true); useTerminalStore.setState(terminals, true); useTransferStore.setState(transfers, true);
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("cancelling update confirmation preserves terminals and never starts installation", async (t) => {
  updateSetup(t);
  const tabs = useTerminalStore.getState().tabs;
  let prompts = 0;
  mockIPC((command, args) => {
    assert.equal(command, "plugin:dialog|message");
    assert.match(args!.message as string, /关闭所有终端/);
    prompts++;
    return i18n.t("dialog.cancel");
  });
  const close = t.mock.method(api, "closeAllTerminals", async () => { assert.fail("must not close"); });
  const install = t.mock.method(api, "installAppUpdate", async () => { assert.fail("must not install"); });
  const phases: string[] = [];
  await installCheckedUpdate(sampleUpdate, (phase) => phases.push(phase.kind));
  assert.equal(prompts, 1);
  assert.equal(useTerminalStore.getState().tabs, tabs);
  assert.equal(close.mock.callCount(), 0);
  assert.equal(install.mock.callCount(), 0);
  assert.deepEqual(phases, []);
  assert.equal(useAppStore.getState().updating, false);
});

for (const entry of ["checked", "one-click"] as const) {
  test(`${entry} update waits for confirmed terminal cleanup before installing`, async (t) => {
    updateSetup(t);
    const calls: string[] = [];
    mockIPC((command) => {
      assert.equal(command, "plugin:dialog|message");
      calls.push("confirm");
      return i18n.t("update.closeTerminalsAndInstall");
    }, { shouldMockEvents: true });
    t.mock.method(api, "checkAppUpdate", async () => sampleUpdate);
    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    t.mock.method(api, "closeAllTerminals", () => {
      calls.push("close"); cleanupStarted();
      return new Promise<void>((resolve) => { finishCleanup = resolve; });
    });
    t.mock.method(api, "installAppUpdate", async (version) => {
      assert.equal(version, sampleUpdate.latest_version);
      assert.equal(useTerminalStore.getState().tabs.length, 0);
      calls.push("install");
      throw new Error("installer reached");
    });
    const phases: string[] = [];
    const pending = entry === "checked"
      ? assert.rejects(installCheckedUpdate(sampleUpdate, (phase) => phases.push(phase.kind)), /installer reached/)
      : startOneClickUpdate(sampleUpdate, (phase) => { if (phase) phases.push(phase.kind); });
    await started;
    assert.deepEqual(calls, ["confirm", "close"]);
    assert.equal(phases.at(-1), "closingTerminals");
    assert.equal(useAppStore.getState().updating, true);
    await assert.rejects(useTerminalStore.getState().open("local", "Local"), /升级/);
    // A second entry point cannot prompt, close, or install during cleanup.
    await installCheckedUpdate(sampleUpdate, () => assert.fail("already updating"));
    finishCleanup();
    await pending;
    assert.deepEqual(calls, ["confirm", "close", "install"]);
    assert.equal(useAppStore.getState().updating, false);
    assert.equal(useTerminalStore.getState().shuttingDown, false);
  });
}

test("failed terminal cleanup preserves tabs and aborts update before installation", async (t) => {
  updateSetup(t);
  mockIPC(() => i18n.t("update.closeTerminalsAndInstall"));
  t.mock.method(api, "closeAllTerminals", async () => { throw new Error("cleanup timed out"); });
  const install = t.mock.method(api, "installAppUpdate", async () => { assert.fail("must not install"); });
  await assert.rejects(installCheckedUpdate(sampleUpdate, () => {}), /cleanup timed out/);
  assert.equal(install.mock.callCount(), 0);
  assert.equal(useTerminalStore.getState().tabs.length, 1);
  assert.equal(useTerminalStore.getState().shuttingDown, false);
  assert.equal(useAppStore.getState().updating, false);
});

test("update without active terminals proceeds without a confirmation", async (t) => {
  updateSetup(t, false);
  mockIPC(() => { assert.fail("no confirmation needed"); }, { shouldMockEvents: true });
  t.mock.method(api, "closeAllTerminals", async () => {});
  const install = t.mock.method(api, "installAppUpdate", async () => { throw new Error("installer reached"); });
  await assert.rejects(installCheckedUpdate(sampleUpdate, () => {}), /installer reached/);
  assert.equal(install.mock.callCount(), 1);
});

test("update rechecks blockers after confirmation before closing terminals", async (t) => {
  updateSetup(t);
  mockIPC(() => {
    useAppStore.setState({ runs: { run: { state: "running" } } as ReturnType<typeof useAppStore.getState>["runs"] });
    return i18n.t("update.closeTerminalsAndInstall");
  });
  const close = t.mock.method(api, "closeAllTerminals", async () => { assert.fail("must not close"); });
  await assert.rejects(installCheckedUpdate(sampleUpdate, () => {}), /运行任务/);
  assert.equal(close.mock.callCount(), 0);
  assert.equal(useAppStore.getState().updating, false);
});
