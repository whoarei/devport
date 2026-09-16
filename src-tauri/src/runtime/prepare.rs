//! 准备流水线：probe → 部署/验证 uv → 安装/验证 Managed Python →
//! 锁 → 复用或 `uv sync --locked` → smoke test → manifest + .ready（00027 §9-§13）。
//!
//! 取消语义：cancel 置位后当前 exec 终止远程/本地进程并返回 CANCELED；
//! 未完成环境保留 `.preparing`（无 `.ready`），下次准备进入恢复路径。
use crate::error::{Result, RunnerError};
use crate::process::OutputStream;
use crate::runtime::catalog::RuntimeCatalog;
use crate::runtime::code;
use crate::runtime::envid;
use crate::runtime::host::{check_cancel, ExecResult, RuntimeHost};
use crate::runtime::manifest::{self, EnvironmentManifest};
use crate::runtime::profile;
use crate::runtime::project::PythonProject;
use crate::runtime::{ManagedRuntimeInfo, PreparedEnvironment, RuntimePhase, RuntimeReady};
use sha2::Digest;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// 网络模式（00027 §15）：显式选择，不隐式切换
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    /// 目标直连 Python 下载源与 package index
    #[default]
    Direct,
    /// 管理员配置的镜像（UV_PYTHON_INSTALL_MIRROR / UV_INDEX_URL）
    Mirror,
    /// 离线：上传 wheelhouse，--offline --no-index --find-links
    Offline,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct NetworkConfig {
    pub mode: NetworkMode,
    pub python_install_mirror: Option<String>,
    pub index_url: Option<String>,
}

impl NetworkConfig {
    /// Rust 边界校验（00027 §19）：mirror 模式必须至少给出一个镜像地址；
    /// 地址只允许 http(s):// 或 file://，拒绝控制字符与超长输入。
    pub fn validate(&self) -> Result<()> {
        fn check_url(label: &str, url: &str) -> Result<()> {
            if url.is_empty()
                || url.len() > 2048
                || url.chars().any(|c| c == '\0' || c.is_control())
            {
                return Err(RunnerError::InvalidInput(format!("{label} is invalid")));
            }
            let allowed = url.starts_with("https://")
                || url.starts_with("http://")
                || url.starts_with("file://");
            if !allowed {
                return Err(RunnerError::InvalidInput(format!(
                    "{label} must use https://, http:// or file://"
                )));
            }
            Ok(())
        }
        if self.mode == NetworkMode::Mirror {
            if self.python_install_mirror.is_none() && self.index_url.is_none() {
                return Err(RunnerError::InvalidInput(
                    "mirror mode requires python_install_mirror and/or index_url".into(),
                ));
            }
            if let Some(mirror) = &self.python_install_mirror {
                check_url("python_install_mirror", mirror)?;
            }
            if let Some(index) = &self.index_url {
                check_url("index_url", index)?;
            }
        }
        Ok(())
    }
}

/// 准备阶段回调：phase / 进度（字节）/ 过程输出（进入同一 Run 日志）
pub struct PrepareEvents {
    pub on_phase: Box<dyn FnMut(RuntimePhase) + Send>,
    pub on_progress: Box<dyn FnMut(&str, u64, Option<u64>) + Send>,
    pub on_output: Box<dyn FnMut(OutputStream, &[u8]) + Send>,
}

impl PrepareEvents {
    fn phase(&mut self, phase: RuntimePhase) {
        (self.on_phase)(phase);
    }

    fn output(&mut self, result: &ExecResult) {
        if !result.stdout.is_empty() {
            (self.on_output)(OutputStream::Stdout, &result.stdout);
        }
        if !result.stderr.is_empty() {
            (self.on_output)(OutputStream::Stderr, &result.stderr);
        }
    }
}

