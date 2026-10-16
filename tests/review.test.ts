import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, localWorkspace, RunStatus } from "../src/api";
import { useAppStore } from "../src/store";
import { panelVisibilityPatch } from "../src/layoutState";
import i18n from "../src/i18n";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { RunToolbar } from "../src/components/RunToolbar";
import { MAX_OUTPUT_BYTES, MAX_TOTAL_OUTPUT_BYTES } from "../src/outputBuffer";
import { createConsoleReplay } from "../src/consoleReplay";

// 文案断言基于中文字典，固定测试语言避免随运行环境漂移
test.before(async () => { await i18n.changeLanguage("zh"); });

const status = (id: string, state = "exited"): RunStatus => ({ run_id: id, state, label: id, device_name: "test",
  exit_code: state === "exited" ? 0 : null, error: null, started_at: "2026-09-12T00:00:00Z", ended_at: state === "exited" ? "2026-09-12T00:00:01Z" : null });
const mainTab = (fileContent = "edits", savedContent = "disk") => ({ name: "main.py", fileContent, savedContent,
  revision: "v1", eol: "lf" as const, bom: false, language: "python" as const, conflict: false, generation: 1 });
function setup(t: test.TestContext) {
  const old = useAppStore.getState();
  t.after(() => useAppStore.setState(old, true));
  // Render desktop snapshots through SSR without using Zustand's initial-state
  // hydration path; actual subscriptions are verified separately below.
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  t.mock.method(console, "warn", () => {});
  useAppStore.setState({ workspace: localWorkspace("/work"), openTabs: [mainTab()], activeFile: "main.py",
    loading: false, saving: false, starting: false, guarding: false, runs: {}, history: [], outputBuffers: {}, activeRunId: null });
  return useAppStore.getState();
}

test("canceling a workspace switch invalidates the in-flight read and preserves edits", async (t) => {
  const s = setup(t);
  let finish!: (value: { content: string; revision: string; eol: "lf"; bom: boolean }) => void;
  t.mock.method(api, "readWorkspaceFile", () => new Promise((resolve) => { finish = resolve; }));
  const first = s.openWorkspaceFile("a.py");
  await Promise.resolve();
  assert.equal(useAppStore.getState().loading, true);
  // 切换工作区作废旧读取；脏标签选择取消则工作区不变
  const second = s.setWorkspace(localWorkspace("/elsewhere"));
  useAppStore.getState().changePrompt!.resolve("cancel");
  await second;
  assert.deepEqual(useAppStore.getState().workspace, localWorkspace("/work"));
  finish({ content: "stale read", revision: "v2", eol: "lf", bom: false });
  await first;
  assert.equal(useAppStore.getState().loading, false);
  assert.equal(useAppStore.getState().openTabs.some((tab) => tab.name === "a.py"), false);
  const main = useAppStore.getState().openTabs.find((tab) => tab.name === "main.py")!;
  assert.equal(main.fileContent, "edits");
  s.editContent("main.py", "can type again");
  assert.equal(useAppStore.getState().openTabs.find((tab) => tab.name === "main.py")!.fileContent, "can type again");
  t.mock.method(api, "writeWorkspaceFile", async () => ({ revision: "v3" }));
  assert.equal(await s.saveFile(), true);
});

test("running tasks remain selectable and stoppable while viewing completed history", (t) => {
  const s = setup(t);
  s.handleRunEvents([{ type: "status", status: status("long-task", "running") }, { type: "status", status: status("old-task") }]);
  s.setActiveRun("old-task");
  const history = renderToStaticMarkup(createElement(HistoryPanel, { collapsed: true, onToggleCollapse: () => {} }));
  assert.match(history, /long-task/);
  assert.match(history, /停止 long-task/);
  const toolbar = renderToStaticMarkup(createElement(RunToolbar));
  assert.match(toolbar, /选择运行中的任务/);
  assert.match(toolbar, /value="long-task"/);
  s.setActiveRun("long-task");
  assert.match(renderToStaticMarkup(createElement(RunToolbar)), /■ 停止/);
});

test("run drafts survive panel remount and layout reset; workspace switch clears only entry", async (t) => {
  const s = setup(t);
  useAppStore.setState({ openTabs: [mainTab("disk", "disk")] });
  s.setRunDraft({ mode: "command", entry: "other.py", command: "echo retained", argsText: "a b", consoleMode: "pipe", timeoutSecs: 42 });
  s.setLayout(panelVisibilityPatch(useAppStore.getState().layout, "console", false));
  s.resetLayout();
  const markup = renderToStaticMarkup(createElement(RunToolbar));
  assert.match(markup, /echo retained/);
  assert.match(markup, /value="42"/);
  assert.match(markup, /value="pipe" selected/);
  t.mock.method(api, "listWorkspaceDir", async () => []);
  await s.setWorkspace(localWorkspace("/new"));
  assert.equal(useAppStore.getState().runDraft.entry, "");
  assert.equal(useAppStore.getState().runDraft.command, "echo retained");
});

