import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
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
import { useCommandUiStore } from "../commandUiStore";
import { executeAppCommand } from "../appCommands";
import { shortcutLabel, shortcutTitle } from "../shortcuts";
import { EDITOR_LANGUAGES, isEditorLanguage } from "../editorLanguages";
import { completeDocumentWords, configureEditorLanguage, editorLanguageIndent } from "../editorLanguageSupport";
import { FileIcon, Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { tabNavigationTarget, useRevealActiveTab } from "../tabStrip";

function editorTheme(theme: Theme) {
  return [syntaxHighlighting(theme === "dark" ? oneDarkHighlightStyle : defaultHighlightStyle),
    EditorView.theme({}, { dark: theme === "dark" })];
}

function editorPhrases() {
  return EditorState.phrases.of({
    "Fold line": i18n.t("editor.foldLine"), "Unfold line": i18n.t("editor.unfoldLine"),
    "folded code": i18n.t("editor.foldedCode"), "unfold": i18n.t("editor.unfoldLine"),
    "Folded lines": i18n.t("editor.foldedLines"), "Unfolded lines": i18n.t("editor.unfoldedLines"), "to": i18n.t("editor.lineRangeTo"),
    "Completions": i18n.t("editor.completions"),
  });
}

function CodeEditor({ tab, language, locked, active, onCursor, focusToolbar }: {
  tab: string; language: EditorLanguage; locked: boolean; active: boolean;
  onCursor: (position: string) => void; focusToolbar: () => void;
}) {
  const { t } = useTranslation();
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageConfig = useRef(new Compartment());
  const readOnlyConfig = useRef(new Compartment());
  const themeConfig = useRef(new Compartment());
  const phraseConfig = useRef(new Compartment());
  const [languageError, setLanguageError] = useState<EditorLanguage | null>(null);
  const [languageAttempt, setLanguageAttempt] = useState(0);
  const theme = useThemeStore((state) => state.theme);
  const focus = useCommandUiStore((state) => state.focus);
  const restoreLocation = useRef<(() => void) | null>(null);
  // 回调随渲染更新，编辑器扩展内始终读到最新值
  const handlers = useRef({ active, onCursor, focusToolbar });
  handlers.current = { active, onCursor, focusToolbar };

  useLayoutEffect(() => {
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
          lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), closeBrackets(),
          autocompletion({ defaultKeymap: false }),
          EditorState.languageData.of(() => [{ autocomplete: completeDocumentWords }]),
          search({ top: true }), highlightSelectionMatches(),
          themeConfig.current.of(editorTheme(useThemeStore.getState().theme)),
          languageConfig.current.of(editorLanguageIndent(language)),
          phraseConfig.current.of(editorPhrases()),
          readOnlyConfig.current.of(EditorState.readOnly.of(locked)),
          EditorState.changeFilter.of(() => {
            const state = useAppStore.getState();
            return !state.loading && !state.starting && !state.guarding;
          }),
          EditorView.contentAttributes.of({ "aria-label": i18n.t("editor.contentAria", { name: tab }), spellcheck: "false" }),
          keymap.of([
            ...completionKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap,
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
            ".cm-tooltip": { backgroundColor: "var(--surface-raised, #23252d)", color: "var(--text-primary, #ddd)", borderColor: "var(--border, #2a2b30)" },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--selection, #324869)", color: "var(--text-primary, #ddd)" },
            ".cm-foldPlaceholder": { backgroundColor: "var(--surface-raised, #23252d)", color: "var(--text-secondary, #9ba4b4)", borderColor: "var(--border, #2a2b30)" },
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
    return () => {
      // A restored file replaces its loading view; carry keyboard focus to the loaded document.
      const state = useAppStore.getState();
      const current = state.openTabs.find((file) => file.name === tab);
      if (editor.hasFocus && state.activeFile === tab && current && current.generation !== initial?.generation
        && workspaceRefEquals(source, state.workspace)) useCommandUiStore.setState({ focus: "editor" });
      capture(editor);
      editor.scrollDOM.removeEventListener("scroll", onScroll);
      editor.destroy(); view.current = null; restoreLocation.current = null;
    };
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

  useEffect(() => {
    if (focus === "editor" && active && view.current) {
      view.current.focus();
      useCommandUiStore.setState({ focus: null });
    }
  }, [focus, active]);

  useLayoutEffect(() => {
    setLanguageError(null);
    if (!view.current) return;
    return configureEditorLanguage(view.current, languageConfig.current, language, () => setLanguageError(language));
  }, [language, languageAttempt]);
  useEffect(() => { view.current?.dispatch({ effects: phraseConfig.current.reconfigure(editorPhrases()) }); }, [t]);
  useEffect(() => { view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(locked)) }); }, [locked]);
  useEffect(() => { view.current?.dispatch({ effects: themeConfig.current.reconfigure(editorTheme(theme)) }); }, [theme]);
  return <>
    {languageError === language && <div className="editor-error" role="status">
      {t("editor.languageLoadFailed", { language: language === "text" ? t("editor.plainText") : t(`editor.languages.${language}`) })}
      <button onClick={() => setLanguageAttempt((attempt) => attempt + 1)}>{t("editor.retryLanguage")}</button>
    </div>}
    <div className="code-editor" ref={parent} />
  </>;
}

export function Editor({ collapsed = false, onToggleCollapse }: { collapsed?: boolean; onToggleCollapse?: () => void }) {
  const { t } = useTranslation();
  const state = useAppStore(useShallow((s) => ({ tabs: s.openTabs, activeFile: s.activeFile,
    loading: s.loading, saving: s.saving, starting: s.starting, guarding: s.guarding,
    workspace: s.workspace, devices: s.devices, workspaceMutating: s.workspaceMutating,
    updating: s.updating,
    error: s.editorError, uploadBusy: uploadBusy(s) })));
  const [cursor, setCursor] = useState("1:1");
  const [tabMenu, setTabMenu] = useState<{
    x: number; y: number; name: string; generation: number;
    workspace: WorkspaceRef | null; workspaceGeneration: number; sourceRevision: string | null;
  } | null>(null);
  const languageSelect = useRef<HTMLSelectElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  useRevealActiveTab(tabStrip, state.activeFile);
  const tabId = (name: string) => `editor-tab-${encodeURIComponent(name)}`;
  const panelId = (name: string) => `editor-panel-${encodeURIComponent(name)}`;
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
      detail: scope === "current" ? shortcutLabel("closeFile") : undefined,
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
    {state.tabs.length === 0 ? <EmptyState icon="code" title={state.loading ? t("editor.opening") : t("editor.emptyTitle")} description={t("editor.placeholder")}>
      {state.workspace ? <span className="empty-state-shortcut">{t("editor.previewHint")}</span> : <span className="empty-state-shortcut"><kbd>{shortcutLabel("openWorkspace")}</kbd>{t("shortcuts.openWorkspace")}</span>}
    </EmptyState> : <>
      <div ref={tabStrip} className="editor-tabs center-panel-header" role="tablist" aria-label={t("editor.openTabs")} onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).getAttribute("role") !== "tab") return;
        const next = tabNavigationTarget(state.tabs.map((tab) => tab.name), state.activeFile ?? "", event.key);
        if (!next) return;
        event.preventDefault();
        useAppStore.getState().activateFile(next);
        const selected = useAppStore.getState().activeFile;
        if (selected) document.getElementById(tabId(selected))?.focus();
      }}>
        <button className="editor-collapse center-panel-collapse" data-tab-strip-inset aria-label={collapsed ? t("editor.expand") : t("editor.collapse")} aria-expanded={!collapsed}
          title={collapsed ? t("editor.expand") : t("editor.collapse")} onClick={onToggleCollapse}><Icon name={collapsed ? "chevronRight" : "chevronDown"} /></button>
        {state.tabs.map((tab) => (
          <div key={tab.name} data-active-tab={tab.name === state.activeFile}
            onContextMenu={(event) => openTabMenu(event, tab)}
            className={`editor-tab${tab.name === state.activeFile ? " active" : ""}${tab.preview ? " preview" : ""}`}>
            <button className="editor-tab-label" role="tab" id={tabId(tab.name)} aria-controls={panelId(tab.name)} aria-selected={tab.name === state.activeFile} tabIndex={tab.name === state.activeFile ? 0 : -1} title={tab.name}
              onDoubleClick={() => useAppStore.getState().pinFile(tab.name)}
              onClick={() => {
                useAppStore.getState().activateFile(tab.name);
                if (useAppStore.getState().activeFile === tab.name) useCommandUiStore.setState({ focus: "editor" });
              }}>
              <FileIcon name={tab.name} /><span>{nameOf(tab.name)}</span>{dirtyTab(tab) && <span className="editor-tab-dirty" aria-label={t("titlebar.unsavedChanges")} />}
            </button>
            <button className="editor-tab-close" tabIndex={tab.name === state.activeFile ? 0 : -1} aria-label={t("editor.closeTab", { name: tab.name })} title={shortcutTitle(t("editor.closeFileTitle"), "closeFile")}
              disabled={closeLocked}
              onClick={() => void useAppStore.getState().closeFile(tab.name)}><Icon name="close" /></button>
          </div>
        ))}
      </div>
      {/* 折叠时编辑器保持挂载仅隐藏 DOM，保留撤销历史、滚动位置与选区 */}
      <div className={`editor-body${collapsed ? " collapsed" : ""}`}>
        {active && <>
          {state.tabs.map((tab) => (
            <div key={`${tab.name}:${tab.generation}`}
              className={`tab-editor${tab.name === state.activeFile ? " active" : ""}`} role="tabpanel" id={panelId(tab.name)} aria-labelledby={tabId(tab.name)}>
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
                      title={shortcutTitle(t("menu.saveFile"), "saveFile")}
                      onClick={() => void executeAppCommand("saveFile")}>{t("editor.save")}</button>
                  : t("editor.saved")}
              {state.uploadBusy ? t("editor.uploadBusyHint") : ""}
            </span>
            <span className="editor-status-right">
              <select ref={languageSelect} aria-label={t("editor.languageAria")} value={active.language} disabled={locked}
                onChange={(event) => { if (isEditorLanguage(event.target.value)) useAppStore.getState().setLanguage(event.target.value); }}>
                {EDITOR_LANGUAGES.map(({ id }) => <option key={id} value={id}>{id === "text" ? t("editor.plainText") : t(`editor.languages.${id}`)}</option>)}
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
