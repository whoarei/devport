import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import i18n from "../i18n";
import { useAppStore } from "../store";
import { useTerminalStore, terminalActive, type TerminalTab } from "../terminalStore";
import { readTerminal, terminalInput } from "../terminalIO";
import { createTerminalDisplay, terminalSessionBoundary } from "../terminalDisplay";
import { createTerminalReconnectKey } from "../terminalReconnect";
import { ContextMenu, contextMenuPosition, MenuEntry, MenuState } from "./ContextMenu";
import { terminalTheme, useThemeStore } from "../theme";
import { useCommandUiStore } from "../commandUiStore";

interface Session {
  id: string;
  input: ReturnType<typeof terminalInput>;
  resize: (cols: number, rows: number) => void;
}
interface View {
  term: Terminal;
  display: ReturnType<typeof createTerminalDisplay>;
  session?: Session;
  previousSession?: string;
  paste: () => void;
}

export function TerminalPage({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.theme);
  const focus = useCommandUiStore((state) => state.focus);
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<View>();
  const fit = useRef<() => void>();
  const current = useRef({ visible });
  current.current = { visible };
  const sessionId = tab.status?.session_id;
  const reconnect = () => {
    if (current.current.visible) view.current?.term.focus();
    void useTerminalStore.getState().reconnect(tab.id);
  };

  // The display belongs to the tab, so replacing a session preserves scrollback and focus.
  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({ fontSize: 13, fontFamily: "Consolas, 'Cascadia Mono', monospace",
      theme: terminalTheme(useThemeStore.getState().theme), scrollback: 3000, convertEol: false });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(container.current);
    const display = createTerminalDisplay(term);
    const liveTab = () => useTerminalStore.getState().tabs.find(candidate => candidate.id === tab.id);
    const connected = (session?: Session) => {
      const live = liveTab();
      return !!session && live?.status?.session_id === session.id && live.status.state === "connected" && !live.busy;
    };
    const report = (error: unknown) => {
      const id = liveTab()?.status?.session_id;
      if (id) useTerminalStore.getState().report(tab.id, id, error);
    };
    const instance: View = { term, display, paste: () => {
      const session = instance.session;
      if (!connected(session)) return;
      void navigator.clipboard.readText().then(text => {
        if (view.current === instance && instance.session === session && connected(session)) term.paste(text);
      }).catch(error => { if (instance.session === session) report(error); });
    } };
    view.current = instance;
    fit.current = () => {
      if (!current.current.visible || !container.current?.clientWidth || !container.current.clientHeight) return;
      addon.fit();
      if (connected(instance.session)) instance.session?.resize(term.cols, term.rows);
    };
    fit.current();
    const observer = new ResizeObserver(() => fit.current?.());
    observer.observe(container.current);
    const subscription = term.onData(data => {
      const session = instance.session;
      if (connected(session) && (!display.writing || display.sessionId === session?.id)) session?.input.send(data);
    });
    const titleSubscription = term.onTitleChange(title => {
      if (display.sessionId) useTerminalStore.getState().setTitle(tab.id, display.sessionId, title);
    });
    const reconnectKey = createTerminalReconnectKey(() => {
      const live = liveTab();
      return current.current.visible && !!live && !terminalActive(live)
        && !useTerminalStore.getState().shuttingDown && !useAppStore.getState().updating;
    }, reconnect);
    term.attachCustomKeyEventHandler(event => {
      if (!reconnectKey(event)) return false;
      if (!event.ctrlKey || !event.shiftKey || !["c", "v"].includes(event.key.toLowerCase())) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        if (event.key.toLowerCase() === "c") void navigator.clipboard.writeText(term.getSelection()).catch(report);
        else instance.paste();
      }
      return false;
    });
    return () => {
      display.dispose(); subscription.dispose(); titleSubscription.dispose(); observer.disconnect(); term.dispose();
      view.current = undefined; fit.current = undefined;
    };
  }, [tab.id]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || !sessionId) return;
    let disposed = false;
    const report = (error: unknown) => { if (!disposed) useTerminalStore.getState().report(tab.id, sessionId, error); };
    const input = terminalInput(data => api.sendTerminalInput(sessionId, data), report);
    let lastSize = "";
    const session: Session = { id: sessionId, input, resize: (cols, rows) => {
      const size = `${cols}:${rows}`;
      if (size === lastSize) return;
      lastSize = size;
      void api.resizeTerminal(sessionId, cols, rows).catch(error => { lastSize = ""; report(error); });
    } };
    instance.session = session;
    if (instance.previousSession && instance.previousSession !== sessionId) {
      void instance.display.write(terminalSessionBoundary(instance.term.rows, i18n.t("terminal.newSession"))).catch(report);
    }
    instance.previousSession = sessionId;
    const stop = readTerminal(() => api.readTerminal(sessionId),
      bytes => instance.display.write(bytes, sessionId),
      ({ status, data }) => {
        // Drain final output before enabling reconnect, so closing the old session cannot discard it.
        if (!data || !["exited", "closed", "failed"].includes(status.state)) useTerminalStore.getState().update(tab.id, sessionId, status);
      }, report);
    fit.current?.();
    return () => {
      disposed = true;
      stop(); input.dispose();
      if (instance.session === session) instance.session = undefined;
    };
  }, [tab.id, sessionId]);

  useEffect(() => { if (view.current) view.current.term.options.theme = terminalTheme(theme); }, [theme]);

  useEffect(() => {
    if (!visible) return;
    fit.current?.();
    view.current?.term.focus();
  }, [visible]);

  useEffect(() => {
    if (visible) fit.current?.();
  }, [visible, tab.status?.state, sessionId]);

  useEffect(() => {
    if (focus !== "console" || !visible) return;
    view.current?.term.focus();
    useCommandUiStore.setState({ focus: null });
  }, [focus, visible]);

  // 右键菜单：复制/粘贴/全选/清空/重连/关闭终端
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const term = view.current?.term;
    if (!term) return;
    const connected = tab.status?.state === "connected" && !tab.busy;
    const entries: MenuEntry[] = [
      {
        label: t("ctxmenu.copy"),
        disabled: !term.getSelection(),
        onSelect: () => void navigator.clipboard.writeText(term.getSelection()).catch(() => {}),
      },
      { label: t("ctxmenu.paste"), disabled: !connected, onSelect: () => view.current?.paste() },
      { label: t("ctxmenu.selectAll"), onSelect: () => term.selectAll() },
      { label: t("ctxmenu.clearTerminal"), onSelect: () => term.clear() },
      "separator",
      { label: t("ctxmenu.reconnect"), disabled: terminalActive(tab), onSelect: reconnect },
      {
        label: t("ctxmenu.closeTerminal"),
        danger: true,
        disabled: tab.busy,
        onSelect: () => void useTerminalStore.getState().close(tab.id),
      },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };
  const canReconnect = !terminalActive(tab);
  const closing = tab.status?.state === "closing" || tab.busy && tab.status?.state === "connected";
  const connecting = !closing && (tab.busy || tab.status?.state === "connecting");
  const error = tab.error || (!tab.busy ? tab.status?.error : null);

  return <section className="terminal-page" role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={!visible}>
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="console-body" ref={container} onContextMenu={openMenu} />
    {(canReconnect || connecting || closing) && <div className="terminal-restore" role="status">
      <span>{connecting ? t("terminal.connecting") : closing ? t("terminal.closing")
        : sessionId ? t("terminal.reconnectHint") : t("terminal.connectHint")}</span>
      {canReconnect && <button onClick={reconnect}>{t("terminal.reconnect")}</button>}
    </div>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
  </section>;
}
