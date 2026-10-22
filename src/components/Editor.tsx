import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { getWorkspaceGeneration, useAppStore } from "../store";
import { dirtyTab, EditorLanguage, EditorTab, uploadBusy, withTab } from "../editorDocument";
import { workspaceRefEquals, type WorkspaceRef } from "../api";
import { workspaceSourceRevision } from "../workspaceRun";
import { editorCloseTargets, type EditorCloseScope } from "../editorTabActions";
import { ContextMenu, contextMenuPosition, type MenuEntry, type MenuState } from "./ContextMenu";
import { nameOf } from "../workspaceTree";
import { useThemeStore, type Theme } from "../theme";

function editorTheme(theme: Theme) {
  return [syntaxHighlighting(theme === "dark" ? oneDarkHighlightStyle : defaultHighlightStyle),
    EditorView.theme({}, { dark: theme === "dark" })];
}

function languageExtension(language: EditorLanguage) {
  return [language === "python" ? python() : language === "shell" ? StreamLanguage.define(shell) : [],
    indentUnit.of(language === "shell" ? "  " : "    ")];
}

function CodeEditor({ tab, language, locked, active, onCursor, focusToolbar }: {
  tab: string; language: EditorLanguage; locked: boolean; active: boolean;
  onCursor: (position: string) => void; focusToolbar: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageConfig = useRef(new Compartment());
  const readOnlyConfig = useRef(new Compartment());
  const themeConfig = useRef(new Compartment());
  const theme = useThemeStore((state) => state.theme);
  const restoreLocation = useRef<(() => void) | null>(null);
  // 回调随渲染更新，编辑器扩展内始终读到最新值
  const handlers = useRef({ active, onCursor, focusToolbar });
  handlers.current = { active, onCursor, focusToolbar };

  useEffect(() => {
    if (!parent.current) return;
    const source = useAppStore.getState().workspace;
    const initial = useAppStore.getState().openTabs.find((file) => file.name === tab);
    let positioned = !initial?.view;
    const capture = (editor: EditorView) => {
      if (!positioned || !editor.dom.clientHeight || !workspaceRefEquals(source, useAppStore.getState().workspace)) return;
      const current = useAppStore.getState().openTabs.find((file) => file.name === tab);
      if (!current || current.loaded === false || current.generation !== initial?.generation) return;
      const selection = editor.state.selection.main;
      const location = { anchor: selection.anchor, head: selection.head,
        scroll_top: Math.max(0, editor.scrollDOM.scrollTop), scroll_left: Math.max(0, editor.scrollDOM.scrollLeft) };
      if (JSON.stringify(current.view) === JSON.stringify(location)) return;
      useAppStore.setState((s) => ({ openTabs: withTab(s.openTabs, tab, (file) => ({ ...file, view: location })) }));
    };
    const report = (state: EditorState) => {
      if (!handlers.current.active) return;
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      handlers.current.onCursor(`${line.number}:${pos - line.from + 1}`);
    };
    const content = initial?.fileContent ?? "";
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: content,
        selection: initial?.view ? { anchor: Math.min(initial.view.anchor, content.length), head: Math.min(initial.view.head, content.length) } : undefined,
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), closeBrackets(),
          search({ top: true }), highlightSelectionMatches(),
          themeConfig.current.of(editorTheme(useThemeStore.getState().theme)),
          languageConfig.current.of(languageExtension(language)),
          readOnlyConfig.current.of(EditorState.readOnly.of(locked)),
          EditorState.changeFilter.of(() => {
            const state = useAppStore.getState();
            return !state.loading && !state.starting && !state.guarding;
          }),
          EditorView.contentAttributes.of({ "aria-label": i18n.t("editor.contentAria", { name: tab }), spellcheck: "false" }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void useAppStore.getState().saveFile(tab); return true; } },
            { key: "Mod-w", preventDefault: true, run: () => { void useAppStore.getState().closeFile(tab); return true; } },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
            { key: "Escape", run: () => { handlers.current.focusToolbar(); return true; } }, indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) useAppStore.getState().editContent(tab, update.state.doc.toString());
            if (update.docChanged || update.selectionSet) report(update.state);
            if (update.docChanged || update.selectionSet) capture(update.view);
          }),
          EditorView.theme({
            "&": { height: "100%", color: "var(--text-primary, #ddd)", backgroundColor: "var(--surface-base, #17181c)" },
            ".cm-scroller": { overflow: "auto", fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: "13px", lineHeight: "1.5" },
            ".cm-content": { padding: "10px 0", caretColor: "var(--text-primary, #fff)" },
            ".cm-cursor": { borderLeftColor: "var(--text-primary, #fff)" },
            ".cm-gutters": { backgroundColor: "var(--surface-base, #17181c)", color: "var(--text-muted, #7d8595)", borderRight: "1px solid var(--border, #2a2b30)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover-overlay, #ffffff09)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection, #324869)" },
            ".cm-panels": { backgroundColor: "var(--surface-raised, #23252d)", color: "var(--text-primary, #ddd)" },
          }),
        ],
      }),
    });
    view.current = editor;
    const onScroll = () => capture(editor);
    editor.scrollDOM.addEventListener("scroll", onScroll);
    restoreLocation.current = () => editor.requestMeasure({ read: () => handlers.current.active && !!parent.current?.clientHeight, write: (visible) => {
      if (!positioned && initial?.view && visible) {
        editor.scrollDOM.scrollTop = initial.view.scroll_top;
        editor.scrollDOM.scrollLeft = initial.view.scroll_left;
        positioned = true;
      }
    } });
    restoreLocation.current();
    report(editor.state);
    return () => { capture(editor); editor.scrollDOM.removeEventListener("scroll", onScroll);
      editor.destroy(); view.current = null; restoreLocation.current = null; };
    // A document generation remounts this component; ordinary edits preserve history.
  }, []);

  // 重新可见时重新测量并上报光标（display:none 期间 CodeMirror 尺寸为 0）
  useEffect(() => {
    if (!active || !view.current) return;
    view.current.requestMeasure();
    restoreLocation.current?.();
    const pos = view.current.state.selection.main.head;
    const line = view.current.state.doc.lineAt(pos);
    onCursor(`${line.number}:${pos - line.from + 1}`);
  }, [active]);

  useEffect(() => { view.current?.dispatch({ effects: languageConfig.current.reconfigure(languageExtension(language)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(locked)) }); }, [locked]);
  useEffect(() => { view.current?.dispatch({ effects: themeConfig.current.reconfigure(editorTheme(theme)) }); }, [theme]);
  return <div className="code-editor" ref={parent} />;
}

