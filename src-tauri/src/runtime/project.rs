//! ProjectInspector：uv 项目契约校验（00027 §5）。
//!
//! 项目根必须包含 pyproject.toml、uv.lock、.python-version；
//! 只支持 uv 项目模型，根项目不安装进环境（--no-install-project）。
use crate::error::{Result, RunnerError};
use crate::runtime::code;
use serde::Serialize;
use sha2::Digest;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryMode {
    Script,
    Module,
}

/// 校验通过的 Python 项目（Managed Runtime 运行输入）
#[derive(Debug, Clone, Serialize)]
pub struct PythonProject {
    pub name: String,
    pub requires_python: String,
    /// .python-version 中的 CPython 请求（如 3.12 或 3.12.9）。
    pub python_version: String,
    pub lock_sha256: String,
    pub entry: String,
    pub mode: EntryMode,
    /// 已验证的工作区内相对目录，运行时加入 PYTHONPATH
    pub python_path: Vec<String>,
    pub groups: Vec<String>,
    pub extras: Vec<String>,
    /// 规范化包源身份（Environment ID 输入之一）
    pub package_source_identity: String,
    #[serde(skip)]
    pub workspace: PathBuf,
    /// Exact bounded metadata consumed by this plan, including legacy callers.
    #[serde(skip)]
    pub input_hashes: Vec<(String, String)>,
}

impl PythonProject {
    /// Resolve a minor request within the project's compatibility constraints.
    pub fn python_request(&self) -> String {
        if self.python_version.split('.').count() == 2 {
            format!("=={}.*,{}", self.python_version, self.requires_python)
        } else {
            self.python_version.clone()
        }
    }
}

