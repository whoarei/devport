// Manual fixture: npm run dev -> /tests/about-browser.html.
// Query params: state=idle|checking|uptodate|available|manual|blocked|error|downloading|verifying|installing,
// lang=zh|en, theme=light|dark, zoom=100|150|200, width=320|360|420.
// No network, downloads, or installations.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { AboutDialog } from "../src/components/AboutDialog";
import { api, type AppUpdateInfo } from "../src/api";
import { transferApi } from "../src/transferApi";
import { useAppStore } from "../src/store";
import { initializeTheme, useThemeStore } from "../src/theme";
import { applyUiZoom } from "../src/uiZoom";
import i18n from "../src/i18n";
import { version } from "../src-tauri/tauri.conf.json";
import "../src/styles.css";
import "../src/theme.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("state") ?? "idle";
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
document.documentElement.lang = i18n.language === "en" ? "en" : "zh-CN";
initializeTheme();
useThemeStore.getState().setPreference(params.get("theme") === "light" ? "light" : "dark");
const zoom = Number(params.get("zoom") ?? 100);
await applyUiZoom([100, 150, 200].includes(zoom) ? zoom : 100);
const width = Number(params.get("width"));
if ([320, 360, 420].includes(width)) document.documentElement.style.setProperty("--about-fixture-width", `${width}px`);

Object.defineProperty(window, "isTauri", { configurable: true, value: true });
mockIPC((command, args) => {
  if (command === "plugin:app|version") return version;
  if (command === "plugin:opener|open_url") {
    document.getElementById("opened-url")!.textContent = String(args?.url);
    return;
  }
  throw new Error(`Unexpected fixture IPC: ${command}`);
}, { shouldMockEvents: true });

const update: AppUpdateInfo = {
  current_version: version,
  latest_version: "0.17.0",
  notes: "更新内容示例 / Sample release notes\n\n改善界面布局与可读性。\nImprove layout and readability.\n\n".repeat(12),
  published_at: null,
  download_url: "https://github.com/whoarei/remote-runner/releases/latest",
  can_auto_install: scenario !== "manual",
};
api.checkAppUpdate = async () => {
  if (scenario === "checking") return new Promise<AppUpdateInfo | null>(() => {});
  if (scenario === "error") throw new Error("无法连接更新服务 / Cannot reach the update service. https://example.invalid/" + "unavailable-".repeat(15));
  return scenario === "uptodate" ? null : update;
};
transferApi.snapshot = async () => [];
api.saveWorkEnvironment = async () => {};
api.closeAllTerminals = async () => {};
api.installAppUpdate = async () => {
  await emit("app-update://progress", {
    phase: scenario === "verifying" || scenario === "installing" ? scenario : "downloading",
    downloaded: 12 * 1024 * 1024,
    total: 32 * 1024 * 1024,
  });
  return new Promise<void>(() => {});
};
if (scenario === "blocked") useAppStore.setState({ runs: { fixture: { state: "running" } } as ReturnType<typeof useAppStore.getState>["runs"] });

function Fixture() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [nonce, setNonce] = useState(scenario === "idle" ? 0 : 1);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <>
    <main style={{ padding: 24 }}>
      <p>关于对话框交互验收（模拟更新，不下载或安装）</p>
      <button onClick={() => dialog.current?.showModal()}>打开对话框</button>
      <button onClick={() => { setNonce((value) => value + 1); dialog.current?.showModal(); }}>检查更新入口</button>
      <p id="opened-url" />
    </main>
    <AboutDialog dialogRef={dialog} autoCheckNonce={nonce} />
  </>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