/// 解析 Runtime 根目录：posix 远端把 "~" 展开为 $HOME（探测前 host.root() 可能是 "~" 形式）
pub async fn resolve_root(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    cancel: &AtomicBool,
) -> Result<String> {
    let root = host.root().to_string();
    if let Some(rest) = root.strip_prefix("~/") {
        let home = host
            .exec(
                &["/bin/sh".into(), "-c".into(), "printf %s \"$HOME\"".into()],
                &[],
                None,
                None,
                cancel,
            )
            .await?;
        if !home.success() {
            return Err(RunnerError::managed(
                code::UNSUPPORTED_PLATFORM,
                format!("cannot resolve home directory: {}", home.tail(300)),
            ));
        }
        let home = String::from_utf8_lossy(&home.stdout).trim().to_string();
        if home.is_empty() {
            return Err(RunnerError::managed(
                code::UNSUPPORTED_PLATFORM,
                "home directory is empty",
            ));
        }
        return Ok(format!("{home}/{rest}"));
    }
    Ok(root)
}

/// 固定环境变量（00027 §7）
fn uv_env(host: &dyn RuntimeHost, root: &str, network: &NetworkConfig) -> Vec<(String, String)> {
    let mut env = vec![
        ("UV_PYTHON_PREFERENCE".into(), "only-managed".into()),
        ("UV_PYTHON_INSTALL_DIR".into(), host.join(root, "python")),
        ("UV_CACHE_DIR".into(), host.join(root, "cache")),
        ("UV_NO_SYSTEM_CONFIG".into(), "1".into()),
    ];
    if network.mode == NetworkMode::Mirror {
        if let Some(mirror) = &network.python_install_mirror {
            env.push(("UV_PYTHON_INSTALL_MIRROR".into(), mirror.clone()));
        }
        if let Some(index) = &network.index_url {
            env.push(("UV_INDEX_URL".into(), index.clone()));
        }
    }
    if network.mode == NetworkMode::Offline {
        env.push(("UV_OFFLINE".into(), "1".into()));
        env.push(("UV_NO_INDEX".into(), "1".into()));
    }
    env
}

// ---------- 阶段 1：探测 + uv 部署 + Managed Python ----------

