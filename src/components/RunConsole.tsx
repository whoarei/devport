import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errorMessage } from "../api";
import { useAppStore } from "../store";
import { isActiveRun, runStateLabel } from "../runState";
import { PanelTitle } from "./PanelTitle";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { createConsoleReplay } from "../consoleReplay";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";
import { handleRunConsoleKey } from "../runConsoleInput";
import { terminalTheme, useThemeStore } from "../theme";
import { useCommandUiStore } from "../commandUiStore";

/**
 * Run Console：绑定的是“远程进程”的 stdin/stdout/stderr，不是 SSH shell。
 * 折叠时终端保持挂载，仅隐藏 DOM，避免 xterm 重新附着和输出丢失。
 */
export function RunConsole({ collapsed, onToggleCollapse, embedded = false }: { collapsed: boolean; onToggleCollapse: () => void; embedded?: boolean }) {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.theme);
  const focus = useCommandUiStore((state) => state.focus);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const replayRef = useRef<ReturnType<typeof createConsoleReplay> | null>(null);
  const [inputError, setInputError] = useState<{ runId: string; message: string } | null>(null);

  const { activeRunId, buffer, activeRun } = useAppStore(useShallow((s) => ({
    activeRunId: s.activeRunId, buffer: s.activeRunId ? s.outputBuffers[s.activeRunId] : undefined,
    activeRun: s.activeRunId ? s.runs[s.activeRunId] : undefined,
  })));

  // 初始化 xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: terminalTheme(useThemeStore.getState().theme),
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    useAppStore.getState().setConsoleSize(term.cols, term.rows);

    const sendInput = (data: string) => {
      const { activeRunId: runId, runs } = useAppStore.getState();
      if (runId && runs[runId]?.state === "running") {
        setInputError(null);
        void api.sendRunInput(runId, data).catch((error) => {
          setInputError({ runId, message: errorMessage(error) });
        });
      }
    };
    const input = term.onData(sendInput);

    term.attachCustomKeyEventHandler((ev) => handleRunConsoleKey(ev, term.getSelection(), sendInput,
      (text) => { void navigator.clipboard.writeText(text).catch(() => {}); }));

    termRef.current = term;
    fitRef.current = fit;
    const replay = createConsoleReplay(term, () => {
      const s = useAppStore.getState();
      return { runId: s.activeRunId, buffer: s.activeRunId ? s.outputBuffers[s.activeRunId] : undefined,
        status: s.activeRunId ? s.runs[s.activeRunId] : undefined };
    });
    replayRef.current = replay;
    replay.pump();

    const observer = new ResizeObserver(() => {
      if (!containerRef.current?.clientWidth || !containerRef.current.clientHeight) return;
      fit.fit();
      useAppStore.getState().setConsoleSize(term.cols, term.rows);
      const runId = useAppStore.getState().activeRunId;
      if (runId) {
        void api.resizeRunConsole(runId, term.cols, term.rows).catch(() => {});
      }
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      input.dispose();
      replay.dispose();
      replayRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = terminalTheme(theme); }, [theme]);

  useEffect(() => { replayRef.current?.pump(); }, [activeRunId, buffer]);

  // 变为可见时 fit 并聚焦，保证 Ctrl+Tab 循环时焦点跟随当前标签（与 TerminalPage 行为一致）
  useEffect(() => {
    if (!collapsed) {
      if (containerRef.current?.clientWidth && containerRef.current.clientHeight) fitRef.current?.fit();
      termRef.current?.focus();
    }
  }, [collapsed]);

  useEffect(() => {
    if (focus === "console" && !collapsed && termRef.current) {
      termRef.current.focus();
      useCommandUiStore.setState({ focus: null });
    }
  }, [focus, collapsed]);

  // 状态行

  useEffect(() => {
    const term = termRef.current;
    if (term && activeRunId && activeRun?.state === "running") {
      void api.resizeRunConsole(activeRunId, term.cols, term.rows).catch(() => {});
    }
  }, [activeRunId, activeRun?.state]);

  // 右键菜单：复制/粘贴/全选/清空/停止运行
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const entries: MenuEntry[] = [
      {
        label: t("ctxmenu.copy"),
        disabled: !term.getSelection(),
        onSelect: () => void navigator.clipboard.writeText(term.getSelection()).catch(() => {}),
      },
      {
        // 粘贴写入远程进程 stdin（pty 模式下由远端回显）
        label: t("ctxmenu.paste"),
        disabled: !(activeRun && isActiveRun(activeRun)),
        onSelect: () => {
          term.focus();
          const runId = activeRunId;
          void navigator.clipboard.readText().then((text) => {
            const state = useAppStore.getState();
            if (text && termRef.current === term && runId && state.activeRunId === runId && state.runs[runId]?.state === "running") {
              void api.sendRunInput(runId, text).catch(() => {});
            }
          }).catch(() => {});
        },
      },
      { label: t("ctxmenu.selectAll"), onSelect: () => term.selectAll() },
      { label: t("ctxmenu.clearTerminal"), onSelect: () => term.clear() },
      "separator",
      {
        label: t("ctxmenu.stopRun"),
        danger: true,
        disabled: !(activeRun && isActiveRun(activeRun)),
        onSelect: () => { if (activeRunId) void api.stopRun(activeRunId).catch(() => {}); },
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  return (
    <div className="run-console">
      {!embedded && <PanelTitle className="console-header" title={t("console.runTab")} collapsed={collapsed} onToggle={onToggleCollapse}>
        {activeRun && (
          <span className={`run-state state-${activeRun.state}`}>
            {activeRun.run_id} · {activeRun.waiting_workspace ? t("workspaceSync.waiting") : runStateLabel(activeRun.state)}
            {activeRun.exit_code != null && ` · exit=${activeRun.exit_code}`}
          </span>
        )}
      </PanelTitle>}
      {!collapsed && activeRun?.workspace_sync && <div className="run-launch" role="status">
        <span>{t("workspaceSync.summary", { ...activeRun.workspace_sync, bytes: activeRun.workspace_sync.uploaded_bytes.toLocaleString() })}</span>
        <code>{activeRun.workspace_sync.destination}</code>
      </div>}
      {inputError?.runId === activeRunId && <div className="terminal-error" role="alert">{t("console.inputFailed", { error: inputError.message })}</div>}
      <div ref={containerRef} className={`console-body${collapsed ? " collapsed" : ""}`} onContextMenu={openMenu}
        onPasteCapture={() => { if (!collapsed) termRef.current?.focus(); }} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