export function Editor({ collapsed = false, onToggleCollapse }: { collapsed?: boolean; onToggleCollapse?: () => void }) {
  const { t } = useTranslation();
  const state = useAppStore(useShallow((s) => ({ tabs: s.openTabs, activeFile: s.activeFile,
    loading: s.loading, saving: s.saving, starting: s.starting, guarding: s.guarding,
    workspace: s.workspace, devices: s.devices, workspaceMutating: s.workspaceMutating,
    error: s.editorError, uploadBusy: uploadBusy(s) })));
  const [cursor, setCursor] = useState("1:1");
  const [tabMenu, setTabMenu] = useState<{
    x: number; y: number; name: string; generation: number;
    workspace: WorkspaceRef | null; workspaceGeneration: number; sourceRevision: string | null;
  } | null>(null);
  const languageSelect = useRef<HTMLSelectElement>(null);
  const locked = state.loading || state.starting || state.guarding;
  const active = state.tabs.find((tab) => tab.name === state.activeFile);
  const closeLocked = locked || state.saving || state.workspaceMutating;
  const menuCurrent = () => {
    const current = useAppStore.getState();
    return !!tabMenu && workspaceRefEquals(tabMenu.workspace, current.workspace)
      && tabMenu.workspaceGeneration === getWorkspaceGeneration()
      && tabMenu.sourceRevision === workspaceSourceRevision(current.workspace, current.devices)
      && current.openTabs.some((tab) => tab.name === tabMenu.name && tab.generation === tabMenu.generation);
  };
  useEffect(() => { if (tabMenu && !menuCurrent()) setTabMenu(null); }, [tabMenu, state.tabs, state.workspace, state.devices]);
  const openTabMenu = (event: MouseEvent, tab: EditorTab) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setTabMenu({ ...contextMenuPosition(event.clientX || rect.left, event.clientY || rect.bottom, 6),
      name: tab.name, generation: tab.generation, workspace: state.workspace,
      workspaceGeneration: getWorkspaceGeneration(), sourceRevision: workspaceSourceRevision(state.workspace, state.devices) });
  };
  const closeEntry = (scope: EditorCloseScope, label: string): MenuEntry => {
    const target = tabMenu?.name;
    const names = target ? editorCloseTargets(state.tabs, target, scope) : [];
    return { label: t(label, { count: names.length }), disabled: names.length === 0,
      detail: scope === "current" ? "Ctrl+W" : undefined,
      onSelect: () => {
        const current = useAppStore.getState();
        if (target && menuCurrent()) void current.closeFiles(editorCloseTargets(current.openTabs, target, scope));
      } };
  };
  const menu: MenuState | null = tabMenu && menuCurrent() ? { x: tabMenu.x, y: tabMenu.y, entries: [
    closeEntry("current", "editor.close"),
    closeEntry("others", "editor.closeOthers"),
    closeEntry("left", "editor.closeLeft"),
    closeEntry("right", "editor.closeRight"),
    "separator",
    closeEntry("saved", "editor.closeSaved"),
    closeEntry("all", "editor.closeAll"),
  ] } : null;
  return <div className={`editor${state.tabs.length === 0 ? " empty" : ""}`}>
    {state.error && <div className="editor-error" role="alert">{state.error}
      {active?.conflict && <button disabled={locked || state.saving} onClick={() => void useAppStore.getState().reloadFile()}>{t("editor.reloadDisk")}</button>}
      {active?.loaded === false && <button disabled={locked} onClick={() => void useAppStore.getState().openWorkspaceFile(active.name)}>{t("environment.retry")}</button>}
    </div>}
    {state.tabs.length === 0 ? <p>{state.loading ? t("editor.opening") : t("editor.placeholder")}</p> : <>
      <div className="editor-tabs center-panel-header" role="tablist" aria-label={t("editor.openTabs")}>
        <button className="editor-collapse center-panel-collapse" aria-label={collapsed ? t("editor.expand") : t("editor.collapse")} aria-expanded={!collapsed}
          title={collapsed ? t("editor.expand") : t("editor.collapse")} onClick={onToggleCollapse}>{collapsed ? "▸" : "▾"}</button>
        {state.tabs.map((tab) => (
          <div key={tab.name} role="tab" aria-selected={tab.name === state.activeFile}
            onContextMenu={(event) => openTabMenu(event, tab)}
            className={`editor-tab${tab.name === state.activeFile ? " active" : ""}`}>
            <button className="editor-tab-label" title={tab.name}
              onClick={() => useAppStore.getState().activateFile(tab.name)}>
              {nameOf(tab.name)}{dirtyTab(tab) ? " ●" : ""}
            </button>
            <button className="editor-tab-close" aria-label={t("editor.closeTab", { name: tab.name })} title={t("editor.closeFileTitle")}
              disabled={closeLocked}
              onClick={() => void useAppStore.getState().closeFile(tab.name)}>×</button>
          </div>
        ))}
      </div>
      {/* 折叠时编辑器保持挂载仅隐藏 DOM，保留撤销历史、滚动位置与选区 */}
      <div className={`editor-body${collapsed ? " collapsed" : ""}`}>
        {active && <>
          {state.tabs.map((tab) => (
            <div key={`${tab.name}:${tab.generation}`}
              className={`tab-editor${tab.name === state.activeFile ? " active" : ""}`}>
              {(tab.loaded !== false || tab.name === state.activeFile) && <CodeEditor tab={tab.name} language={tab.language} locked={locked || tab.loaded === false}
                active={tab.name === state.activeFile && !collapsed} onCursor={setCursor}
                focusToolbar={() => languageSelect.current?.focus()} />}
            </div>
          ))}
          <div className="editor-status" role="status">
            <span>
              {state.loading ? t("editor.opening") : state.starting ? t("editor.savingAndStarting") : state.saving ? t("editor.saving")
                : state.error ? t("editor.failed")
                : dirtyTab(active)
                  ? <button className="editor-status-save" disabled={locked || state.uploadBusy}
                      title={t("editor.saveTitle")}
                      onClick={() => void useAppStore.getState().saveFile()}>{t("editor.save")}</button>
                  : t("editor.saved")}
              {state.uploadBusy ? t("editor.uploadBusyHint") : ""}
            </span>
            <span className="editor-status-right">
              <select ref={languageSelect} aria-label={t("editor.languageAria")} value={active.language} disabled={locked}
                onChange={(event) => useAppStore.getState().setLanguage(event.target.value as EditorLanguage)}>
                <option value="python">Python</option><option value="shell">Shell</option><option value="text">{t("editor.plainText")}</option>
              </select>
              <span>{cursor} · UTF-8{active.bom ? " BOM" : ""} · {active.eol.toUpperCase()} · {t("editor.escHint")}</span>
            </span>
          </div>
        </>}
      </div>
    </>}
    <ContextMenu menu={menu} disabled={closeLocked} onClose={() => setTabMenu(null)} />
  </div>;
}
