//! FakeHost + 可编程 fake uv：prepare 流水线的内存集成测试（00027 §20）。
//!
//! FakeHost 实现 RuntimeHost：内存文件系统（文件/目录/rename 子树语义）+
//! 可编程 exec（探测脚本、uv --version / python install / python find / sync、
//! 环境内 Python smoke test）。uv 资产通过注入的自定义 RuntimeCatalog +
//! 预置桌面端内容缓存提供，全程无网络。
use crate::error::{Result, RunnerError};
use crate::runtime::host::{check_cancel, ExecResult, RuntimeHost};
use futures::future::BoxFuture;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

/// 可编程行为：测试可在准备中途改变 fake uv / fake python 的应答
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingFailure {
    Mkdir,
    Write,
    Rename,
}

#[derive(Debug, Clone)]
pub struct Behavior {
    /// `uv --version` 报告的版本（与注入 Catalog 一致）
    pub uv_version: String,
    /// fake Python 信息探针 / smoke test 报告的版本
    pub python_version: String,
    /// `uv python find` 指回系统 Python（应被拒绝）
    pub find_returns_system: bool,
    /// `uv sync` 失败（exit 2）
    pub sync_fails: bool,
    /// `uv sync` 成功时仍写入的 stderr 原始字节（非 UTF-8 透传测试）
    pub sync_stderr: Vec<u8>,
    /// 配方绑定发布的故障注入；不影响实例 manifest 和 ready marker。
    pub binding_failure: Option<BindingFailure>,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            uv_version: "0.12.13".into(),
            python_version: "3.12.9".into(),
            find_returns_system: false,
            sync_fails: false,
            sync_stderr: Vec::new(),
            binding_failure: None,
        }
    }
}

#[derive(Default)]
struct FakeState {
    files: HashMap<String, Vec<u8>>,
    dirs: HashSet<String>,
    behavior: Behavior,
    exec_log: Vec<Vec<String>>,
    /// 与 exec_log 一一对应的 env 快照，用于断言约束不依赖环境变量
    exec_env_log: Vec<Vec<(String, String)>>,
    sync_count: usize,
    install_count: usize,
    /// uv 二进制上传次数（downloads/ 下临时文件写入次数）
    deploys: usize,
}

fn not_found(path: &str) -> RunnerError {
    RunnerError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("fake host: no such path: {path}"),
    ))
}

fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(i) => &path[..i],
        None => "/",
    }
}

impl FakeState {
    fn mkdir_locked(&mut self, path: &str) -> Result<bool> {
        if self.dirs.contains(path) {
            return Ok(false);
        }
        let parent = parent_of(path);
        if !self.dirs.contains(parent) {
            return Err(not_found(parent));
        }
        self.dirs.insert(path.to_string());
        Ok(true)
    }

    fn mkdir_all_locked(&mut self, path: &str) -> Result<()> {
        let mut current = String::new();
        for part in path.trim_start_matches('/').split('/') {
            if part.is_empty() {
                continue;
            }
            current.push('/');
            current.push_str(part);
            if !self.dirs.contains(&current) {
                self.dirs.insert(current.clone());
            }
        }
        Ok(())
    }

    fn write_locked(&mut self, path: &str, data: &[u8]) -> Result<()> {
        let parent = parent_of(path);
        if !self.dirs.contains(parent) {
            return Err(not_found(parent));
        }
        self.files.insert(path.to_string(), data.to_vec());
        Ok(())
    }

    /// 文件移动或目录子树移动（env 隔离隔离整个目录）
    fn rename_locked(&mut self, from: &str, to: &str) -> Result<()> {
        if let Some(data) = self.files.remove(from) {
            let parent = parent_of(to);
            if !self.dirs.contains(parent) {
                self.files.insert(from.to_string(), data);
                return Err(not_found(parent));
            }
            self.files.insert(to.to_string(), data);
            return Ok(());
        }
        if !self.dirs.contains(from) {
            return Err(not_found(from));
        }
        let parent = parent_of(to);
        if !self.dirs.contains(parent) {
            return Err(not_found(parent));
        }
        let prefix = format!("{from}/");
        let file_keys: Vec<String> = self
            .files
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        let dir_keys: Vec<String> = self
            .dirs
            .iter()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        self.dirs.remove(from);
        self.dirs.insert(to.to_string());
        for key in dir_keys {
            self.dirs.remove(&key);
            self.dirs.insert(format!("{to}{}", &key[from.len()..]));
        }
        for key in file_keys {
            if let Some(data) = self.files.remove(&key) {
                self.files
                    .insert(format!("{to}{}", &key[from.len()..]), data);
            }
        }
        Ok(())
    }

    fn remove_locked(&mut self, path: &str) {
        self.files.remove(path);
        if self.dirs.remove(path) {
            let prefix = format!("{path}/");
            let file_keys: Vec<String> = self
                .files
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect();
            let dir_keys: Vec<String> = self
                .dirs
                .iter()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect();
            for key in file_keys {
                self.files.remove(&key);
            }
            for key in dir_keys {
                self.dirs.remove(&key);
            }
        }
    }
}

/// 内存 RuntimeHost：posix 语义，root 固定为 `/home/u/.remote-runner/runtime-v1`
pub struct FakeHost {
    root: String,
    state: Mutex<FakeState>,
}

impl Default for FakeHost {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeHost {
    pub fn new() -> Self {
        let root = "/home/u/.remote-runner/runtime-v1".to_string();
        let mut state = FakeState::default();
        // 预注册根目录各级祖先（锁的 mkdir 原子性依赖父目录存在语义）
        state.mkdir_all_locked(&root).expect("root dirs");
        Self {
            root,
            state: Mutex::new(state),
        }
    }

