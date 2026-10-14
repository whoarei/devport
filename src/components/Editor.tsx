import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useAppStore } from "../store";
import { dirtyTab, EditorLanguage, EditorTab, uploadBusy } from "../editorDocument";
import { nameOf } from "../workspaceTree";

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
  // 回调随渲染更新，编辑器扩展内始终读到最新值
  const handlers = useRef({ active, onCursor, focusToolbar });
  handlers.current = { active, onCursor, focusToolbar };

  useEffect(() => {
    if (!parent.current) return;
    const report = (state: EditorState) => {
      if (!handlers.current.active) return;
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      handlers.current.onCursor(`${line.number}:${pos - line.from + 1}`);
    };
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: useAppStore.getState().openTabs.find((t) => t.name === tab)?.fileContent ?? "",
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), closeBrackets(),
          search({ top: true }), highlightSelectionMatches(),
          syntaxHighlighting(oneDarkHighlightStyle),
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
          }),
          EditorView.theme({
            "&": { height: "100%", color: "#ddd", backgroundColor: "#17181c" },
            ".cm-scroller": { overflow: "auto", fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: "13px", lineHeight: "1.5" },
            ".cm-content": { padding: "10px 0", caretColor: "#fff" },
            ".cm-cursor": { borderLeftColor: "#fff" },
            ".cm-gutters": { backgroundColor: "#17181c", color: "#7d8595", borderRight: "1px solid #2a2b30" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#ffffff09" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#324869" },
            ".cm-panels": { backgroundColor: "#23252d", color: "#ddd" },
          }, { dark: true }),
        ],
      }),
    });
    view.current = editor;
    report(editor.state);
    return () => { editor.destroy(); view.current = null; };
    // A document generation remounts this component; ordinary edits preserve history.
  }, []);

  // 重新可见时重新测量并上报光标（display:none 期间 CodeMirror 尺寸为 0）
  useEffect(() => {
    if (!active || !view.current) return;
    view.current.requestMeasure();
    const pos = view.current.state.selection.main.head;
    const line = view.current.state.doc.lineAt(pos);
    onCursor(`${line.number}:${pos - line.from + 1}`);
  }, [active]);

  useEffect(() => { view.current?.dispatch({ effects: languageConfig.current.reconfigure(languageExtension(language)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(locked)) }); }, [locked]);
  return <div className="code-editor" ref={parent} />;
}

export function Editor({ collapsed = false, onToggleCollapse }: { collapsed?: boolean; onToggleCollapse?: () => void }) {
  const { t } = useTranslation();
  const state = useAppStore(useShallow((s) => ({ tabs: s.openTabs, activeFile: s.activeFile,
    loading: s.loading, saving: s.saving, starting: s.starting, guarding: s.guarding,
    error: s.editorError, uploadBusy: uploadBusy(s) })));
  const [cursor, setCursor] = useState("1:1");
  const languageSelect = useRef<HTMLSelectElement>(null);
  const locked = state.loading || state.starting || state.guarding;
  const active = state.tabs.find((tab) => tab.name === state.activeFile);
  return <div className={`editor${state.tabs.length === 0 ? " empty" : ""}`}>
    {state.error && <div className="editor-error" role="alert">{state.error}
      {active?.conflict && <button disabled={locked || state.saving} onClick={() => void useAppStore.getState().reloadFile()}>{t("editor.reloadDisk")}</button>}
    </div>}
    {state.tabs.length === 0 ? <p>{state.loading ? t("editor.opening") : t("editor.placeholder")}</p> : <>
      <div className="editor-tabs center-panel-header" role="tablist" aria-label={t("editor.openTabs")}>
        <button className="editor-collapse center-panel-collapse" aria-label={collapsed ? t("editor.expand") : t("editor.collapse")} aria-expanded={!collapsed}
          title={collapsed ? t("editor.expand") : t("editor.collapse")} onClick={onToggleCollapse}>{collapsed ? "▸" : "▾"}</button>
        {state.tabs.map((tab) => (
          <div key={tab.name} role="tab" aria-selected={tab.name === state.activeFile}
            className={`editor-tab${tab.name === state.activeFile ? " active" : ""}`}>
            <button className="editor-tab-label" title={tab.name}
              onClick={() => useAppStore.getState().activateFile(tab.name)}>
              {nameOf(tab.name)}{dirtyTab(tab) ? " ●" : ""}
            </button>
            <button className="editor-tab-close" aria-label={t("editor.closeTab", { name: tab.name })} title={t("editor.closeFileTitle")}
              disabled={locked || state.saving}
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
              <CodeEditor tab={tab.name} language={tab.language} locked={locked}
                active={tab.name === state.activeFile && !collapsed} onCursor={setCursor}
                focusToolbar={() => languageSelect.current?.focus()} />
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
  </div>;
}
