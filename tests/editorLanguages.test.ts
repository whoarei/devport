import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { ensureSyntaxTree, foldable, getIndentation, indentUnit, language } from "@codemirror/language";
import { CompletionContext, completeFromList, type CompletionSource } from "@codemirror/autocomplete";
import { history, undo, undoDepth } from "@codemirror/commands";
import { EDITOR_LANGUAGES, inferLanguage, isEditorLanguage, type EditorLanguage } from "../src/editorLanguages";
import { completeDocumentWords, configureEditorLanguage, editorLanguageIndent, loadEditorLanguage } from "../src/editorLanguageSupport";
import { Editor } from "../src/components/Editor";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";

test("detects common source extensions and special configuration filenames in either path style", () => {
  const examples: Record<string, EditorLanguage> = {
    "src/MAIN.PYI": "python", "main.pyw": "python", "tools/run.ZSH": "shell", ".bashrc": "shell", "home/.profile": "shell",
    "C:\\workspace\\.zshrc": "shell", "profile.PS1": "powershell", "module.psm1": "powershell", "data.psd1": "powershell",
    "index.mjs": "javascript", "webpack.config.cjs": "javascript", "Component.JSX": "jsx", "index.mts": "typescript",
    "index.cts": "typescript", "types.d.ts": "typescript", "Component.TSX": "tsx", "index.htm": "html", "site.css": "css",
    "notebook.ipynb": "json", ".prettierrc": "json", "Pipfile.lock": "json", "settings.json": "json", "compose.YML": "yaml",
    ".clang-format": "yaml", "pyproject.toml": "toml", "Cargo.lock": "toml", "uv.lock": "toml", "Pipfile": "toml",
    ".editorconfig": "ini", ".gitconfig": "ini", ".gitmodules": "ini", "app.ini": "ini", "app.properties": "ini",
    "icon.svg": "xml", "project.csproj": "xml", "README.MD": "markdown", "main.c": "c", "stdio.h": "c",
    "main.cpp": "cpp", "device.hpp": "cpp", "demo.ino": "cpp", "Program.cs": "csharp", "Main.java": "java",
    "main.go": "go", "main.rs": "rust", "init.lua": "lua", "script.rb": "ruby", "Gemfile": "ruby", "index.php": "php",
    "schema.sql": "sql", "deploy/Dockerfile": "dockerfile", "Dockerfile.dev": "dockerfile", "Containerfile": "dockerfile",
    "build.containerfile": "dockerfile", "app.dockerfile": "dockerfile", "C:\\src\\CMakeLists.txt": "cmake", "config.cmake": "cmake",
    "nginx.conf": "nginx", "nginx.dev.conf": "nginx", "fix.patch": "diff", "changes.diff": "diff",
    "README": "text", "notes.txt": "text", "unknown.bin": "text", "sshd_config": "text", "server.conf": "text", "": "text",
    // Inspect only the basename, never a parent directory's suffix or a partial special name.
    "folder.py/unknown": "text", "folder/.gitconfig.backup": "text", "notDockerfile": "text", "CMakeLists.txt.bak": "text",
  };
  for (const [path, expected] of Object.entries(examples)) assert.equal(inferLanguage(path), expected, path);
});

test("frontend modes match the backend snapshot allowlist", () => {
  const rust = readFileSync("src-tauri/src/work_environment.rs", "utf8");
  const list = /const EDITOR_LANGUAGES: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust);
  assert.ok(list, "backend language allowlist is missing");
  assert.deepEqual([...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(), EDITOR_LANGUAGES.map((entry) => entry.id).sort());
  assert.equal(isEditorLanguage("typescript"), true);
  for (const value of ["", "TypeScript", "__proto__", "unknown"]) assert.equal(isEditorLanguage(value), false);
});

