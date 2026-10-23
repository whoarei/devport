// Manual fixture: npm run dev -> /tests/terminal-browser.html. No real processes/devices.
import React from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { api, type TerminalStatus } from "../src/api";
import { useAppStore } from "../src/store";
import { useTerminalStore } from "../src/terminalStore";
import { TerminalPage } from "../src/components/TerminalPage";
import { RunConsole } from "../src/components/RunConsole";
import i18n from "../src/i18n";
import "../src/styles.css";

await i18n.changeLanguage("zh");
const useInputLog = create<{ entries: { target: string; text: string }[] }>(() => ({ entries: [] }));
const record = (target: string, text: string) => useInputLog.setState(state => ({ entries: [...state.entries, { target, text }] }));
const status = (id: string): TerminalStatus => ({ session_id: id, device_name: "模拟终端", state: "connected", exit_code: null, error: null });
const output = new Map<string, string>();
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
api.resizeTerminal = async () => {};
api.readTerminal = async id => {
  const text = output.get(id) ?? "";
  output.delete(id);
  return { status: status(id), data: base64(text) };
};
api.sendTerminalInput = async (id, text) => {
  record(id, text);
  output.set(id, (output.get(id) ?? "") + text);
};
api.resizeRunConsole = async () => {};
api.sendRunInput = async (id, text) => {
  record(id, text);
  useAppStore.getState().handleRunEvent({ type: "output", run_id: id, stream: "stdout", data: base64(text) });
};
useTerminalStore.setState({ tabs: [{ id: "terminal", deviceId: "mock", deviceName: "模拟终端", busy: false, status: status("session-1") }], activeTab: "terminal" });
function replaceRun(id: string) {
  useAppStore.getState().handleRunEvent({ type: "status", status: { run_id: id, device_name: "模拟设备", label: "交互任务", state: "running",
    exit_code: null, error: null, started_at: "", ended_at: null } });
  useAppStore.getState().setActiveRun(id);
}
replaceRun("run-1");

// Add read latency without changing native paste events, to check focus and stale-session races.
let clipboardDelay = false;
let clipboardFailure = false;
const readClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
navigator.clipboard.readText = async () => {
  const text = await readClipboard();
  if (clipboardDelay) await new Promise(resolve => setTimeout(resolve, 1500));
  if (clipboardFailure) throw new Error("模拟剪贴板读取失败");
  return text;
};

function Fixture() {
  const tab = useTerminalStore(state => state.tabs[0]);
  const entries = useInputLog(state => state.entries);
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16, gap: 12 }}>
    <header>终端粘贴交互验收（模拟接口）</header>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <input aria-label="粘贴样本文本" defaultValue="paste-check" />
      <button onClick={() => void navigator.clipboard.writeText("paste-check")}>复制测试文本</button>
      <input aria-label="其他输入框" placeholder="检查异步粘贴不抢焦点" />
      <label><input type="checkbox" onChange={event => { clipboardDelay = event.target.checked; }} />延迟读取剪贴板</label>
      <label><input type="checkbox" onChange={event => { clipboardFailure = event.target.checked; }} />模拟剪贴板失败</label>
      <button onClick={() => useTerminalStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, status: status("session-2") })) }))}>替换终端会话</button>
      <button onClick={() => replaceRun("run-2")}>替换运行任务</button>
    </div>
    <section style={{ display: "flex", flex: 1, minHeight: 0, gap: 16 }}>
      <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}><h3>独立终端</h3><TerminalPage tab={tab} visible /></div>
      <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}><h3>运行控制台</h3><RunConsole collapsed={false} onToggleCollapse={() => {}} /></div>
    </section>
    <pre aria-label="收到的输入" style={{ height: 150, overflow: "auto", flexShrink: 0 }}>{JSON.stringify(entries, null, 2)}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
