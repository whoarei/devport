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
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            uv_version: "0.12.13".into(),
            python_version: "3.12.9".into(),
            find_returns_system: false,
            sync_fails: false,
            sync_stderr: Vec::new(),
        }
    }
}

#[derive(Default)]
struct FakeState {
    files: HashMap<String, Vec<u8>>,
    dirs: HashSet<String>,
    behavior: Behavior,
    exec_log: Vec<Vec<String>>,
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

    fn exec_inner(
        &self,
        argv: &[String],
        env: &[(String, String)],
        cancel: &AtomicBool,
    ) -> Result<ExecResult> {
        check_cancel(cancel)?;
        let mut state = self.state.lock().unwrap();
        state.exec_log.push(argv.to_vec());
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
                        return Ok(ExecResult {
                            code: Some(0),
                            stdout: format!("uv {version}\n").into_bytes(),
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
                        let requested = argv.get(3).map(String::as_str).unwrap_or("3.12.9");
                        let path = format!(
                            "{}/python/cpython-{requested}-linux-x86_64-gnu/bin/python3.12",
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
        Box::pin(async move { self.state.lock().unwrap().mkdir_all_locked(path) })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move { self.state.lock().unwrap().rename_locked(from, to) })
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

    /// 单文件 tar.gz（只含 `uv`），与 unpack_uv 的严格解包规则匹配
    fn fake_uv_archive() -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut buffer, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let data = b"#!/bin/sh\necho fake uv\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "uv", &data[..]).unwrap();
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

        let (mut events, phases, _) = collect_events();
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

        host.set_behavior(|b| b.sync_fails = true);
        let (mut events, _, _) = collect_events();
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
        // 环境目录保留 .preparing、无 .ready
        let envs = host.list(&format!("{}/envs", host.root())).await.unwrap();
        assert_eq!(envs.len(), 1);
        let env_dir = format!("{}/envs/{}", host.root(), envs[0]);
        assert!(
            host.exists(&format!("{env_dir}/{}", manifest::PREPARING_MARKER))
                .await
        );
        assert!(
            !host
                .exists(&format!("{env_dir}/{}", manifest::READY_MARKER))
                .await
        );

        // 修复后重跑：隔离残留目录并成功
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
        // 残留目录被隔离到 quarantine
        let quarantine = host
            .list(&format!("{}/quarantine", host.root()))
            .await
            .unwrap();
        assert_eq!(quarantine.len(), 1);
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