    pub fn behavior(&self) -> Behavior {
        self.state.lock().unwrap().behavior.clone()
    }

    pub fn set_behavior(&self, update: impl FnOnce(&mut Behavior)) {
        let mut state = self.state.lock().unwrap();
        update(&mut state.behavior);
    }

    pub fn sync_count(&self) -> usize {
        self.state.lock().unwrap().sync_count
    }

    pub fn install_count(&self) -> usize {
        self.state.lock().unwrap().install_count
    }

    pub fn deploys(&self) -> usize {
        self.state.lock().unwrap().deploys
    }

    pub fn exec_log(&self) -> Vec<Vec<String>> {
        self.state.lock().unwrap().exec_log.clone()
    }

    pub fn exec_log_envs(&self) -> Vec<Vec<(String, String)>> {
        self.state.lock().unwrap().exec_env_log.clone()
    }

    fn exec_inner(
        &self,
        argv: &[String],
        env: &[(String, String)],
        cancel: &AtomicBool,
    ) -> Result<ExecResult> {
        check_cancel(cancel)?;
        let mut state = self.state.lock().unwrap();
        state.exec_log.push(argv.to_vec());
        state.exec_env_log.push(env.to_vec());
        let program = argv.first().map(String::as_str).unwrap_or("");

        // posix 探测脚本（profile::POSIX_PROBE 内含 RRPROBE 标记）
        if program == "/bin/sh" && argv.get(1).map(String::as_str) == Some("-c") {
            let script = argv.get(2).map(String::as_str).unwrap_or("");
            if script.contains("RRPROBE") {
                return Ok(ExecResult {
                    code: Some(0),
                    stdout: b"RRPROBE s=Linux m=x86_64 r=6.8.0 libc=gnu lv=2.39 kb=4194304 home=/home/u\n".to_vec(),
                    stderr: Vec::new(),
                });
            }
            return Err(RunnerError::managed(
                crate::runtime::code::NOT_SUPPORTED,
                format!("fake host: unsupported shell script: {script:?}"),
            ));
        }

        // 根目录可执行性探针（probe_root_usable 写入的 .probe-* 脚本）
        if argv.len() == 1 && program.contains(".probe-") {
            if state.files.contains_key(program) {
                return Ok(ExecResult {
                    code: Some(0),
                    ..Default::default()
                });
            }
            return Err(not_found(program));
        }

        // fake uv
        if program.ends_with("/uv") {
            let sub = argv.get(1).map(String::as_str).unwrap_or("");
            match sub {
                "--version" => {
                    if state.files.contains_key(program) {
                        let version = state.behavior.uv_version.clone();
                        // 复刻真实 uv 输出：版本号 + 空格 + 括号内目标三元组
                        return Ok(ExecResult {
                            code: Some(0),
                            stdout: format!("uv {version} (x86_64-unknown-linux-gnu)\n")
                                .into_bytes(),
                            stderr: Vec::new(),
                        });
                    }
                    return Ok(ExecResult {
                        code: Some(1),
                        stdout: Vec::new(),
                        stderr: b"fake uv: not installed".to_vec(),
                    });
                }
                "python" => match argv.get(2).map(String::as_str).unwrap_or("") {
                    "install" => {
                        state.install_count += 1;
                        return Ok(ExecResult {
                            code: Some(0),
                            ..Default::default()
                        });
                    }
                    "find" => {
                        if state.behavior.find_returns_system {
                            return Ok(ExecResult {
                                code: Some(0),
                                stdout: b"/usr/bin/python3\n".to_vec(),
                                stderr: Vec::new(),
                            });
                        }
                        let resolved = &state.behavior.python_version;
                        let path = format!(
                            "{}/python/cpython-{resolved}-linux-x86_64-gnu/bin/python3.12",
                            self.root
                        );
                        return Ok(ExecResult {
                            code: Some(0),
                            stdout: format!("{path}\n").into_bytes(),
                            stderr: Vec::new(),
                        });
                    }
                    other => {
                        return Err(RunnerError::managed(
                            crate::runtime::code::NOT_SUPPORTED,
                            format!("fake uv: unsupported python subcommand {other:?}"),
                        ))
                    }
                },
                "sync" => {
                    state.sync_count += 1;
                    if state.behavior.sync_fails {
                        return Ok(ExecResult {
                            code: Some(2),
                            stdout: Vec::new(),
                            stderr: state.behavior.sync_stderr.clone(),
                        });
                    }
                    // 物化环境内解释器：verify_environment 探测 <env>/bin/python
                    let env_dir = env
                        .iter()
                        .find(|(k, _)| k == "UV_PROJECT_ENVIRONMENT")
                        .map(|(_, v)| v.clone())
                        .ok_or_else(|| {
                            RunnerError::managed(
                                crate::runtime::code::NOT_SUPPORTED,
                                "fake uv sync: UV_PROJECT_ENVIRONMENT missing",
                            )
                        })?;
                    // 复刻真实 uv：UV_PROJECT_ENVIRONMENT 指向含任何文件的目录时，
                    // 按"复用现有环境"处理并直接报错（不能预先写 .preparing 标记）
                    if state
                        .files
                        .keys()
                        .any(|f| f.starts_with(&format!("{env_dir}/")))
                    {
                        return Ok(ExecResult {
                            code: Some(2),
                            stdout: Vec::new(),
                            stderr: format!(
                                "error: Project virtual environment directory `{env_dir}` cannot be used because it is not a valid Python environment (no Python executable was found)"
                            )
                            .into_bytes(),
                        });
                    }
                    state.mkdir_all_locked(&format!("{env_dir}/bin"))?;
                    state.write_locked(&format!("{env_dir}/bin/python"), b"fake-python")?;
                    let stderr = state.behavior.sync_stderr.clone();
                    return Ok(ExecResult {
                        code: Some(0),
                        stdout: b"Resolved 1 package in 1ms\n".to_vec(),
                        stderr,
                    });
                }
                "cache" => {
                    return Ok(ExecResult {
                        code: Some(0),
                        ..Default::default()
                    })
                }
                other => {
                    return Err(RunnerError::managed(
                        crate::runtime::code::NOT_SUPPORTED,
                        format!("fake uv: unsupported subcommand {other:?}"),
                    ))
                }
            }
        }

        // fake Python：信息探针（install 验证）与环境 smoke test
        if program.contains("python") && argv.iter().any(|a| a == "-c") {
            let script = argv
                .iter()
                .skip(1)
                .find(|a| a.contains("json"))
                .map(String::as_str)
                .unwrap_or("");
            if script.contains("SOABI") {
                let version = state.behavior.python_version.clone();
                let body = serde_json::json!({
                    "version": version,
                    "implementation": "CPython",
                    "platform": "Linux-6.8.0-x86_64",
                    "soabi": "cpython-312-x86_64-linux-gnu",
                });
                return Ok(ExecResult {
                    code: Some(0),
                    stdout: format!("{body}\n").into_bytes(),
                    stderr: Vec::new(),
                });
            }
            if script.contains("sys.prefix") {
                let version = state.behavior.python_version.clone();
                let prefix = program
                    .strip_suffix("/bin/python")
                    .unwrap_or(program)
                    .to_string();
                let body = serde_json::json!({
                    "prefix": prefix,
                    "version": version,
                    "executable": program,
                });
                return Ok(ExecResult {
                    code: Some(0),
                    stdout: format!("{body}\n").into_bytes(),
                    stderr: Vec::new(),
                });
            }
        }

        Err(RunnerError::managed(
            crate::runtime::code::NOT_SUPPORTED,
            format!("fake host: unsupported command {argv:?}"),
        ))
    }
}

impl RuntimeHost for FakeHost {
    fn root(&self) -> &str {
        &self.root
    }