test("toolbar hides completed status while preserving live progress and failure details", (t) => {
  const s = setup(t);
  s.handleRunEvents([{ type: "status", status: status("task") }]);
  s.setActiveRun("task");
  assert.doesNotMatch(renderToStaticMarkup(createElement(RunToolbar)), /已退出|state-exited/);

  s.handleRunEvents([{ type: "status", status: { ...status("live", "preparing"), phase: "syncing_dependencies" } }]);
  s.setActiveRun("live");
  const preparing = renderToStaticMarkup(createElement(RunToolbar));
  assert.match(preparing, /准备中/);
  assert.match(preparing, /同步依赖/);

  s.handleRunEvents([{ type: "status", status: { ...status("live", "failed"), error: "connection lost" } }]);
  assert.match(renderToStaticMarkup(createElement(RunToolbar)), /connection lost/);
});

test("history eviction frees caches and global byte budget preserves selected output first", (t) => {
  const s = setup(t);
  for (let i = 0; i < 201; i++) s.handleRunEvents([
    { type: "status", status: status(`run-${i}`) },
    { type: "output", run_id: `run-${i}`, stream: "stdout", data: btoa("data") },
  ]);
  assert.equal(Object.keys(useAppStore.getState().runs).length, 200);
  assert.equal(useAppStore.getState().outputBuffers["run-0"], undefined);
  s.setActiveRun("run-1");
  const data = btoa("x".repeat(MAX_OUTPUT_BYTES));
  for (let i = 1; i <= 12; i++) s.handleRunEvent({ type: "output", run_id: `run-${i}`, stream: "stdout", data });
  const buffers = useAppStore.getState().outputBuffers;
  assert.ok(Object.values(buffers).reduce((n, b) => n + b.bytes, 0) <= MAX_TOTAL_OUTPUT_BYTES);
  assert.equal(buffers["run-1"].bytes, MAX_OUTPUT_BYTES);
  assert.ok(buffers["run-2"].start > 0);
});

test("lag recovery marks gaps, restores terminal status, and ignores older queued status", (t) => {
  const s = setup(t);
  s.handleRunEvents([{ type: "status", status: status("live", "running") }, { type: "output", run_id: "live", stream: "stdout", data: btoa("partial") }]);
  s.handleRunEvents([{ type: "resync", statuses: [status("live")] }, { type: "status", status: status("live", "running") }]);
  assert.equal(useAppStore.getState().runs.live.state, "exited");
  assert.equal(useAppStore.getState().outputBuffers.live.bytes, 0);
  assert.equal(useAppStore.getState().outputBuffers.live.gaps, 1);
});

test("initial hydration preserves an event that completes during snapshot fetch", async (t) => {
  const s = setup(t);
  let finish!: (runs: RunStatus[]) => void;
  t.mock.method(api, "listRunningRuns", () => new Promise<RunStatus[]>((resolve) => { finish = resolve; }));
  t.mock.method(api, "getRunHistory", async () => []);
  const loading = s.loadRuns();
  s.handleRunEvent({ type: "status", status: status("live") });
  finish([status("live", "running")]);
  await loading;
  assert.equal(useAppStore.getState().runs.live.state, "exited");
  assert.equal(useAppStore.getState().history[0].run_id, "live");
});

test("one output batch publishes once and does not change run metadata identities", (t) => {
  const s = setup(t);
  s.handleRunEvent({ type: "status", status: status("live", "running") });
  const runs = useAppStore.getState().runs;
  let updates = 0;
  const unsubscribe = useAppStore.subscribe(() => updates++);
  s.handleRunEvents(Array.from({ length: 64 }, () => ({ type: "output" as const, run_id: "live", stream: "stdout", data: btoa("x") })));
  unsubscribe();
  assert.equal(updates, 1);
  assert.equal(useAppStore.getState().runs, runs);
});

test("slow terminal keeps one write in flight and resets only after switching safely", () => {
  const writes: (string | Uint8Array)[] = [];
  let done: (() => void) | undefined;
  let resets = 0;
  const current = { runId: "a", buffer: { chunks: [new Uint8Array([65]), new Uint8Array([66])], start: 0, bytes: 2 } };
  const replay = createConsoleReplay({ reset: () => resets++, write: (data, callback) => {
    assert.equal(done, undefined, "never queue a second terminal write");
    writes.push(data); done = callback;
  } }, () => current);
  replay.pump();
  for (let i = 0; i < 100; i++) replay.pump();
  assert.equal(writes.length, 1);
  current.runId = "b";
  current.buffer = { chunks: [new Uint8Array([67])], start: 0, bytes: 1 };
  replay.pump();
  assert.equal(resets, 1);
  const first = done!; done = undefined; first();
  assert.equal(resets, 2);
  assert.deepEqual(writes.map((w) => [...w]), [[65], [67]]);
  replay.dispose();
  const second = done!; done = undefined; second();
  assert.equal(writes.length, 2);
});