const samples: Record<Exclude<EditorLanguage, "text">, string> = {
  python: "def greet(name):\n    return name\n",
  shell: "if true; then\n  echo hello\nfi\n",
  powershell: "function Get-Hello {\n    Write-Output 'hello'\n}\n",
  javascript: "function greet(name) {\n  return name;\n}\n",
  jsx: "const view = <div title='hello'>World</div>;\n",
  typescript: "const value: number = 42;\n",
  tsx: "const view = (name: string) => <div>{name}</div>;\n",
  html: "<html>\n  <body>Hello</body>\n</html>\n",
  css: ".hello {\n  color: red;\n}\n",
  json: '{\n  "hello": true\n}\n',
  yaml: "hello:\n  enabled: true\n",
  toml: '[hello]\nenabled = true\n',
  ini: "[hello]\nenabled = true\n",
  xml: '<hello>\n  <item enabled="true" />\n</hello>\n',
  markdown: "# Hello\n\n**world**\n\n```python\nprint('hello')\n```\n",
  c: "int main(void) {\n    return 0;\n}\n",
  cpp: "class Hello {\n    int value = 42;\n};\n",
  csharp: "class Hello {\n    int value = 42;\n}\n",
  java: "class Hello {\n    int value = 42;\n}\n",
  go: 'package main\nfunc main() {\n\tprintln("hello")\n}\n',
  rust: 'fn main() {\n    println!("hello");\n}\n',
  lua: "function hello()\n  return true\nend\n",
  ruby: "def hello\n  puts 'hello'\nend\n",
  php: "<?php\nfunction hello() {\n    return true;\n}\n",
  sql: "SELECT name FROM users WHERE enabled = TRUE;\n",
  dockerfile: "FROM python:3.12\nRUN echo hello\n",
  cmake: "if(ENABLED)\n  message(STATUS hello)\nendif()\n",
  nginx: "server {\n  listen 80;\n}\n",
  diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
};

test("each syntax mode loads and parses representative source, including JSX/TSX and config formats", async (t) => {
  for (const [id, doc] of Object.entries(samples)) await t.test(id, async () => {
    const state = EditorState.create({ doc, extensions: [await loadEditorLanguage(id as EditorLanguage)] });
    assert.ok(state.facet(language), id);
    const tree = ensureSyntaxTree(state, doc.length, 1000);
    assert.ok(tree?.topNode.firstChild, `missing tokens for ${id}`);
    const errors: string[] = [];
    tree.iterate({ enter: (node) => { if (node.type.isError) errors.push(doc.slice(node.from, node.to)); } });
    assert.deepEqual(errors, [], `unexpected parse errors for ${id}`);
  });
  const text = EditorState.create({ doc: "just text", extensions: [await loadEditorLanguage("text")] });
  assert.equal(text.facet(language), null);
});

test("native and legacy modes expose folding and appropriate indentation", async () => {
  for (const id of ["python", "javascript", "json", "yaml", "shell", "powershell", "csharp", "ruby", "nginx"] as const) {
    const state = EditorState.create({ doc: samples[id], extensions: [await loadEditorLanguage(id), editorLanguageIndent(id)] });
    ensureSyntaxTree(state, state.doc.length, 1000);
    const line = state.doc.line(1);
    const range = foldable(state, line.from, line.to);
    assert.ok(range && range.from >= line.to && range.to > range.from, id);
  }
  const python = EditorState.create({ doc: samples.python, extensions: [await loadEditorLanguage("python"), editorLanguageIndent("python")] });
  assert.equal(getIndentation(python, python.doc.line(2).from), 4);
  assert.equal(python.facet(indentUnit), "    ");
  assert.equal(EditorState.create({ extensions: [editorLanguageIndent("shell")] }).facet(indentUnit), "  ");
  assert.equal(EditorState.create({ extensions: [editorLanguageIndent("go")] }).facet(indentUnit), "\t");
});