fn invalid(message: impl Into<String>) -> RunnerError {
    RunnerError::managed(code::INVALID_PROJECT, message)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// CPython minor or patch request; no ranges, variants, or multiple versions.
fn parse_python_version(text: &str) -> Result<String> {
    let v = text.trim();
    let parts: Vec<_> = v.split('.').collect();
    let parsed = parse_version(v);
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        || parsed.is_none()
    {
        return Err(RunnerError::managed(
            code::INVALID_PYTHON_VERSION,
            format!(
                ".python-version must be a CPython minor or patch version like 3.12 or 3.12.9, got {v:?}"
            ),
        ));
    }
    let parsed = parsed.unwrap();
    Ok(if parts.len() == 2 {
        format!("{}.{}", parsed.major, parsed.minor)
    } else {
        format!("{}.{}.{}", parsed.major, parsed.minor, parsed.patch)
    })
}

pub fn python_version_matches(request: &str, actual: &str) -> bool {
    crate::runtime::catalog::is_exact_version(actual)
        && parse_version(actual).is_some()
        && (actual == request
            || request.split('.').count() == 2 && actual.starts_with(&format!("{request}.")))
}

fn request_satisfies_requires_python(request: &str, spec: &str) -> bool {
    if request.split('.').count() == 3 {
        return satisfies_requires_python(spec, request);
    }
    // Find the smallest possible patch from lower bounds, skip excluded patches,
    // then check all clauses once. Do not interpret a minor request as patch zero.
    let mut patch = 0;
    let mut excluded = std::collections::BTreeSet::new();
    for clause in spec.split(',') {
        let raw = clause
            .trim()
            .trim_start_matches(['<', '>', '=', '!', '~'])
            .trim();
        if let Some(version) = parse_version(raw.strip_suffix(".*").unwrap_or(raw)) {
            let base = format!("{}.{}", version.major, version.minor);
            if base == request {
                let clause = clause.trim();
                let wildcard = raw.ends_with(".*");
                if clause.starts_with(">=")
                    || clause.starts_with("~=")
                    || clause.starts_with("==") && !wildcard
                {
                    patch = patch.max(version.patch);
                } else if clause.starts_with('>') {
                    let Some(next) = version.patch.checked_add(1) else {
                        return false;
                    };
                    patch = patch.max(next);
                } else if clause.starts_with("!=") && !wildcard {
                    excluded.insert(version.patch);
                }
            }
        }
    }
    while excluded.contains(&patch) {
        let Some(next) = patch.checked_add(1) else {
            return false;
        };
        patch = next;
    }
    satisfies_requires_python(spec, &format!("{request}.{patch}"))
}

/// 解析 requires-python 为子句列表，逐条校验精确版本是否满足（PEP 440 常用子集）
pub fn satisfies_requires_python(spec: &str, version: &str) -> bool {
    let ver = match parse_version(version) {
        Some(v) => v,
        None => return false,
    };
    spec.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .all(|clause| {
            // 操作符可与版本紧邻（==3.12.*）或以空白分隔（== 3.12.*）
            const OPS: [&str; 8] = ["~=", "===", "==", "!=", "<=", ">=", "<", ">"];
            match OPS.iter().find(|op| clause.starts_with(**op)) {
                Some(op) => check_clause(op, clause[op.len()..].trim(), ver),
                None => false,
            }
        })
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

fn parse_version(v: &str) -> Option<Version> {
    let mut parts = v.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version {
        major,
        minor,
        patch,
    })
}

fn check_clause(op: &str, raw: &str, ver: Version) -> bool {
    let (wildcard, base) = match raw.strip_suffix(".*") {
        Some(b) => (true, b),
        None => (false, raw),
    };
    // ~=X.Y allows later minors within X; ~=X.Y.Z stays within X.Y.
    if op == "~=" && !wildcard {
        let Some(lower) = parse_version(base) else {
            return false;
        };
        let upper = if base.split('.').count() == 2 {
            let Some(major) = lower.major.checked_add(1) else {
                return false;
            };
            Version {
                major,
                minor: 0,
                patch: 0,
            }
        } else {
            let Some(minor) = lower.minor.checked_add(1) else {
                return false;
            };
            Version {
                major: lower.major,
                minor,
                patch: 0,
            }
        };
        return ver >= lower && ver < upper;
    }
    if wildcard && op != "==" && op != "!=" {
        return false;
    }
    let Some(v) = parse_version(base) else {
        return false;
    };
    match op {
        "==" => {
            if wildcard {
                ver.major == v.major && ver.minor == v.minor
            } else {
                ver == v
            }
        }
        "!=" => {
            if wildcard {
                !(ver.major == v.major && ver.minor == v.minor)
            } else {
                ver != v
            }
        }
        ">=" => ver >= v,
        "<=" => ver <= v,
        ">" => ver > v,
        "<" => ver < v,
        _ => false,
    }
}

/// module name 语法：点分段标识符
fn is_module_name(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

/// 工作区内相对路径（无 dot component、无 NUL、posix 分隔符）
fn relative_workspace_path(raw: &str) -> Option<String> {
    let p = raw.replace('\\', "/");
    if p.is_empty()
        || p.starts_with('/')
        || p.contains(['\0', ':'])
        || p.split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(p)
}

/// 首版拒绝本地路径依赖 / editable / workspace member / 特殊安装源
fn reject_disallowed_dependencies(deps: &[toml::Value], where_: &str) -> Result<()> {
    for dep in deps {
        let Some(req) = dep.as_str() else {
            return Err(invalid(format!("{where_} dependencies must be strings")));
        };
        let lowered = req.to_ascii_lowercase();
        if lowered.starts_with("-e ")
            || lowered.contains(" @ file:")
            || lowered.contains(" @ ./")
            || lowered.contains(" @ ../")
        {
            return Err(invalid(format!(
                "local path / editable dependencies are not supported (00027 §5): {req}"
            )));
        }
    }
    Ok(())
}

fn string_array(value: Option<&toml::Value>, where_: &str) -> Result<Vec<String>> {
    match value {
        None => Ok(Vec::new()),
        Some(toml::Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| invalid(format!("{where_} must be an array of strings")))
            })
            .collect(),
        Some(_) => Err(invalid(format!("{where_} must be an array of strings"))),
    }
}

