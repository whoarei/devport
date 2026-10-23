import { Compartment, countColumn, type Extension } from "@codemirror/state";
import { foldService, indentUnit, LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { completeAnyWord, type CompletionSource } from "@codemirror/autocomplete";
import { EDITOR_LANGUAGES, editorLanguageDefinition, type EditorLanguage } from "./editorLanguages";

export const completeDocumentWords: CompletionSource = async (context) => {
  const result = await completeAnyWord(context);
  // Leave word types unspecified so CodeMirror can merge an identical language
  // candidate and keep its richer symbol type instead of showing it twice.
  return result && { ...result, options: result.options.map(({ type: _type, ...option }) => option) };
};

/** Legacy tokenizers have no syntax tree for folding. Fold their indented blocks. */
const indentationFolding = foldService.of((state, from, to) => {
  const first = state.doc.lineAt(from);
  if (!first.text.trim()) return null;
  const indentation = (text: string) => countColumn(/^\s*/.exec(text)![0], state.tabSize);
  const base = indentation(first.text);
  let end = to;
  for (let number = first.number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (!line.text.trim()) continue;
    if (indentation(line.text) <= base) break;
    end = line.to;
  }
  return end > to ? { from: to, to: end } : null;
});

const legacy = <State>(parser: StreamParser<State>) => new LanguageSupport(StreamLanguage.define(parser), indentationFolding);

const loaders: Record<Exclude<EditorLanguage, "text">, () => Promise<LanguageSupport>> = {
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  shell: () => import("@codemirror/legacy-modes/mode/shell").then((m) => legacy(m.shell)),
  powershell: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => legacy(m.powerShell)),
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => legacy(m.toml)),
  ini: () => import("@codemirror/legacy-modes/mode/properties").then((m) => legacy(m.properties)),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown({ base: m.markdownLanguage, codeLanguages: languageDescriptions })),
  c: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  csharp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => legacy(m.csharp)),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => legacy(m.lua)),
  ruby: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => legacy(m.ruby)),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => legacy(m.dockerFile)),
  cmake: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => legacy(m.cmake)),
  nginx: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => legacy(m.nginx)),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => legacy(m.diff)),
};

// LanguageDescription caches in-flight/successful loads and allows retry after a failure.
export const languageDescriptions = EDITOR_LANGUAGES.filter((definition) => definition.id !== "text").map((definition) => {
  const metadata = editorLanguageDefinition(definition.id);
  return LanguageDescription.of({ ...metadata, alias: [definition.id, ...metadata.alias ?? []], load: loaders[definition.id] });
});

export async function loadEditorLanguage(language: EditorLanguage): Promise<Extension> {
  if (language === "text") return [];
  return languageDescriptions.find((description) => description.name === editorLanguageDefinition(language).name)!.load();
}

export function editorLanguageIndent(language: EditorLanguage): Extension {
  return indentUnit.of(editorLanguageDefinition(language).indent);
}

/** Cancel on language changes or view destruction so old imports cannot reconfigure a new document. */
export function configureEditorLanguage(view: Pick<EditorView, "dispatch">, compartment: Compartment, language: EditorLanguage,
  onError: () => void, load = loadEditorLanguage): () => void {
  let cancelled = false;
  const indentation = editorLanguageIndent(language);
  view.dispatch({ effects: compartment.reconfigure(indentation) });
  void load(language).then((support) => {
    if (!cancelled) view.dispatch({ effects: compartment.reconfigure([indentation, support]) });
  }, () => { if (!cancelled) onError(); });
  return () => { cancelled = true; };
}