    fn is_windows(&self) -> bool {
        false
    }

    fn exec<'a>(
        &'a self,
        argv: &'a [String],
        env: &'a [(String, String)],
        _cwd: Option<&'a str>,
        _input: Option<&'a [u8]>,
        cancel: &'a AtomicBool,
    ) -> BoxFuture<'a, Result<ExecResult>> {
        Box::pin(async move { self.exec_inner(argv, env, cancel) })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        data: &'a [u8],
        _mode: u32,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            if path.contains("/bindings/")
                && state.behavior.binding_failure == Some(BindingFailure::Write)
            {
                return Err(RunnerError::TaskFailed(
                    "injected binding write failure".into(),
                ));
            }
            if path.contains("/downloads/") {
                state.deploys += 1;
            }
            state.write_locked(path, data)
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .files
                .get(path)
                .cloned()
                .ok_or_else(|| not_found(path))
        })
    }

    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move { self.state.lock().unwrap().mkdir_locked(path) })
    }

    fn mkdir_all<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            if path.ends_with("/bindings")
                && state.behavior.binding_failure == Some(BindingFailure::Mkdir)
            {
                return Err(RunnerError::TaskFailed(
                    "injected binding mkdir failure".into(),
                ));
            }
            state.mkdir_all_locked(path)
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            if to.contains("/bindings/")
                && state.behavior.binding_failure == Some(BindingFailure::Rename)
            {
                return Err(RunnerError::TaskFailed(
                    "injected binding rename failure".into(),
                ));
            }
            state.rename_locked(from, to)
        })
    }

    fn remove<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.state.lock().unwrap().remove_locked(path);
            Ok(())
        })
    }

    fn exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let state = self.state.lock().unwrap();
            state.files.contains_key(path) || state.dirs.contains(path)
        })
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let state = self.state.lock().unwrap();
            if !state.dirs.contains(path) {
                return Ok(Vec::new());
            }
            let prefix = format!("{}/", path.trim_end_matches('/'));
            let mut names = HashSet::new();
            for key in state.dirs.iter().chain(state.files.keys()) {
                if let Some(rest) = key.strip_prefix(&prefix) {
                    if let Some(head) = rest.split('/').next() {
                        if !head.is_empty() {
                            names.insert(head.to_string());
                        }
                    }
                }
            }
            Ok(names.into_iter().collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::OutputStream;
    use crate::runtime::catalog::RuntimeCatalog;
    use crate::runtime::manifest;
    use crate::runtime::prepare::{
        prepare_environment, prepare_runtime, NetworkConfig, PrepareEvents,
    };
    use crate::runtime::project::{EntryMode, PythonProject};
    use crate::runtime::{code, RuntimePhase};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    const UV_VERSION: &str = "0.12.13";
    const PYTHON_VERSION: &str = "3.12.9";

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("rr-fake-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 复刻官方 linux x86_64 资产的实际布局：目录条目 + `uvx` 在前、`uv` 在后
    /// （0.12.13 归档顺序如此），保证解包规则对真实资产成立
    fn fake_uv_archive() -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut buffer, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut dir = tar::Header::new_gnu();
            dir.set_entry_type(tar::EntryType::Directory);
            dir.set_size(0);
            dir.set_mode(0o755);
            dir.set_cksum();
            builder
                .append_data(&mut dir, "uv-x86_64-unknown-linux-gnu", &[][..])
                .unwrap();
            for (name, data) in [
                (
                    "uv-x86_64-unknown-linux-gnu/uvx",
                    &b"#!/bin/sh\necho fake uvx\n"[..],
                ),
                (
                    "uv-x86_64-unknown-linux-gnu/uv",
                    &b"#!/bin/sh\necho fake uv\n"[..],
                ),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, data).unwrap();
            }
            builder.finish().unwrap();
        }
        buffer
    }

    /// 注入自定义 Catalog 并预置桌面端内容缓存（全程无网络）
    fn fake_catalog(cache_dir: &Path) -> RuntimeCatalog {
        let archive = fake_uv_archive();
        let sha = crate::runtime::download::sha256_hex(&archive);
        let text = format!(
            r#"{{"schema":1,"uvVersion":"{UV_VERSION}","assets":[{{"platform":"linux-x86_64-gnu","url":"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz","size":0,"sha256":"{sha}"}}]}}"#
        );
        let catalog = RuntimeCatalog::parse(&text).unwrap();
        crate::runtime::download::store_cache(cache_dir, &catalog.assets[0], UV_VERSION, &archive)
            .unwrap();
        catalog
    }

    fn fake_project() -> PythonProject {
        PythonProject {
            name: "demo".into(),
            requires_python: "==3.12.*".into(),
            python_version: PYTHON_VERSION.into(),
            lock_sha256: "a".repeat(64),
            entry: "main.py".into(),
            mode: EntryMode::Script,
            python_path: vec![],
            groups: vec![],
            extras: vec![],
            package_source_identity: "b".repeat(64),
            workspace: PathBuf::from("/ws"),
            input_hashes: vec![],
        }
    }

    type Collected = Arc<Mutex<Vec<(OutputStream, Vec<u8>)>>>;

    fn collect_events() -> (PrepareEvents, Arc<Mutex<Vec<RuntimePhase>>>, Collected) {
        let phases = Arc::new(Mutex::new(Vec::new()));
        let outputs: Collected = Arc::new(Mutex::new(Vec::new()));
        let p = phases.clone();
        let o = outputs.clone();
        let events = PrepareEvents {
            on_phase: Box::new(move |phase| p.lock().unwrap().push(phase)),
            on_progress: Box::new(|_, _, _| {}),
            on_output: Box::new(move |stream, data| {
                o.lock().unwrap().push((stream, data.to_vec()))
            }),
        };
        (events, phases, outputs)
    }

    type SharedHost = Arc<dyn RuntimeHost + Send + Sync>;

    fn shared(host: &Arc<FakeHost>) -> SharedHost {
        host.clone()
    }

    async fn full_prepare(
        host: &Arc<FakeHost>,
        catalog: &RuntimeCatalog,
        cache_dir: &Path,
        cancel: &AtomicBool,
    ) -> (
        crate::runtime::RuntimeReady,
        crate::runtime::PreparedEnvironment,
    ) {
        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(host),
            catalog,
            PYTHON_VERSION,
            cache_dir,
            &NetworkConfig::default(),
            cancel,
            &mut events,
        )
        .await
        .unwrap();
        let (mut events, _, _) = collect_events();
        let env = prepare_environment(
            shared(host),
            &ready,
            &fake_project(),
            "/ws",
            catalog,
            &NetworkConfig::default(),
            "run-1",
            cancel,
            &mut events,
        )
        .await
        .unwrap();
        (ready, env)
    }

    #[tokio::test]
    async fn first_deploy_full_pipeline() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);

        let (mut events, phases, outputs) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        assert!(host.exists(&ready.uv_path).await, "uv 二进制已发布");
        assert_eq!(host.install_count(), 1);
        assert_eq!(host.deploys(), 1);
        let log = outputs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, bytes)| bytes.clone())
            .collect::<Vec<_>>();
        let log = String::from_utf8_lossy(&log);
        for expected in [
            "phase: probing_runtime",
            "target platform=",
            "runtime root=",
            "Python request=",
            "phase: installing_python",
            "exec:",
            "install",
            "exit=Some(0)",
            "elapsed=",
            "resolved CPython",
            "interpreter=",
        ] {
            assert!(log.contains(expected), "missing {expected}: {log}");
        }
        // UV_PYTHON_PREFERENCE 与 --managed-python 在 uv 0.10+ 冲突，env 里不得再出现
        for env in host.exec_log_envs() {
            for (key, _) in env {
                assert_ne!(key, "UV_PYTHON_PREFERENCE");
            }
        }
        let seen = phases.lock().unwrap().clone();
        for phase in [
            RuntimePhase::ProbingRuntime,
            RuntimePhase::DeployingUv,
            RuntimePhase::InstallingPython,
        ] {
            assert!(seen.contains(&phase), "missing phase {phase}");
        }

        let (mut events, _, _) = collect_events();
        let env = prepare_environment(
            shared(&host),
            &ready,
            &fake_project(),
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "run-1",
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        assert!(!env.cache_hit);
        assert_eq!(host.sync_count(), 1);
        assert!(
            host.exists(&format!("{}/{}", env.env_path, manifest::READY_MARKER))
                .await
        );
        assert!(
            host.exists(&format!("{}/{}", env.env_path, manifest::MANIFEST_NAME))
                .await
        );
        assert!(
            !host
                .exists(&format!("{}/{}", env.env_path, manifest::PREPARING_MARKER))
                .await
        );
        assert_eq!(env.python_path, format!("{}/bin/python", env.env_path));
    }

    #[tokio::test]
    async fn rebuilding_rebinds_a_new_generation_and_preserves_leased_paths() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let (ready, old) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
        let leases = crate::runtime::manager::LeaseSet::default();
        leases.lease(&old.environment_id);
        leases.lease(&old.environment_id);
        let (mut events, _, _) = collect_events();
        let new = crate::runtime::manager::rebuild_environment(
            shared(&host),
            &leases,
            &ready,
            &fake_project(),
            "/ws",
            &catalog,
            &cache.0,
            &NetworkConfig::default(),
            "rebuild",
            &cancel,
            &mut events,
            None,
        )
        .await
        .unwrap();
        assert_ne!(old.environment_id, new.environment_id);
        assert_ne!(old.env_path, new.env_path);
        assert!(host.exists(&old.python_path).await);
        assert!(host.exists(&new.python_path).await);
        leases.release(&old.environment_id);
        assert!(leases.is_leased(&old.environment_id));
        assert!(crate::runtime::manager::delete_environment(
            shared(&host),
            &leases,
            &old.environment_id
        )
        .await
        .is_err());
        let (_, reused) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
        assert_eq!(reused.environment_id, new.environment_id);
        assert!(reused.cache_hit);
        leases.release(&old.environment_id);
        assert!(!leases.is_leased(&old.environment_id));
        crate::runtime::manager::delete_environment(shared(&host), &leases, &old.environment_id)
            .await
            .unwrap();
        assert!(host.exists(&new.python_path).await);
    }

    /// 真实 uv 把非空的 UV_PROJECT_ENVIRONMENT 当作"复用现有环境"而拒绝。
    /// FakeHost 已复刻该行为，这里直接驱动 prepare_environment，证明旧实现
    /// （sync 前预写 .preparing）会被稳定拦下。
    #[tokio::test]
    async fn sync_rejects_non_empty_env_target() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();

        // 模拟旧实现：sync 目标目录里预先放一个文件
        let envs_root = format!("{}/envs", ready.profile.runtime_root);
        host.mkdir_all(&envs_root).await.unwrap();
        let probe_dir = format!("{envs_root}/probe");
        host.mkdir_all(&probe_dir).await.unwrap();
        host.write_file(&format!("{probe_dir}/.preparing"), b"", 0o600)
            .await
            .unwrap();

        // 直接调用 fake uv sync 路径：env 目录非空应被拒绝（行为与真实 uv 对齐）
        let (mut events, _, _) = collect_events();
        let result = crate::runtime::prepare::run_uv_sync_for_test(
            &shared(&host),
            &ready,
            &fake_project(),
            "/ws",
            &probe_dir,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await;
        assert!(
            result.is_err(),
            "fake uv 应拒绝非空 env 目录（与真实 uv 行为一致）"
        );
    }

    #[tokio::test]
    async fn second_run_hits_caches() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let (ready, first) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
        assert!(!first.cache_hit);

        // 第二次：uv --version 命中，不重新部署；环境 .ready 命中，不重新 sync
        let (ready2, second) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
        assert_eq!(ready2.uv_path, ready.uv_path);
        assert_eq!(host.deploys(), 1, "uv 不应重新上传");
        assert_eq!(host.sync_count(), 1, "环境应整体复用");
        assert!(second.cache_hit);
        assert_eq!(second.environment_id, first.environment_id);
    }

    #[tokio::test]
    async fn sync_failure_keeps_preparing_and_recovers() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();

        host.set_behavior(|b| {
            b.sync_fails = true;
            b.sync_stderr = b"lockfile needs to be updated\n".to_vec();
        });
        let (mut events, _, outputs) = collect_events();
        let err = prepare_environment(
            shared(&host),
            &ready,
            &fake_project(),
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "run-1",
            &cancel,
            &mut events,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains(code::ENV_SYNC),
            "unexpected error: {err}"
        );
        let log = outputs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, bytes)| bytes.clone())
            .collect::<Vec<_>>();
        let log = String::from_utf8_lossy(&log);
        for expected in [
            "execution workspace=\"/ws\"",
            "environment recipe=",
            "phase: syncing_dependencies",
            "UV_PROJECT_ENVIRONMENT=",
            "exec:",
            "--locked",
            "lockfile needs to be updated",
            "exit=Some(2)",
            "environment preparation failed:",
            "removing failed environment",
        ] {
            assert!(log.contains(expected), "missing {expected}: {log}");
        }
        // sync 失败：环境目录可能尚未创建（uv 报错在写盘之前），或创建了但无 .ready。
        // 无论哪种，下一轮都会整体重建。
        let envs = host.list(&format!("{}/envs", host.root())).await.unwrap();
        for name in &envs {
            let env_dir = format!("{}/envs/{name}", host.root());
            assert!(
                !host
                    .exists(&format!("{env_dir}/{}", manifest::READY_MARKER))
                    .await
            );
        }

        // 修复后重跑：隔离残留（若有）并成功
        host.set_behavior(|b| b.sync_fails = false);
        let (mut events, _, _) = collect_events();
        let env = prepare_environment(
            shared(&host),
            &ready,
            &fake_project(),
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "run-2",
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        assert!(!env.cache_hit);
        assert_eq!(host.sync_count(), 2);
        assert!(
            host.exists(&format!("{}/{}", env.env_path, manifest::READY_MARKER))
                .await
        );
        // 残留目录被隔离到 quarantine（如果上一轮 sync 已写出 env_dir）。
        // 在"失败发生在写盘前"的 fake 路径里可能为空，这里只要求最终环境可用。
        let quarantine = host
            .list(&format!("{}/quarantine", host.root()))
            .await
            .unwrap();
        assert!(quarantine.len() <= 1);
    }

    #[tokio::test]
    async fn cancel_aborts_preparation() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(true);
        let (mut events, _, _) = collect_events();
        let err = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains(code::CANCELED),
            "unexpected error: {err}"
        );
        assert_eq!(host.deploys(), 0);
        assert_eq!(host.sync_count(), 0);
    }

    #[tokio::test]
    async fn system_python_is_refused() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        host.set_behavior(|b| b.find_returns_system = true);
        let (mut events, _, _) = collect_events();
        let err = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains(code::PYTHON_VERIFY),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn minor_python_request_freezes_actual_version_and_reuses_the_same_build() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let mut project = fake_project();
        project.python_version = "3.12".into();
        project.requires_python = ">=3.12.9,<3.13".into();
        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            &project.python_request(),
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        assert_eq!(ready.python_version, "3.12.9");
        let leases = crate::runtime::manager::LeaseSet::default();
        let prepared = crate::runtime::prepare::prepare_generation(
            shared(&host),
            &ready,
            &project,
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "minor",
            &cancel,
            &mut events,
            false,
            None,
            &leases,
        )
        .await
        .unwrap();
        assert_eq!(prepared.python_version, "3.12.9");
        let manifest = manifest::EnvironmentManifest::parse(
            &host
                .read_file(&host.join(&prepared.env_path, manifest::MANIFEST_NAME))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.python_request, "3.12");
        assert_eq!(manifest.python_version, "3.12.9");
        let log = host.exec_log();
        let sync = log
            .iter()
            .find(|args| args.get(1).is_some_and(|arg| arg == "sync"))
            .unwrap();
        let selected = sync.iter().position(|arg| arg == "--python").unwrap();
        assert_eq!(sync[selected + 1], ready.python_path);
        let (_, exact) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
        assert!(exact.cache_hit);
        assert_eq!(exact.environment_id, prepared.environment_id);
        let count = host.sync_count();
        let reused = crate::runtime::prepare::prepare_generation(
            shared(&host),
            &ready,
            &project,
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "reuse-minor",
            &cancel,
            &mut events,
            false,
            None,
            &leases,
        )
        .await
        .unwrap();
        assert!(reused.cache_hit);
        assert_eq!(host.sync_count(), count);

        host.set_behavior(|b| b.python_version = "3.12.10".into());
        let next = prepare_runtime(
            shared(&host),
            &catalog,
            &project.python_request(),
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        let upgraded = crate::runtime::prepare::prepare_generation(
            shared(&host),
            &next,
            &project,
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "new-patch",
            &cancel,
            &mut events,
            false,
            None,
            &leases,
        )
        .await
        .unwrap();
        assert_ne!(prepared.environment_id, upgraded.environment_id);
        assert_eq!(upgraded.python_version, "3.12.10");
        assert!(host.exists(&prepared.python_path).await);
    }

    #[tokio::test]
    async fn minor_python_request_rejects_an_incompatible_resolved_interpreter() {
        for actual in ["3.13.0", "3.12.8"] {
            let host = Arc::new(FakeHost::new());
            let cache = TestDir::new();
            let catalog = fake_catalog(&cache.0);
            let cancel = AtomicBool::new(false);
            let mut project = fake_project();
            project.python_version = "3.12".into();
            project.requires_python = ">=3.12.9,<3.13".into();
            host.set_behavior(|b| b.python_version = actual.into());
            let (mut events, _, _) = collect_events();
            let err = prepare_runtime(
                shared(&host),
                &catalog,
                &project.python_request(),
                &cache.0,
                &NetworkConfig::default(),
                &cancel,
                &mut events,
            )
            .await
            .unwrap_err();
            assert!(
                err.to_string().contains(code::PYTHON_VERIFY),
                "{actual}: {err}"
            );
            assert_eq!(host.sync_count(), 0);
        }
    }

    #[tokio::test]
    async fn python_version_mismatch_is_refused() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        // 解释器实际报告的版本与 .python-version 请求不符
        host.set_behavior(|b| b.python_version = "3.12.8".into());
        let (mut events, _, _) = collect_events();
        let err = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains(code::PYTHON_VERIFY),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn concurrent_prepare_builds_environment_once() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();

        let run = |owner: &'static str| {
            let host = host.clone();
            let ready = ready.clone();
            let catalog = catalog.clone();
            async move {
                let (mut events, _, _) = collect_events();
                prepare_environment(
                    shared(&host),
                    &ready,
                    &fake_project(),
                    "/ws",
                    &catalog,
                    &NetworkConfig::default(),
                    owner,
                    &AtomicBool::new(false),
                    &mut events,
                )
                .await
            }
        };
        let (a, b) = tokio::join!(run("run-a"), run("run-b"));
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a.environment_id, b.environment_id);
        assert_eq!(host.sync_count(), 1, "并发准备只应构建一次");
        assert_ne!(
            a.cache_hit, b.cache_hit,
            "恰好一个 Run 构建、另一个缓存命中"
        );
    }

    #[tokio::test]
    async fn preparing_generations_are_leased_until_handoff_and_released_on_failure_or_cancel() {
        for outcome in ["success", "failure", "cancel"] {
            let host = Arc::new(FakeHost::new());
            let cache = TestDir::new();
            let catalog = fake_catalog(&cache.0);
            let cancel = Arc::new(AtomicBool::new(false));
            let (ready, old) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
            let leases = Arc::new(crate::runtime::manager::LeaseSet::default());
            let resume = Arc::new(tokio::sync::Notify::new());
            let (paused_tx, mut paused_rx) = tokio::sync::mpsc::unbounded_channel();
            let building_host = host.clone();
            let building_leases = leases.clone();
            let building_cancel = cancel.clone();
            let building_resume = resume.clone();
            let building_catalog = catalog.clone();
            let task_host = host.clone();
            let task = tokio::spawn(async move {
                let verifier: Box<crate::runtime::prepare::InputVerifier> = Box::new(move || {
                    let (host, resume, paused_tx) = (
                        building_host.clone(),
                        building_resume.clone(),
                        paused_tx.clone(),
                    );
                    Box::pin(async move {
                        let envs = host.join(host.root(), "envs");
                        for id in host.list(&envs).await? {
                            let dir = host.join(&envs, &id);
                            if !host.exists(&host.join(&dir, manifest::READY_MARKER)).await {
                                paused_tx.send(id).unwrap();
                                resume.notified().await;
                                if outcome == "failure" {
                                    return Err(RunnerError::TaskFailed(
                                        "injected verification failure".into(),
                                    ));
                                }
                            }
                        }
                        Ok(())
                    })
                });
                let (mut events, _, _) = collect_events();
                crate::runtime::prepare::prepare_generation(
                    shared(&task_host),
                    &ready,
                    &fake_project(),
                    "/ws",
                    &building_catalog,
                    &NetworkConfig::default(),
                    "leased-preparation",
                    &building_cancel,
                    &mut events,
                    true,
                    Some(&*verifier),
                    &building_leases,
                )
                .await
            });
            let id = tokio::time::timeout(std::time::Duration::from_secs(5), paused_rx.recv())
                .await
                .unwrap()
                .unwrap();
            let dir = host.join(&host.join(host.root(), "envs"), &id);
            assert!(leases.is_leased(&id));
            assert!(
                crate::runtime::manager::delete_environment(shared(&host), &leases, &id)
                    .await
                    .is_err()
            );
            assert_eq!(
                crate::runtime::manager::clean_cache(
                    shared(&host),
                    &leases,
                    &catalog,
                    &AtomicBool::new(false)
                )
                .await
                .unwrap(),
                0
            );
            assert!(host.exists(&dir).await);
            if outcome == "cancel" {
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            resume.notify_one();
            let result = task.await.unwrap();
            if outcome == "success" {
                let prepared = result.unwrap();
                let launch_handoff = prepared.clone();
                drop(prepared);
                assert!(leases.is_leased(&id));
                assert!(
                    crate::runtime::manager::delete_environment(shared(&host), &leases, &id)
                        .await
                        .is_err()
                );
                drop(launch_handoff);
                assert!(!leases.is_leased(&id));
                crate::runtime::manager::delete_environment(shared(&host), &leases, &id)
                    .await
                    .unwrap();
            } else {
                assert!(result.is_err(), "{outcome}");
                assert!(!leases.is_leased(&id), "{outcome}");
                assert!(!host.exists(&dir).await, "{outcome}");
            }
            assert!(host.exists(&old.python_path).await);
        }
    }

    #[tokio::test]
    async fn failed_binding_publication_removes_only_new_instances_and_preserves_old_binding() {
        for failure in [
            BindingFailure::Mkdir,
            BindingFailure::Write,
            BindingFailure::Rename,
        ] {
            for scenario in ["create", "rebuild", "reuse"] {
                let host = Arc::new(FakeHost::new());
                let cache = TestDir::new();
                let catalog = fake_catalog(&cache.0);
                let cancel = AtomicBool::new(false);
                let (ready, old) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
                let leases = crate::runtime::manager::LeaseSet::default();
                leases.lease(&old.environment_id);
                let bindings = host.join(host.root(), "bindings");
                let binding_names = host.list(&bindings).await.unwrap();
                let binding = host.join(&bindings, &binding_names[0]);
                let previous_binding = host.read_file(&binding).await.unwrap();
                let envs = host.join(host.root(), "envs");
                let mut project = fake_project();
                if scenario == "create" {
                    project.lock_sha256 = "c".repeat(64);
                }
                host.set_behavior(|b| b.binding_failure = Some(failure));
                let before = host.sync_count();
                for _ in 0..2 {
                    let (mut events, _, _) = collect_events();
                    let result = crate::runtime::prepare::prepare_generation(
                        shared(&host),
                        &ready,
                        &project,
                        "/ws",
                        &catalog,
                        &NetworkConfig::default(),
                        "failed-binding",
                        &cancel,
                        &mut events,
                        scenario == "rebuild",
                        None,
                        &leases,
                    )
                    .await;
                    assert!(
                        result.unwrap_err().to_string().contains("injected binding"),
                        "{failure:?}/{scenario}"
                    );
                    assert_eq!(
                        host.list(&envs).await.unwrap(),
                        vec![old.environment_id.clone()],
                        "{failure:?}/{scenario}"
                    );
                    assert_eq!(
                        host.list(&bindings).await.unwrap(),
                        binding_names,
                        "{failure:?}/{scenario}"
                    );
                    assert_eq!(host.read_file(&binding).await.unwrap(), previous_binding);
                    assert!(host.exists(&old.python_path).await);
                    for env in host.exec_log_envs() {
                        for (_, dir) in env
                            .iter()
                            .filter(|(key, _)| key == "UV_PROJECT_ENVIRONMENT")
                        {
                            let id = dir.rsplit('/').next().unwrap();
                            if id != old.environment_id {
                                assert!(!leases.is_leased(id), "{failure:?}/{scenario}");
                            }
                        }
                    }
                }
                assert_eq!(
                    host.sync_count() - before,
                    if scenario == "reuse" { 0 } else { 2 }
                );
                host.set_behavior(|b| b.binding_failure = None);
                let count = host.sync_count();
                let (_, restored) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
                assert!(restored.cache_hit);
                assert_eq!(restored.environment_id, old.environment_id);
                assert_eq!(host.sync_count(), count);
            }
        }
    }

    #[tokio::test]
    async fn changed_inputs_never_publish_or_preserve_a_stale_generation() {
        for change_at in ["before_sync", "after_sync", "before_binding"] {
            let host = Arc::new(FakeHost::new());
            let cache = TestDir::new();
            let catalog = fake_catalog(&cache.0);
            let cancel = AtomicBool::new(false);
            let (ready, old) = full_prepare(&host, &catalog, &cache.0, &cancel).await;
            host.mkdir_all("/ws").await.unwrap();
            host.write_file("/ws/uv.lock", b"A", 0o600).await.unwrap();
            let bindings = host.join(host.root(), "bindings");
            let binding = host.join(&bindings, &host.list(&bindings).await.unwrap()[0]);
            let previous_binding = host.read_file(&binding).await.unwrap();
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let verifier: Box<crate::runtime::prepare::InputVerifier> = {
                let host = host.clone();
                let calls = calls.clone();
                Box::new(move || {
                    let host = host.clone();
                    let round = calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    Box::pin(async move {
                        if change_at == "before_binding" && round == 4 {
                            host.write_file("/ws/uv.lock", b"B", 0o600).await?;
                        }
                        if host.read_file("/ws/uv.lock").await? != b"A" {
                            return Err(RunnerError::InvalidInput("Project input changed".into()));
                        }
                        Ok(())
                    })
                })
            };
            let (mut events, _, outputs) = collect_events();
            let changing = host.clone();
            events.on_phase = Box::new(move |phase| {
                if (change_at == "before_sync" && phase == RuntimePhase::SyncingDependencies)
                    || (change_at == "after_sync" && phase == RuntimePhase::VerifyingEnvironment)
                {
                    changing
                        .state
                        .lock()
                        .unwrap()
                        .files
                        .insert("/ws/uv.lock".into(), b"B".to_vec());
                }
            });
            let result = crate::runtime::prepare::prepare_generation(
                shared(&host),
                &ready,
                &fake_project(),
                "/ws",
                &catalog,
                &NetworkConfig::default(),
                "changing-inputs",
                &cancel,
                &mut events,
                true,
                Some(&*verifier),
                &crate::runtime::manager::LeaseSet::default(),
            )
            .await;
            assert!(result.is_err(), "{change_at}");
            let log = outputs
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(_, bytes)| bytes.clone())
                .collect::<Vec<_>>();
            let log = String::from_utf8_lossy(&log);
            let stage = match change_at {
                "before_sync" => "before uv sync",
                "after_sync" => "after uv sync and smoke test",
                _ => "before publishing binding",
            };
            assert!(
                log.contains(&format!("project input verification failed ({stage})"))
                    && log.contains("Project input changed"),
                "{log}"
            );
            assert_eq!(
                host.read_file(&binding).await.unwrap(),
                previous_binding,
                "{change_at}"
            );
            assert!(host.exists(&old.python_path).await);
            assert_eq!(
                host.list(&host.join(host.root(), "envs")).await.unwrap(),
                vec![old.environment_id.clone()]
            );
            host.write_file("/ws/uv.lock", b"A", 0o600).await.unwrap();
            let count = host.sync_count();
            let (mut events, _, _) = collect_events();
            let restored = crate::runtime::prepare::prepare_generation(
                shared(&host),
                &ready,
                &fake_project(),
                "/ws",
                &catalog,
                &NetworkConfig::default(),
                "restored-inputs",
                &cancel,
                &mut events,
                false,
                Some(&*verifier),
                &crate::runtime::manager::LeaseSet::default(),
            )
            .await
            .unwrap();
            assert!(restored.cache_hit);
            assert_eq!(restored.environment_id, old.environment_id);
            assert_eq!(host.sync_count(), count);
        }
    }

    #[tokio::test]
    async fn non_utf8_output_is_preserved() {
        let host = Arc::new(FakeHost::new());
        let cache = TestDir::new();
        let catalog = fake_catalog(&cache.0);
        let cancel = AtomicBool::new(false);
        let raw = b"\xff\xfe broken".to_vec();
        host.set_behavior(|b| b.sync_stderr = raw.clone());

        let (mut events, _, _) = collect_events();
        let ready = prepare_runtime(
            shared(&host),
            &catalog,
            PYTHON_VERSION,
            &cache.0,
            &NetworkConfig::default(),
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        let (mut events, _, outputs) = collect_events();
        prepare_environment(
            shared(&host),
            &ready,
            &fake_project(),
            "/ws",
            &catalog,
            &NetworkConfig::default(),
            "run-1",
            &cancel,
            &mut events,
        )
        .await
        .unwrap();
        let collected = outputs.lock().unwrap();
        assert!(
            collected
                .iter()
                .any(|(stream, data)| *stream == OutputStream::Stderr && *data == raw),
            "非 UTF-8 字节应原样进入输出事件: {collected:?}"
        );
    }

    #[test]
    fn cancel_flag_is_checked_per_exec() {
        // 同步路径：cancel 置位后任何 exec 立即拒绝
        let host = FakeHost::new();
        let cancel = AtomicBool::new(false);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let argv = vec!["/bin/sh".into(), "-c".into(), "RRPROBE".into()];
            assert!(host.exec(&argv, &[], None, None, &cancel).await.is_ok());
            cancel.store(true, Ordering::Relaxed);
            let err = host
                .exec(&argv, &[], None, None, &cancel)
                .await
                .unwrap_err();
            assert!(err.to_string().contains(code::CANCELED));
        });
    }
}