/// 准备 uv + Managed Python（与项目无关的部分）。
pub async fn prepare_runtime(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    catalog: &RuntimeCatalog,
    python_version: &str,
    cache_dir: &Path,
    network: &NetworkConfig,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<RuntimeReady> {
    events.phase(RuntimePhase::ProbingRuntime);
    let mut profile = profile::probe(&*host, cancel).await?;
    profile::check_support(&profile)?;
    catalog.select(&profile.platform_key())?;
    // posix 远端以探测到的 home 展开根目录；本机 host.root() 已是绝对路径
    let root = match &profile.home {
        Some(home) if host.root().starts_with("~/") => resolve_root(&host, cancel).await?,
        _ => host.root().to_string(),
    };
    crate::runtime::validate_runtime_root(&root, host.is_windows())
        .map_err(|e| RunnerError::managed(code::UNSUPPORTED_PLATFORM, e.to_string()))?;
    profile.runtime_root = root.clone();

    let uv_path = deploy_uv(
        &host,
        catalog,
        &root,
        &profile.platform_key(),
        cache_dir,
        cancel,
        events,
    )
    .await?;
    let (python_path, python_build) = install_python(
        &host,
        catalog,
        &root,
        python_version,
        network,
        cancel,
        events,
    )
    .await?;

    Ok(RuntimeReady {
        uv_path,
        uv_version: catalog.uv_version.clone(),
        python_path,
        python_build,
        profile,
    })
}

/// 当前 Runtime 摘要（列表展示用，不触发下载/安装）
pub async fn runtime_info(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    catalog: &RuntimeCatalog,
) -> Result<ManagedRuntimeInfo> {
    let uv_path = host.join(
        &host.join(
            &host.join(&host.join(host.root(), "tools"), "uv"),
            &catalog.uv_version,
        ),
        &host.binary_name("uv"),
    );
    Ok(ManagedRuntimeInfo {
        uv_version: catalog.uv_version.clone(),
        platform: if host.is_windows() {
            format!("windows-{}", std::env::consts::ARCH)
        } else {
            "unknown".into()
        },
        present: host.exists(&uv_path).await,
        uv_path,
    })
}

/// 部署并验证 uv：缓存命中直接复用；否则下载→解包→校验→上传→回读校验→原子发布
async fn deploy_uv(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    catalog: &RuntimeCatalog,
    root: &str,
    platform: &str,
    cache_dir: &Path,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<String> {
    let asset = catalog.select(platform)?.clone();
    let uv_name = host.binary_name("uv");
    let tools_dir = host.join(
        &host.join(&host.join(root, "tools"), "uv"),
        &catalog.uv_version,
    );
    let uv_path = host.join(&tools_dir, &uv_name);

    // 缓存命中：`uv --version` 与 Catalog 完全一致才复用
    check_cancel(cancel)?;
    if let Ok(result) = host
        .exec(
            &[uv_path.clone(), "--version".into()],
            &[],
            None,
            None,
            cancel,
        )
        .await
    {
        if result.success() && uv_version_matches(&result.stdout, &catalog.uv_version) {
            (events.on_progress)(&format!("uv {} cache hit", catalog.uv_version), 0, None);
            return Ok(uv_path);
        }
        // 版本不符：隔离旧二进制（不允许 uv self update 语义）
        let quarantine_root = host.join(root, "quarantine");
        host.mkdir_all(&quarantine_root).await?;
        let quarantined = host.join(
            &quarantine_root,
            &format!(
                "uv-{}-{}",
                catalog.uv_version,
                uuid::Uuid::new_v4().simple()
            ),
        );
        let _ = host.rename(&uv_path, &quarantined).await;
    }

    events.phase(RuntimePhase::DeployingUv);
    // 1. 桌面端获取资产（本地内容缓存 → 下载），长度/SHA256 以 Catalog 为准
    let total = (asset.size > 0).then_some(asset.size);
    (events.on_progress)(&format!("downloading uv {}", catalog.uv_version), 0, total);
    let archive = if let Some(cached) =
        crate::runtime::download::cached_asset(cache_dir, &asset, &catalog.uv_version)?
    {
        (events.on_progress)("uv archive cache hit", cached.len() as u64, total);
        cached
    } else {
        let asset_clone = asset.clone();
        let downloaded = tokio::task::spawn_blocking(move || {
            crate::runtime::download::download_asset(&asset_clone, Duration::from_secs(15))
        })
        .await
        .map_err(|e| {
            RunnerError::managed(code::UV_ASSET_VERIFY, format!("download task failed: {e}"))
        })??;
        crate::runtime::download::store_cache(cache_dir, &asset, &catalog.uv_version, &downloaded)?;
        (events.on_progress)("uv archive downloaded", downloaded.len() as u64, total);
        downloaded
    };
    let binary = crate::runtime::download::unpack_uv(&archive, host.is_windows())?;

    // 2. 上传到目标临时文件并回读校验 SHA256（不假定目标有 sha256sum）
    let downloads = host.join(root, "downloads");
    host.mkdir_all(&downloads).await?;
    let tmp_remote = host.join(
        &downloads,
        &format!(
            "uv-{}-{}",
            catalog.uv_version,
            uuid::Uuid::new_v4().simple()
        ),
    );
    (events.on_progress)("uploading uv binary", 0, Some(binary.bytes.len() as u64));
    host.write_file(&tmp_remote, &binary.bytes, 0o700).await?;
    let readback = host.read_file(&tmp_remote).await?;
    if readback != binary.bytes {
        let _ = host.remove(&tmp_remote).await;
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            "uv binary readback mismatch after upload",
        ));
    }

    // 3. 仅当前用户可执行（write_file mode=0o700）+ 同文件系统原子发布
    host.mkdir_all(&tools_dir).await?;
    if host.rename(&tmp_remote, &uv_path).await.is_err() {
        let _ = host.remove(&tmp_remote).await;
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!("cannot publish uv to {uv_path}"),
        ));
    }

    // 4. `uv --version` 必须与 Catalog 完全一致
    let verify = host
        .exec(
            &[uv_path.clone(), "--version".into()],
            &[],
            None,
            None,
            cancel,
        )
        .await?;
    if !verify.success() || !uv_version_matches(&verify.stdout, &catalog.uv_version) {
        let _ = host.remove(&uv_path).await;
        return Err(RunnerError::managed(
            code::UV_VERSION_MISMATCH,
            format!(
                "deployed uv version mismatch: expected {}, got {:?}",
                catalog.uv_version,
                String::from_utf8_lossy(&verify.stdout)
            ),
        ));
    }
    (events.on_progress)(
        &format!("uv {} deployed", catalog.uv_version),
        binary.bytes.len() as u64,
        None,
    );
    Ok(uv_path)
}