test("language-provided completions and document words remain available together", async () => {
  const state = EditorState.create({ doc: "customWord\ncu", extensions: [await loadEditorLanguage("shell"),
    EditorState.languageData.of(() => [{ autocomplete: completeDocumentWords }])] });
  const sources = state.languageDataAt<CompletionSource | readonly string[]>("autocomplete", state.doc.length);
  assert.ok(sources.includes(completeDocumentWords));
  assert.ok(sources.some((source) => source !== completeDocumentWords), "shell keyword completions must not be replaced");
  const context = new CompletionContext(state, state.doc.length, true);
  const words = await completeDocumentWords(context);
  assert.ok(words?.options.some((option) => option.label === "customWord"));
  assert.ok(words?.options.every((option) => option.type === undefined), "word fallback must not conflict with symbol types");
  const keywordOptions = await Promise.all(sources.filter((source) => source !== completeDocumentWords)
    .map((source) => (typeof source === "function" ? source : completeFromList(source))(context)));
  assert.ok(keywordOptions.some((result) => result?.options.some((option) => option.label === "echo")));
});

test("late imports cannot overwrite a newer language or a destroyed editor; errors retain editable content", async () => {
  const compartment = new Compartment();
  let state = EditorState.create({ doc: "original", extensions: [history(), compartment.of([])] });
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "unchanged" }, selection: { anchor: 3 } }).state;
  const view = { get state() { return state; }, dispatch: (spec: Parameters<EditorState["update"]>[0]) => { state = state.update(spec).state; } };
  const deferred = () => {
    let resolve!: (value: Extension) => void, reject!: (reason: Error) => void;
    const promise = new Promise<Extension>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const slow = deferred();
  let errors = 0;
  const stop = configureEditorLanguage(view, compartment, "python", () => { errors++; }, () => slow.promise);
  stop();
  const current = configureEditorLanguage(view, compartment, "shell", () => { errors++; });
  await new Promise((resolve) => setImmediate(resolve));
  slow.resolve(await loadEditorLanguage("python"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.facet(language)?.name, "shell");
  assert.equal(state.facet(indentUnit), "  ");
  current();

  const pending = deferred();
  const destroy = configureEditorLanguage(view, compartment, "rust", () => { errors++; }, () => pending.promise);
  destroy();
  pending.reject(new Error("closed view"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 0);

  const failure = deferred();
  configureEditorLanguage(view, compartment, "json", () => { errors++; }, () => failure.promise);
  failure.reject(new Error("missing chunk"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 1);
  assert.equal(state.facet(language), null);
  assert.equal(state.doc.toString(), "unchanged");
  assert.equal(state.selection.main.head, 3);
  assert.equal(undoDepth(state), 1, "reconfiguring languages must retain the undo history");
  assert.equal(undo(view), true);
  assert.equal(state.doc.toString(), "original");
  state = state.update({ changes: { from: state.doc.length, insert: " edit" } }).state;
  assert.equal(state.doc.toString(), "original edit");
});

test("the language selector exposes all modes in both UI languages", async (t) => {
  const previous = useAppStore.getState(), previousLanguage = i18n.language;
  t.after(async () => { useAppStore.setState(previous, true); await i18n.changeLanguage(previousLanguage); });
  t.mock.method(React, "useSyncExternalStore", (_subscribe, getSnapshot) => getSnapshot());
  useAppStore.setState({ openTabs: [{ name: "file.tsx", language: "tsx", loaded: true, fileContent: "", savedContent: "",
    revision: "v1", eol: "lf", bom: false, conflict: false, generation: 1 }], activeFile: "file.tsx" });
  for (const lng of ["zh", "en"]) {
    await i18n.changeLanguage(lng);
    // SSR does not create editor views; silence React's expected useLayoutEffect warning.
    const warning = t.mock.method(console, "error", () => {});
    const markup = renderToStaticMarkup(createElement(Editor));
    warning.mock.restore();
    assert.equal([...markup.matchAll(/<option /g)].length, EDITOR_LANGUAGES.length);
    for (const { id } of EDITOR_LANGUAGES) {
      const key = id === "text" ? "editor.plainText" : `editor.languages.${id}`;
      assert.notEqual(i18n.t(key), key);
      assert.ok(markup.includes(`value="${id}"`), id);
    }
    assert.match(markup, /value="tsx" selected=""/);
  }
});