/// 校验工作区并提取 Managed Runtime 运行输入
pub fn inspect(workspace: &Path) -> Result<PythonProject> {
    let root = std::fs::canonicalize(workspace).map_err(|_| {
        invalid(format!(
            "workspace is not accessible: {}",
            workspace.display()
        ))
    })?;
    if !root.is_dir() {
        return Err(invalid("workspace must be a directory"));
    }

    // 1. 项目契约三件套
    let pyproject_text = std::fs::read_to_string(root.join("pyproject.toml"))
        .map_err(|_| invalid("pyproject.toml is required for managed Python projects"))?;
    let version_text = std::fs::read_to_string(root.join(".python-version")).map_err(|_| {
        RunnerError::managed(code::INVALID_PYTHON_VERSION, ".python-version is required")
    })?;
    let lock_bytes = std::fs::read(root.join("uv.lock")).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => RunnerError::managed(
            code::MISSING_LOCK,
            "uv.lock is required; run `uv lock` and commit the lockfile",
        ),
        _ => RunnerError::Io(e),
    })?;
    parse_inputs(root, &pyproject_text, &version_text, &lock_bytes, None)
}

/// Manifest parsing is independent of source location and execution entry. New
/// workspace runs validate descendants with the source host's no-follow API.
pub fn parse_inputs(
    root: PathBuf,
    pyproject_text: &str,
    version_text: &str,
    lock_bytes: &[u8],
    launch: Option<(&str, bool)>,
) -> Result<PythonProject> {
    let mut lines = version_text.lines().filter(|l| !l.trim().is_empty());
    let python_version = parse_python_version(lines.next().unwrap_or(""))?;
    if lines.next().is_some() {
        return Err(RunnerError::managed(
            code::INVALID_PYTHON_VERSION,
            ".python-version must contain exactly one version",
        ));
    }
    if pyproject_text.len() > 1024 * 1024 || version_text.len() > 4096 {
        return Err(invalid("Python project metadata is too large"));
    }
    if lock_bytes.len() > crate::runtime::LOCK_LIMIT {
        return Err(RunnerError::managed(
            code::INVALID_PROJECT,
            format!(
                "uv.lock exceeds {} MiB",
                crate::runtime::LOCK_LIMIT / (1024 * 1024)
            ),
        ));
    }
    let lock_sha256 = sha256_hex(&lock_bytes);

    // 2. pyproject 结构
    let pyproject: toml::Value = pyproject_text
        .parse::<toml::Table>()
        .map_err(|e| invalid(format!("pyproject.toml is not valid TOML: {e}")))?
        .into();
    let project = pyproject
        .get("project")
        .and_then(toml::Value::as_table)
        .ok_or_else(|| invalid("pyproject.toml must have a [project] table"))?;
    let name = project
        .get("name")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| invalid("[project].name is required"))?
        .to_string();
    let requires_python = project
        .get("requires-python")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| invalid("[project].requires-python is required"))?
        .to_string();
    if !request_satisfies_requires_python(&python_version, &requires_python) {
        return Err(RunnerError::managed(
            code::VERSION_MISMATCH,
            format!(".python-version {python_version} does not satisfy requires-python {requires_python:?}"),
        ));
    }
    let dependencies = string_array(project.get("dependencies"), "[project].dependencies")?;
    reject_disallowed_dependencies(
        &dependencies
            .iter()
            .map(|d| toml::Value::String(d.clone()))
            .collect::<Vec<_>>(),
        "[project].dependencies",
    )?;
    let optional_dependencies = project
        .get("optional-dependencies")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    for (extra, deps) in &optional_dependencies {
        reject_disallowed_dependencies(
            deps.as_array()
                .ok_or_else(|| invalid("[project.optional-dependencies] values must be arrays"))?,
            &format!("[project.optional-dependencies].{extra}"),
        )?;
    }
    let dependency_groups = pyproject
        .get("dependency-groups")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    for (group, deps) in &dependency_groups {
        reject_disallowed_dependencies(
            deps.as_array()
                .ok_or_else(|| invalid("[dependency-groups] values must be arrays"))?,
            &format!("[dependency-groups].{group}"),
        )?;
    }

    // 3. uv 专属限制：workspace member 与本地源首版明确拒绝
    let tool_uv = pyproject
        .get("tool")
        .and_then(|t| t.get("uv"))
        .and_then(toml::Value::as_table);
    if let Some(uv) = tool_uv {
        if uv.contains_key("workspace") {
            return Err(invalid(
                "uv workspace members are not supported in this version",
            ));
        }
        if let Some(sources) = uv.get("sources").and_then(toml::Value::as_table) {
            for (pkg, source) in sources {
                let bad = source.as_table().is_some_and(|t| {
                    t.contains_key("path")
                        || t.contains_key("editable")
                        || t.contains_key("workspace")
                });
                if bad {
                    return Err(invalid(format!(
                        "local path / editable / workspace source for {pkg} is not supported"
                    )));
                }
            }
        }
    }

    // 4. uv.lock 基本健全性（过期/不一致由远端 `uv sync --locked` 判定）
    let lock: toml::Value = std::str::from_utf8(&lock_bytes)
        .map_err(|_| RunnerError::managed(code::INVALID_PROJECT, "uv.lock must be UTF-8 TOML"))?
        .parse::<toml::Table>()
        .map_err(|e| {
            RunnerError::managed(
                code::INVALID_PROJECT,
                format!("uv.lock is not valid TOML: {e}"),
            )
        })?
        .into();
    if lock.get("version").is_none() && lock.get("package").is_none() {
        return Err(RunnerError::managed(
            code::INVALID_PROJECT,
            "uv.lock does not look like a uv lockfile",
        ));
    }

    // 5. [tool.remote-runner] 运行配置
    let empty = toml::Table::new();
    let rr = pyproject
        .get("tool")
        .and_then(|t| t.get("remote-runner"))
        .and_then(toml::Value::as_table)
        .or_else(|| launch.map(|_| &empty))
        .ok_or_else(|| invalid("pyproject.toml must have a [tool.remote-runner] table"))?;
    let mode = if let Some((_, module)) = launch {
        if module {
            EntryMode::Module
        } else {
            EntryMode::Script
        }
    } else {
        match rr
            .get("mode")
            .and_then(toml::Value::as_str)
            .unwrap_or("script")
        {
            "script" => EntryMode::Script,
            "module" => EntryMode::Module,
            other => {
                return Err(invalid(format!(
                    "mode must be \"script\" or \"module\", got {other:?}"
                )))
            }
        }
    };
    let entry_raw = launch
        .map(|(entry, _)| entry)
        .or_else(|| rr.get("entry").and_then(toml::Value::as_str))
        .ok_or_else(|| invalid("[tool.remote-runner].entry is required"))?;
    let entry = if mode == EntryMode::Module {
        if !is_module_name(entry_raw) {
            return Err(invalid(format!(
                "module entry must be a dotted module name, got {entry_raw:?}"
            )));
        }
        entry_raw.to_string()
    } else {
        let entry = relative_workspace_path(entry_raw)
            .ok_or_else(|| invalid("entry must be a relative path inside the workspace"))?;
        // Legacy entry checks. Workspace launches use their source host instead.
        if launch.is_none() {
            let mut path = root.clone();
            for part in entry.split('/') {
                path.push(part);
                if std::fs::symlink_metadata(&path)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(invalid(
                        "symbolic links are not supported for script entries",
                    ));
                }
            }
            let resolved = std::fs::canonicalize(&path)
                .map_err(|_| invalid(format!("entry file does not exist: {entry}")))?;
            if !resolved.starts_with(&root) || !resolved.is_file() {
                return Err(invalid("entry must be a file inside the workspace"));
            }
        }
        entry
    };
    let python_path = string_array(rr.get("python-path"), "[tool.remote-runner].python-path")?
        .iter()
        .map(|p| {
            let rel = relative_workspace_path(p).ok_or_else(|| {
                invalid("python-path entries must be relative paths inside the workspace")
            })?;
            let full = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if launch.is_none() && !full.is_dir() {
                return Err(invalid(format!(
                    "python-path entry is not a directory: {rel}"
                )));
            }
            Ok(rel)
        })
        .collect::<Result<Vec<_>>>()?;
    let groups = string_array(
        rr.get("dependency-groups"),
        "[tool.remote-runner].dependency-groups",
    )?;
    for group in &groups {
        if !dependency_groups.contains_key(group) {
            return Err(invalid(format!(
                "dependency group {group:?} is not declared in [dependency-groups]"
            )));
        }
    }
    let extras = string_array(rr.get("extras"), "[tool.remote-runner].extras")?;
    for extra in &extras {
        if !optional_dependencies.contains_key(extra) {
            return Err(invalid(format!(
                "extra {extra:?} is not declared in [project.optional-dependencies]"
            )));
        }
    }

    // 6. 规范化包源身份：名字 + requires-python + 排序后的依赖声明
    let mut identity_lines = vec![
        format!("name={name}"),
        format!("requires-python={requires_python}"),
    ];
    identity_lines.extend(dependencies.iter().map(|d| format!("dep={d}")));
    let mut extras_lines: Vec<String> = optional_dependencies
        .iter()
        .flat_map(|(k, deps)| {
            deps.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
                .into_iter()
                .map(move |d| format!("extra={k}:{d}"))
        })
        .collect();
    extras_lines.sort();
    identity_lines.extend(extras_lines);
    let mut group_lines: Vec<String> = dependency_groups
        .iter()
        .flat_map(|(k, deps)| {
            deps.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
                .into_iter()
                .map(move |d| format!("group={k}:{d}"))
        })
        .collect();
    group_lines.sort();
    identity_lines.extend(group_lines);

    Ok(PythonProject {
        name,
        requires_python,
        python_version,
        lock_sha256,
        entry,
        mode,
        python_path,
        groups,
        extras,
        package_source_identity: sha256_hex(identity_lines.join("\n").as_bytes()),
        workspace: root,
        input_hashes: vec![
            (
                "pyproject.toml".into(),
                sha256_hex(pyproject_text.as_bytes()),
            ),
            (
                ".python-version".into(),
                sha256_hex(version_text.as_bytes()),
            ),
            ("uv.lock".into(), sha256_hex(lock_bytes)),
        ],
    })
}