fn uv_version_matches(stdout: &[u8], expected: &str) -> bool {
    String::from_utf8_lossy(stdout)
        .lines()
        .next()
        .map(str::trim)
        .is_some_and(|line| line == format!("uv {expected}"))
}

/// 安装并验证 Managed Python：精确版本、managed-only、拒绝系统 Python
async fn install_python(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    catalog: &RuntimeCatalog,
    root: &str,
    python_version: &str,
    network: &NetworkConfig,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<(String, String)> {
    events.phase(RuntimePhase::InstallingPython);
    let env = uv_env(&**host, root, network);
    let uv_path = host.join(
        &host.join(
            &host.join(&host.join(root, "tools"), "uv"),
            &catalog.uv_version,
        ),
        &host.binary_name("uv"),
    );
    let install_dir = host.join(root, "python");

    // uv python install 幂等：已安装时快速返回
    (events.on_progress)(&format!("installing CPython {python_version}"), 0, None);
    let install = host
        .exec(
            &[
                uv_path.clone(),
                "python".into(),
                "install".into(),
                python_version.into(),
            ],
            &env,
            None,
            None,
            cancel,
        )
        .await?;
    events.output(&install);
    if !install.success() {
        return Err(RunnerError::managed(
            code::PYTHON_INSTALL,
            format!(
                "uv python install failed (exit {:?}): {}",
                install.code,
                install.tail(1200)
            ),
        ));
    }

    // 解析实际解释器路径（不依赖 PATH，不拼接猜测）
    let find = host
        .exec(
            &[
                uv_path.clone(),
                "python".into(),
                "find".into(),
                python_version.into(),
                "--managed-python".into(),
            ],
            &env,
            None,
            None,
            cancel,
        )
        .await?;
    if !find.success() {
        return Err(RunnerError::managed(
            code::PYTHON_INSTALL,
            format!("uv python find failed: {}", find.tail(800)),
        ));
    }
    let python_path = String::from_utf8_lossy(&find.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            RunnerError::managed(code::PYTHON_VERIFY, "uv python find returned no path")
        })?;
    // 任何试图指回系统 Python 的结果都被拒绝
    if !python_path.starts_with(install_dir.trim_end_matches(['/', '\\'])) {
        return Err(RunnerError::managed(
            code::PYTHON_VERIFY,
            format!(
                "refusing non-managed interpreter {python_path:?} (expected under {install_dir})"
            ),
        ));
    }

    // 实际解释器验证：版本、实现、SOABI、platform
    let info = host
        .exec(
            &[python_path.clone(), "-c".into(), PYTHON_INFO_SNIPPET.into()],
            &[],
            None,
            None,
            cancel,
        )
        .await?;
    if !info.success() {
        return Err(RunnerError::managed(
            code::PYTHON_VERIFY,
            format!("managed Python smoke probe failed: {}", info.tail(800)),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&info.stdout).map_err(|e| {
        RunnerError::managed(
            code::PYTHON_VERIFY,
            format!("cannot parse Python info: {e}"),
        )
    })?;
    let version = parsed["version"].as_str().unwrap_or("");
    if version != python_version {
        return Err(RunnerError::managed(
            code::PYTHON_VERIFY,
            format!("managed Python version mismatch: requested {python_version}, got {version}"),
        ));
    }
    let build = python_build_id(&parsed);
    Ok((python_path, build))
}

/// Python build identity：实现 + 版本 + SOABI + 平台 的摘要（uv 版本间接固定该清单）
pub fn python_build_id(info: &serde_json::Value) -> String {
    let mut hasher = sha2::Sha256::new();
    for key in ["implementation", "version", "soabi", "platform"] {
        hasher.update(info[key].as_str().unwrap_or("").as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())[..16].to_string()
}

const PYTHON_INFO_SNIPPET: &str = "import json,platform,sysconfig;print(json.dumps({'version':platform.python_version(),'implementation':platform.python_implementation(),'platform':platform.platform(),'soabi':sysconfig.get_config_var('SOABI') or ''}))";

const SMOKE_SNIPPET: &str = "import json,sys;print(json.dumps({'prefix':sys.prefix,'version':sys.version.split()[0],'executable':sys.executable}))";

// ---------- 阶段 2：环境锁 + uv sync --locked + 验证 ----------

pub async fn prepare_environment(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    ready: &RuntimeReady,
    project: &PythonProject,
    workspace_dir: &str,
    catalog: &RuntimeCatalog,
    network: &NetworkConfig,
    owner: &str,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<PreparedEnvironment> {
    let root = ready.profile.runtime_root.clone();
    let platform = ready.profile.platform_key();
    let python_version = project.python_version.clone();
    let environment_id = envid::compute(
        &ready.uv_version,
        &platform,
        &python_version,
        &ready.python_build,
        &ready.profile.os,
        &ready.profile.arch,
        ready.profile.libc.as_deref(),
        &project.lock_sha256,
        &project.groups,
        &project.extras,
        &project.package_source_identity,
    );
    let envs_root = host.join(&root, "envs");
    let locks_root = host.join(&root, "locks");
    let env_dir = host.join(&envs_root, &environment_id);
    let manifest_path = host.join(&env_dir, manifest::MANIFEST_NAME);
    let ready_path = host.join(&env_dir, manifest::READY_MARKER);
    let preparing_path = host.join(&env_dir, manifest::PREPARING_MARKER);

    // 锁（并发 Run 只构建一次；等待期间上报进度）
    events.phase(RuntimePhase::WaitingEnvironmentLock);
    let lock = crate::runtime::lock::acquire(
        host.clone(),
        &locks_root,
        &environment_id,
        owner,
        cancel,
        |round| {
            (events.on_progress)(&format!("waiting for environment lock ({round})"), 0, None);
        },
    )
    .await?;

    let result = prepare_environment_locked(
        &host,
        ready,
        project,
        workspace_dir,
        catalog,
        network,
        cancel,
        events,
        &root,
        &env_dir,
        &manifest_path,
        &ready_path,
        &preparing_path,
        &environment_id,
        &python_version,
    )
    .await;

    crate::runtime::lock::release(&*host, lock).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn prepare_environment_locked(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    ready: &RuntimeReady,
    project: &PythonProject,
    workspace_dir: &str,
    catalog: &RuntimeCatalog,
    network: &NetworkConfig,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
    root: &str,
    env_dir: &str,
    manifest_path: &str,
    ready_path: &str,
    preparing_path: &str,
    environment_id: &str,
    python_version: &str,
) -> Result<PreparedEnvironment> {
    // 缓存命中：manifest + .ready + smoke test
    if host.exists(ready_path).await {
        if let Ok(data) = host.read_file(manifest_path).await {
            if let Ok(existing) = EnvironmentManifest::parse(&data) {
                if existing.environment_id == environment_id
                    && existing.lock_sha256 == project.lock_sha256
                    && existing.uv_version == ready.uv_version
                {
                    events.phase(RuntimePhase::VerifyingEnvironment);
                    match verify_environment(host, env_dir, python_version, cancel).await {
                        Ok(python_path) => {
                            let mut updated = existing.clone();
                            updated.last_used_at = chrono::Local::now().to_rfc3339();
                            if let Ok(bytes) = updated.to_json() {
                                let _ =
                                    manifest::write_atomic(&**host, manifest_path, &bytes).await;
                            }
                            return Ok(PreparedEnvironment {
                                environment_id: environment_id.to_string(),
                                env_path: env_dir.to_string(),
                                python_path,
                                uv_version: ready.uv_version.clone(),
                                python_version: python_version.to_string(),
                                lock_sha256: project.lock_sha256.clone(),
                                cache_hit: true,
                            });
                        }
                        Err(e) => {
                            tracing::warn!(
                                "environment {environment_id} verification failed: {e}; rebuilding"
                            );
                        }
                    }
                }
            }
        }
    }

    // 恢复路径：.preparing / 缺失 .ready / manifest 无效 → 隔离旧环境
    if host.exists(env_dir).await {
        let quarantine_root = host.join(root, "quarantine");
        host.mkdir_all(&quarantine_root).await?;
        let quarantined = host.join(
            &quarantine_root,
            &format!("{environment_id}-{}", uuid::Uuid::new_v4().simple()),
        );
        host.rename(env_dir, &quarantined).await?;
        (events.on_progress)("quarantined incomplete environment", 0, None);
    }

    // 最终路径创建 + .preparing（venv 不可整体 rename：console-script shebang 存绝对路径）
    host.mkdir_all(env_dir).await?;
    host.write_file(preparing_path, b"", 0o600).await?;

    // uv sync --locked：锁文件过期/不一致直接失败，不改写锁文件
    events.phase(RuntimePhase::SyncingDependencies);
    run_uv_sync(
        host,
        ready,
        project,
        workspace_dir,
        env_dir,
        catalog,
        network,
        cancel,
        events,
    )
    .await?;

    // 验证：环境内 Python 位置以探测 + smoke test 为准
    events.phase(RuntimePhase::VerifyingEnvironment);
    let python_path = verify_environment(host, env_dir, python_version, cancel).await?;

    // manifest 原子写，最后原子创建 .ready
    let now = chrono::Local::now().to_rfc3339();
    let manifest = EnvironmentManifest {
        schema: crate::runtime::SCHEMA,
        environment_id: environment_id.to_string(),
        uv_version: ready.uv_version.clone(),
        python_request: python_version.to_string(),
        python_executable: python_path.clone(),
        python_version: python_version.to_string(),
        python_build: ready.python_build.clone(),
        platform: ready.profile.platform_key(),
        libc: ready.profile.libc.clone(),
        lock_sha256: project.lock_sha256.clone(),
        groups: project.groups.clone(),
        extras: project.extras.clone(),
        created_at: now.clone(),
        last_used_at: now,
    };
    let bytes = manifest.to_json()?;
    manifest::write_atomic(&**host, manifest_path, &bytes).await?;
    manifest::write_atomic(&**host, ready_path, b"").await?;
    let _ = host.remove(preparing_path).await;

    Ok(PreparedEnvironment {
        environment_id: environment_id.to_string(),
        env_path: env_dir.to_string(),
        python_path,
        uv_version: ready.uv_version.clone(),
        python_version: python_version.to_string(),
        lock_sha256: project.lock_sha256.clone(),
        cache_hit: false,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_uv_sync(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    ready: &RuntimeReady,
    project: &PythonProject,
    workspace_dir: &str,
    env_dir: &str,
    _catalog: &RuntimeCatalog,
    network: &NetworkConfig,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<()> {
    let mut env = uv_env(&**host, &ready.profile.runtime_root, network);
    env.push(("UV_PROJECT_ENVIRONMENT".into(), env_dir.to_string()));

    let mut argv = vec![
        ready.uv_path.clone(),
        "sync".into(),
        "--locked".into(),
        "--no-install-project".into(),
        "--no-default-groups".into(),
        "--managed-python".into(),
        "--no-python-downloads".into(),
        "--no-progress".into(),
    ];
    for group in &project.groups {
        argv.push("--group".into());
        argv.push(group.clone());
    }
    for extra in &project.extras {
        argv.push("--extra".into());
        argv.push(extra.clone());
    }
    if network.mode == NetworkMode::Offline {
        let wheelhouse = host.join(workspace_dir, "wheelhouse");
        if !host.exists(&wheelhouse).await {
            return Err(RunnerError::managed(
                code::OFFLINE_ARTIFACT,
                "offline mode requires a wheelhouse/ directory in the project workspace",
            ));
        }
        argv.push("--offline".into());
        argv.push("--no-index".into());
        argv.push("--find-links".into());
        argv.push(wheelhouse);
    }

    (events.on_progress)(
        &format!(
            "uv sync --locked ({} groups, {} extras)",
            project.groups.len(),
            project.extras.len()
        ),
        0,
        None,
    );
    let result = host
        .exec(&argv, &env, Some(workspace_dir), None, cancel)
        .await?;
    events.output(&result);
    if !result.success() {
        return Err(RunnerError::managed(
            code::ENV_SYNC,
            format!(
                "uv sync failed (exit {:?}): {}",
                result.code,
                result.tail(1200)
            ),
        ));
    }
    Ok(())
}

/// 探测环境内 Python 并执行 smoke test；返回实际解释器路径
async fn verify_environment(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    env_dir: &str,
    python_version: &str,
    cancel: &AtomicBool,
) -> Result<String> {
    let candidates = if host.is_windows() {
        vec![host.join(env_dir, "Scripts\\python.exe")]
    } else {
        vec![host.join(env_dir, "bin/python")]
    };
    let mut python_path = None;
    for candidate in &candidates {
        if host.exists(candidate).await {
            python_path = Some(candidate.clone());
            break;
        }
    }
    let python_path = python_path.ok_or_else(|| {
        RunnerError::managed(
            code::ENV_VERIFY,
            format!("no interpreter found in environment {env_dir}"),
        )
    })?;

    let smoke = host
        .exec(
            &[
                python_path.clone(),
                "-I".into(),
                "-c".into(),
                SMOKE_SNIPPET.into(),
            ],
            &[],
            Some(env_dir),
            None,
            cancel,
        )
        .await?;
    if !smoke.success() {
        return Err(RunnerError::managed(
            code::ENV_VERIFY,
            format!("environment smoke test failed: {}", smoke.tail(800)),
        ));
    }
    let parsed: serde_json::Value = serde_json::from_slice(&smoke.stdout).map_err(|e| {
        RunnerError::managed(code::ENV_VERIFY, format!("cannot parse smoke output: {e}"))
    })?;
    let prefix = parsed["prefix"].as_str().unwrap_or("");
    let version = parsed["version"].as_str().unwrap_or("");
    let normalized = |s: &str| {
        if host.is_windows() {
            s.replace('/', "\\").to_ascii_lowercase()
        } else {
            s.to_string()
        }
    };
    if normalized(prefix) != normalized(env_dir) {
        return Err(RunnerError::managed(
            code::ENV_VERIFY,
            format!("environment prefix mismatch: smoke says {prefix:?}, expected {env_dir:?}"),
        ));
    }
    if version != python_version {
        return Err(RunnerError::managed(
            code::ENV_VERIFY,
            format!("environment Python mismatch: expected {python_version}, got {version}"),
        ));
    }
    Ok(python_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_config_validation() {
        NetworkConfig::default().validate().unwrap();
        NetworkConfig {
            mode: NetworkMode::Offline,
            ..Default::default()
        }
        .validate()
        .unwrap();
        // mirror 必须至少给出一个地址
        assert!(NetworkConfig {
            mode: NetworkMode::Mirror,
            ..Default::default()
        }
        .validate()
        .is_err());
        NetworkConfig {
            mode: NetworkMode::Mirror,
            python_install_mirror: Some("https://mirror.local/python".into()),
            index_url: Some("file:///srv/wheels".into()),
        }
        .validate()
        .unwrap();
        // 非允许 scheme / 控制字符拒绝
        for bad in ["ftp://x", "javascript:alert(1)", "https://ok\0bad"] {
            assert!(
                NetworkConfig {
                    mode: NetworkMode::Mirror,
                    python_install_mirror: Some(bad.into()),
                    index_url: None,
                }
                .validate()
                .is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn build_id_is_stable_and_sensitive() {
        let info = |v: &str| serde_json::json!({"implementation":"CPython","version":v,"platform":"Linux-6.8","soabi":"cpython-312-x86_64-linux-gnu"});
        assert_eq!(
            python_build_id(&info("3.12.9")),
            python_build_id(&info("3.12.9"))
        );
        assert_ne!(
            python_build_id(&info("3.12.9")),
            python_build_id(&info("3.12.10"))
        );
    }
}
