/** Metadata only: file browsing and session state must not load editor parsers. */
interface LanguageDefinition {
  id: string;
  name: string;
  extensions: readonly string[];
  filenames?: readonly string[];
  filename?: RegExp;
  alias?: readonly string[];
  indent: string;
}

export const EDITOR_LANGUAGES = [
  { id: "python", name: "Python", extensions: ["py", "pyw", "pyi"], indent: "    " },
  { id: "shell", name: "Shell", alias: ["sh", "bash", "zsh", "ksh"], extensions: ["sh", "bash", "zsh", "ksh"],
    filenames: [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".kshrc"], indent: "  " },
  { id: "powershell", name: "PowerShell", alias: ["ps1", "pwsh"], extensions: ["ps1", "psm1", "psd1"], indent: "    " },
  { id: "javascript", name: "JavaScript", alias: ["js"], extensions: ["js", "mjs", "cjs"], indent: "  " },
  { id: "jsx", name: "JSX", extensions: ["jsx"], indent: "  " },
  { id: "typescript", name: "TypeScript", alias: ["ts"], extensions: ["ts", "mts", "cts"], indent: "  " },
  { id: "tsx", name: "TSX", extensions: ["tsx"], indent: "  " },
  { id: "html", name: "HTML", extensions: ["html", "htm"], indent: "  " },
  { id: "css", name: "CSS", extensions: ["css"], indent: "  " },
  { id: "json", name: "JSON", extensions: ["json", "map", "webmanifest", "ipynb"],
    filenames: [".babelrc", ".eslintrc", ".prettierrc", "pipfile.lock"], indent: "  " },
  { id: "yaml", name: "YAML", alias: ["yml"], extensions: ["yaml", "yml"], filenames: [".clang-format", ".clang-tidy", ".yamllint"], indent: "  " },
  { id: "toml", name: "TOML", extensions: ["toml"], filenames: ["cargo.lock", "uv.lock", "poetry.lock", "pipfile"], indent: "  " },
  { id: "ini", name: "INI", alias: ["properties"], extensions: ["ini", "cfg", "properties"],
    filenames: [".editorconfig", ".gitconfig", ".gitmodules", ".npmrc", ".pypirc", ".coveragerc"], indent: "  " },
  { id: "xml", name: "XML", alias: ["svg"], extensions: ["xml", "xsd", "xsl", "xslt", "svg", "plist", "csproj", "props", "targets", "resx", "ui", "qrc", "xaml"], indent: "  " },
  { id: "markdown", name: "Markdown", alias: ["md"], extensions: ["md", "markdown", "mdown", "mkd"], indent: "  " },
  { id: "c", name: "C", extensions: ["c", "h"], indent: "    " },
  { id: "cpp", name: "C++", alias: ["cpp", "cxx"], extensions: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ino"], indent: "    " },
  { id: "csharp", name: "C#", alias: ["csharp", "cs"], extensions: ["cs", "csx"], indent: "    " },
  { id: "java", name: "Java", extensions: ["java"], indent: "    " },
  { id: "go", name: "Go", alias: ["golang"], extensions: ["go"], indent: "\t" },
  { id: "rust", name: "Rust", alias: ["rs"], extensions: ["rs"], indent: "    " },
  { id: "lua", name: "Lua", extensions: ["lua"], indent: "  " },
  { id: "ruby", name: "Ruby", alias: ["rb"], extensions: ["rb", "rake", "gemspec"], filenames: ["gemfile", "rakefile", "vagrantfile", ".irbrc"], indent: "  " },
  { id: "php", name: "PHP", extensions: ["php", "phtml", "php3", "php4", "php5"], indent: "    " },
  { id: "sql", name: "SQL", extensions: ["sql"], indent: "    " },
  { id: "dockerfile", name: "Dockerfile", alias: ["docker"], extensions: ["dockerfile", "containerfile"], filename: /^(?:dockerfile|containerfile)(?:\..+)?$/i, indent: "  " },
  { id: "cmake", name: "CMake", extensions: ["cmake"], filenames: ["cmakelists.txt"], indent: "  " },
  { id: "nginx", name: "Nginx", extensions: [], filename: /^nginx(?:\..+)?\.conf$/i, indent: "  " },
  { id: "diff", name: "Diff", alias: ["patch"], extensions: ["diff", "patch"], indent: "    " },
  { id: "text", name: "Plain text", extensions: ["txt", "text"], indent: "    " },
] as const satisfies readonly LanguageDefinition[];

export type EditorLanguage = typeof EDITOR_LANGUAGES[number]["id"];

const definitions: readonly (LanguageDefinition & { id: EditorLanguage })[] = EDITOR_LANGUAGES;
export const editorLanguageDefinition = (language: EditorLanguage): LanguageDefinition =>
  definitions.find((definition) => definition.id === language)!;

export function isEditorLanguage(value: string): value is EditorLanguage {
  return definitions.some((definition) => definition.id === value);
}

export function inferLanguage(path: string): EditorLanguage {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  // Special names take priority over extensions (e.g. CMakeLists.txt).
  const named = definitions.find((definition) => definition.filenames?.includes(name) || definition.filename?.test(name));
  if (named) return named.id;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "text";
  return definitions.find((definition) => definition.extensions.includes(name.slice(dot + 1)))?.id ?? "text";
}
