import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { useTerminalStore, terminalActive, type TerminalTab } from "../terminalStore";
import { readTerminal, terminalInput } from "../terminalIO";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";
import { terminalTheme, useThemeStore } from "../theme";

export function TerminalPage({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.theme);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<() => void>();
  const current = useRef({ tab, visible });
  current.current = { tab, visible };
  const sessionId = tab.status?.session_id;

  useEffect(() => {
    if (!container.current || !sessionId) return;
    const term = new Terminal({ fontSize: 13, fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: terminalTheme(useThemeStore.getState().theme), scrollback: 3000, convertEol: false });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(container.current);
    terminal.current = term;
    let disposed = false;
    const report = (e: unknown) => { if (!disposed) useTerminalStore.getState().report(tab.id, sessionId, e); };
    let lastSize = "";
    fit.current = () => {
      if (!current.current.visible || !container.current?.clientWidth || !container.current.clientHeight) return;
      addon.fit();
      const size = `${term.cols}:${term.rows}`;
      if (current.current.tab.status?.state === "connected" && size !== lastSize) {
        lastSize = size;
        void api.resizeTerminal(sessionId, term.cols, term.rows).catch((e) => { lastSize = ""; report(e); });
      }
    };
    fit.current();
    const observer = new ResizeObserver(() => fit.current?.());
    observer.observe(container.current);
    const input = terminalInput((data) => api.sendTerminalInput(sessionId, data), report);
    const subscription = term.onData((data) => {
      if (current.current.tab.status?.state === "connected" && !current.current.tab.busy) input.send(data);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || !event.shiftKey || !["c", "v"].includes(event.key.toLowerCase())) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        if (event.key.toLowerCase() === "c") void navigator.clipboard.writeText(term.getSelection()).catch(report);
        else void navigator.clipboard.readText().then((text) => { if (!disposed) term.paste(text); }).catch(report);
      }
      return false;
    });
    const stop = readTerminal(() => api.readTerminal(sessionId),
      (bytes) => new Promise<void>((resolve) => term.write(bytes, resolve)),
      ({ status }) => useTerminalStore.getState().update(tab.id, sessionId, status), report);
    return () => {
      disposed = true;
      stop(); input.dispose(); subscription.dispose(); observer.disconnect(); term.dispose();
      terminal.current = undefined; fit.current = undefined;
    };
  }, [tab.id, sessionId]);

  useEffect(() => { if (terminal.current) terminal.current.options.theme = terminalTheme(theme); }, [theme, sessionId]);

  useEffect(() => {
    if (visible) {
      fit.current?.();
      if (tab.status?.state === "connected") terminal.current?.focus();
    }
  }, [visible, tab.status?.state, sessionId]);

  // 右键菜单：复制/粘贴/全选/清空/重连/关闭终端
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const term = terminal.current;
    if (!term) return;
    const connected = tab.status?.state === "connected" && !tab.busy;
    const entries: MenuEntry[] = [
      {
        label: t("ctxmenu.copy"),
        disabled: !term.getSelection(),
        onSelect: () => void navigator.clipboard.writeText(term.getSelection()).catch(() => {}),
      },
      {
        // term.paste 会走 onData → terminalInput 的发送/限长管线
        label: t("ctxmenu.paste"),
        disabled: !connected,
        onSelect: () => void navigator.clipboard.readText().then((text) => { if (text) term.paste(text); }).catch(() => {}),
      },
      { label: t("ctxmenu.selectAll"), onSelect: () => term.selectAll() },
      { label: t("ctxmenu.clearTerminal"), onSelect: () => term.clear() },
      "separator",
      {
        label: t("ctxmenu.reconnect"),
        disabled: terminalActive(tab) || tab.busy,
        onSelect: () => void useTerminalStore.getState().reconnect(tab.id),
      },
      {
        label: t("ctxmenu.closeTerminal"),
        danger: true,
        disabled: tab.busy,
        onSelect: () => void useTerminalStore.getState().close(tab.id),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };

  return <section className="terminal-page" role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={!visible}>
    {(tab.error || tab.status?.error) && <div className="terminal-error" role="alert">{tab.error || tab.status?.error}</div>}
    <div className="console-body" ref={container} onContextMenu={openMenu} />
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
  </section>;
}