/// 供 RunManager 使用：managed 模式校验通过后回填请求入口
pub fn spec(project: &PythonProject, uv_version: &str) -> crate::runtime::ManagedPythonSpec {
    crate::runtime::ManagedPythonSpec {
        python_version: project.python_version.clone(),
        uv_version: uv_version.to_string(),
        lock_sha256: project.lock_sha256.clone(),
        groups: project.groups.clone(),
        extras: project.extras.clone(),
    }
}

/// 由工作区目录名派生 pyproject 项目名：小写字母 / 数字 / `.` `_` `-`，
/// 首尾必须是字母或数字；无法派生时退回占位名
pub fn template_project_name(dir: &Path) -> String {
    let base = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let mapped: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else if matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.is_empty() {
        "my-project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 「生成工作区配置」写入的 pyproject.toml 模板（00027 §5 项目契约）。
/// 模板本身不构成完整项目：uv.lock 与 .python-version 需要用户补齐。
pub fn config_template(project_name: &str) -> String {
    format!(
        r#"# Remote Runner 工作区配置（Managed Python，uv 项目契约）
# 完整运行还需要两个文件（本模板不生成）：
#   .python-version  CPython 次版本或补丁版本，如 3.12 或 3.12.9，须满足 requires-python
#   uv.lock          在本目录执行 `uv lock` 生成

[project]
name = "{project_name}"
requires-python = "==3.12.*"
dependencies = []

[tool.remote-runner]
# 入口：mode = "script" 时为工作区内脚本路径；
#       mode = "module" 时为点分模块名（如 mypkg.main，模块目录含 __main__.py 时写包名）
entry = "main.py"
mode = "script"
# 额外加入 PYTHONPATH 的工作区内目录（src 布局用 ["src"]）
python-path = []
# 只能引用 [dependency-groups] / [project.optional-dependencies] 中已声明的名称；
# 空数组表示只安装 [project].dependencies
dependency-groups = []
extras = []
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("rr-proj-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, content: &str) {
            let path = self.0.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, content).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const PYPROJECT: &str = r#"
[project]
name = "audio-test"
requires-python = "==3.12.*"
dependencies = ["requests==2.32.5", "pyyaml==6.0.2"]

[project.optional-dependencies]
dev = ["pytest==8.3.0"]

[dependency-groups]
docs = ["sphinx==7.4.7"]

[tool.remote-runner]
entry = "scripts/main.py"
mode = "script"
python-path = ["src"]
"#;

    fn valid_fixture() -> Fixture {
        let f = Fixture::new();
        f.write("pyproject.toml", PYPROJECT);
        f.write(
            "uv.lock",
            "version = 1\n\n[[package]]\nname = \"requests\"\n",
        );
        f.write(".python-version", "3.12.9\n");
        f.write("scripts/main.py", "print('hi')\n");
        f.write("src/pkg/__init__.py", "");
        f
    }

    #[test]
    fn valid_project_extracts_full_contract() {
        let f = valid_fixture();
        let p = inspect(&f.0).unwrap();
        assert_eq!(p.python_version, "3.12.9");
        assert_eq!(p.entry, "scripts/main.py");
        assert_eq!(p.mode, EntryMode::Script);
        assert_eq!(p.python_path, vec!["src"]);
        assert!(p.lock_sha256.len() == 64);
        assert!(p.package_source_identity.len() == 64);
    }

    #[test]
    fn config_template_is_valid_toml_with_remote_runner_table() {
        let text = config_template("audio-test");
        let parsed: toml::Table = text.parse().unwrap();
        assert_eq!(parsed["project"]["name"].as_str().unwrap(), "audio-test");
        let rr = &parsed["tool"]["remote-runner"];
        assert_eq!(rr["entry"].as_str().unwrap(), "main.py");
        assert_eq!(rr["mode"].as_str().unwrap(), "script");
        assert!(rr["python-path"].as_array().unwrap().is_empty());
        // LF 文本，无 CR / NUL（workspace 编辑约束）
        assert!(!text.contains(['\r', '\0']));
    }

    #[test]
    fn template_project_name_sanitizes_directory_name() {
        assert_eq!(
            template_project_name(Path::new("/ws/Audio_Test")),
            "audio_test"
        );
        assert_eq!(template_project_name(Path::new("/ws/my proj!")), "my-proj");
        assert_eq!(template_project_name(Path::new("/ws/...")), "my-project");
        assert_eq!(template_project_name(Path::new("/")), "my-project");
    }

    #[test]
    fn python_version_accepts_minor_or_patch_requests_only() {
        for version in ["3.12", "3.12.9"] {
            let f = valid_fixture();
            f.write(".python-version", version);
            assert_eq!(inspect(&f.0).unwrap().python_version, version);
        }
        for bad in [
            "3",
            "3.12.",
            "3.12.9.1",
            ">=3.12",
            "3.12rc1",
            "3.12.*",
            "3.12 3.13",
            "pypy3.10",
            "3.12.9t",
            "3.12.9\n3.13.0",
        ] {
            let f = valid_fixture();
            f.write(".python-version", bad);
            let err = inspect(&f.0).unwrap_err();
            assert!(
                err.to_string().contains(code::INVALID_PYTHON_VERSION),
                "{bad}: {err}"
            );
        }
    }

    #[test]
    fn minor_request_checks_the_compatible_patch_range_instead_of_assuming_patch_zero() {
        for (requires, ok) in [
            (">=3.12.9,<3.13", true),
            ("==3.12.9", true),
            (">3.12.9,!=3.12.10", true),
            ("~=3.12.9", true),
            ("~=3.11", true),
            ("~=3.11.9", false),
            (">=3.13", false),
            ("<3.12", false),
            ("!=3.12.*", false),
            (">=3.12.9,<3.12.9", false),
            ("nonsense", false),
        ] {
            assert_eq!(
                request_satisfies_requires_python("3.12", requires),
                ok,
                "{requires}"
            );
        }
        let f = valid_fixture();
        f.write(".python-version", "3.12");
        f.write(
            "pyproject.toml",
            &PYPROJECT.replace("==3.12.*", ">=3.12.9,<3.13"),
        );
        assert_eq!(
            inspect(&f.0).unwrap().python_request(),
            "==3.12.*,>=3.12.9,<3.13"
        );
        assert!(python_version_matches("3.12", "3.12.9"));
        assert!(!python_version_matches("3.12", "3.120.9"));
        assert!(!python_version_matches("3.12", "3.13.0"));
        assert!(!python_version_matches("3.12.9", "3.12.10"));
        assert!(!python_version_matches("3.12", "3.12.9rc1"));
    }

    #[test]
    fn workspace_launch_selects_its_entry_and_does_not_require_a_legacy_entry_table() {
        let root = PathBuf::from("/source");
        let text = "[project]\nname='test'\nrequires-python='>=3.12'\ndependencies=[]\n";
        let p = parse_inputs(
            root.clone(),
            text,
            "3.12.9",
            b"version=1",
            Some(("pytest", true)),
        )
        .unwrap();
        assert_eq!(p.entry, "pytest");
        assert_eq!(p.mode, EntryMode::Module);
        let p = parse_inputs(
            root,
            &format!("{text}\n[tool.remote-runner]\nentry='old.py'\nmode='invalid-legacy-mode'\n"),
            "3.12.9",
            b"version=1",
            Some(("selected.py", false)),
        )
        .unwrap();
        assert_eq!(p.entry, "selected.py");
        assert_eq!(p.mode, EntryMode::Script);
    }

    #[test]
    fn requires_python_must_accommodate_exact_version() {
        for (spec, ok) in [
            ("==3.12.*", true),
            ("==3.12.9", true),
            (">=3.12,<3.13", true),
            (">=3.12.9", true),
            ("~=3.12.9", true),
            ("==3.13.*", false),
            (">=3.13", false),
            ("<3.12", false),
            ("nonsense", false),
        ] {
            assert_eq!(satisfies_requires_python(spec, "3.12.9"), ok, "{spec}");
        }
        let f = valid_fixture();
        f.write("pyproject.toml", &PYPROJECT.replace("==3.12.*", "==3.13.*"));
        let err = inspect(&f.0).unwrap_err();
        assert!(err.to_string().contains(code::VERSION_MISMATCH), "{err}");
    }

    #[test]
    fn missing_or_broken_contract_fails_with_stable_codes() {
        let f = valid_fixture();
        std::fs::remove_file(f.0.join("uv.lock")).unwrap();
        assert!(inspect(&f.0)
            .unwrap_err()
            .to_string()
            .contains(code::MISSING_LOCK));

        let f = valid_fixture();
        f.write("uv.lock", "this is [not toml");
        assert!(inspect(&f.0).is_err());

        let f = valid_fixture();
        f.write("uv.lock", "other = 1\n");
        assert!(inspect(&f.0).is_err());

        let f = valid_fixture();
        f.write("uv.lock", &"x".repeat(crate::runtime::LOCK_LIMIT + 1));
        assert!(inspect(&f.0).is_err());

        let f = valid_fixture();
        std::fs::remove_file(f.0.join("pyproject.toml")).unwrap();
        assert!(inspect(&f.0).is_err());
    }

    #[test]
    fn entry_and_python_path_are_workspace_relative() {
        for bad_entry in ["../escape.py", "/abs.py", "a//b.py", "missing.py"] {
            let f = valid_fixture();
            f.write(
                "pyproject.toml",
                &PYPROJECT.replace("scripts/main.py", bad_entry),
            );
            assert!(inspect(&f.0).is_err(), "{bad_entry}");
        }
        for bad_pp in ["../src", "/src", "src/../escape"] {
            let f = valid_fixture();
            f.write(
                "pyproject.toml",
                &PYPROJECT.replace(r#""src"]"#, &format!("\"{bad_pp}\"]")),
            );
            assert!(inspect(&f.0).is_err(), "{bad_pp}");
        }
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &PYPROJECT.replace("mode = \"script\"", "mode = \"bogus\""),
        );
        assert!(inspect(&f.0).is_err());
    }

    #[test]
    fn module_mode_uses_dotted_names_without_file_check() {
        let f = Fixture::new();
        f.write(
            "pyproject.toml",
            &PYPROJECT
                .replace("scripts/main.py", "pkg.main")
                .replace("mode = \"script\"", "mode = \"module\""),
        );
        f.write("uv.lock", "version = 1\n");
        f.write(".python-version", "3.12.9\n");
        std::fs::create_dir(f.0.join("src")).unwrap();
        let p = inspect(&f.0).unwrap();
        assert_eq!(p.mode, EntryMode::Module);
        assert_eq!(p.entry, "pkg.main");
        for bad in ["9bad", "has-dash", "a..b", ".lead", "trail."] {
            let f = Fixture::new();
            f.write(
                "pyproject.toml",
                &PYPROJECT
                    .replace("scripts/main.py", bad)
                    .replace("mode = \"script\"", "mode = \"module\""),
            );
            f.write("uv.lock", "version = 1\n");
            f.write(".python-version", "3.12.9\n");
            assert!(inspect(&f.0).is_err(), "{bad}");
        }
    }

    #[test]
    fn groups_and_extras_must_be_declared() {
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &(PYPROJECT.to_string() + "\ndependency-groups = [\"nope\"]\n"),
        );
        // 重复 table 键会让 TOML 解析失败；改为直接改原文
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &PYPROJECT.replace(
                "python-path = [\"src\"]",
                "python-path = [\"src\"]\ndependency-groups = [\"nope\"]",
            ),
        );
        assert!(inspect(&f.0).is_err());
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &PYPROJECT.replace(
                "python-path = [\"src\"]",
                "python-path = [\"src\"]\nextras = [\"nope\"]",
            ),
        );
        assert!(inspect(&f.0).is_err());
        // 声明后可选择
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &PYPROJECT.replace(
                "python-path = [\"src\"]",
                "python-path = [\"src\"]\ndependency-groups = [\"docs\"]\nextras = [\"dev\"]",
            ),
        );
        let p = inspect(&f.0).unwrap();
        assert_eq!(p.groups, vec!["docs"]);
        assert_eq!(p.extras, vec!["dev"]);
    }

    #[test]
    fn local_path_editable_and_workspace_sources_are_rejected() {
        for (name, toml_text) in [
            (
                "path dep",
                PYPROJECT.replace(
                    "\"requests==2.32.5\"",
                    "\"requests @ file:///tmp/requests\"",
                ),
            ),
            (
                "editable",
                PYPROJECT.replace("\"requests==2.32.5\"", "\"-e ./requests\""),
            ),
            (
                "relative path",
                PYPROJECT.replace("\"requests==2.32.5\"", "\"requests @ ../requests\""),
            ),
        ] {
            let f = valid_fixture();
            f.write("pyproject.toml", &toml_text);
            assert!(inspect(&f.0).is_err(), "{name}");
        }
        let f = valid_fixture();
        f.write(
            "pyproject.toml",
            &(PYPROJECT.to_string() + "\n[tool.uv.workspace]\nmembers = [\"libs/*\"]\n"),
        );
        assert!(inspect(&f.0).is_err(), "workspace member");
        let f = valid_fixture();
        f.write("pyproject.toml", &(PYPROJECT.to_string()
            + "\n[tool.uv.sources]\nrequests = { path = \"vendor/requests\", editable = true }\n"));
        assert!(inspect(&f.0).is_err(), "tool.uv.sources path");
        // git/url 源声明本身允许（必须已进 lock）
        let f = valid_fixture();
        f.write("pyproject.toml", &(PYPROJECT.to_string()
            + "\n[tool.uv.sources]\nrequests = { git = \"https://github.com/psf/requests\" }\n"));
        inspect(&f.0).expect("git source allowed");
    }

    #[test]
    fn package_source_identity_is_stable_and_sensitive_to_inputs() {
        let f = valid_fixture();
        let a = inspect(&f.0).unwrap();
        let b = inspect(&f.0).unwrap();
        assert_eq!(a.package_source_identity, b.package_source_identity);
        let f2 = valid_fixture();
        f2.write(
            "pyproject.toml",
            &PYPROJECT.replace("requests==2.32.5", "requests==2.32.4"),
        );
        let c = inspect(&f2.0).unwrap();
        assert_ne!(a.package_source_identity, c.package_source_identity);
    }
}
