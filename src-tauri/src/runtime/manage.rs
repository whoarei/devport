//! 管理命令支撑（00027 §16/§17）：按设备构造 RuntimeHost、重建环境。
//!
//! 列表类命令由 commands 层做 best-effort 降级；变更类命令错误直接上抛。
//! SSH/WSL 的重建需要先把项目工作区上传到目标临时目录（uv sync 必须在
//! 工作区可见后执行），结束后尽力清理；Local 在原始工作区中原地执行。
use crate::device::{DeviceProfile, TransportKind};
use crate::error::{Result, RunnerError};
use crate::process::OutputStream;
use crate::runtime::catalog::RuntimeCatalog;
use crate::runtime::host::RuntimeHost;
use crate::runtime::hosts::local::LocalHost;
use crate::runtime::hosts::ssh::SshHost;
use crate::runtime::hosts::wsl::WslHost;
use crate::runtime::manager::{self, LeaseSet};
use crate::runtime::prepare::{self, NetworkConfig, PrepareEvents};
use crate::runtime::{code, PreparedEnvironment, RuntimePhase};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// SSH/WSL 目标端 Runtime 根（posix，"~" 由 prepare/resolve_root 展开）
pub fn remote_root() -> String {
    format!("~/{}", crate::runtime::RUNTIME_DIR)
}

/// Local 目标 Runtime 根（本机应用数据目录下）
pub fn local_root(config_dir: &Path) -> String {
    config_dir.join("runtime-v1").to_string_lossy().into_owned()
}

fn not_supported() -> RunnerError {
    RunnerError::managed(
        code::NOT_SUPPORTED,
        "Serial Shell V1 cannot deploy a binary managed runtime",
    )
}

/// 按设备 transport 构造 RuntimeHost；Serial 明确拒绝（00027 §4）
pub async fn open_host(
    device: &DeviceProfile,
    config_dir: &Path,
) -> Result<Arc<dyn RuntimeHost + Send + Sync>> {
    match device.transport {
        TransportKind::Serial => Err(not_supported()),
        TransportKind::Local => Ok(Arc::new(LocalHost::new(local_root(config_dir))?)),
        TransportKind::Ssh => {
            let conn = crate::ssh::client::SshConnection::connect(device, config_dir).await?;
            Ok(Arc::new(SshHost::from_arc(
                conn.handle.clone(),
                remote_root(),
            )))
        }
        TransportKind::Wsl => {
            let config = device
                .wsl
                .clone()
                .ok_or_else(|| RunnerError::InvalidInput("WSL configuration is required".into()))?;
            Ok(Arc::new(WslHost::open(config, &remote_root()).await?))
        }
    }
}

/// 重建项目环境：删除现有环境（未持 lease）后走完整准备流水线。
/// 返回可直接启动的 PreparedEnvironment；SSH/WSL 先上传工作区到临时目录。
pub async fn rebuild_on_device(
    device: &DeviceProfile,
    config_dir: &Path,
    workspace_dir: &str,
    leases: &LeaseSet,
    network: &NetworkConfig,
) -> Result<PreparedEnvironment> {
    device.validate()?;
    network.validate()?;
    // Serial 在任何项目扫描/端口操作前明确拒绝（00027 §4）
    if device.transport == TransportKind::Serial {
        return Err(not_supported());
    }
    if workspace_dir.trim().is_empty() {
        return Err(RunnerError::InvalidInput(
            "workspace_dir must not be empty".into(),
        ));
    }
    let project = crate::runtime::project::inspect(Path::new(workspace_dir))?;
    let catalog = RuntimeCatalog::embedded()?;
    let cancel = AtomicBool::new(false);
    let mut events = PrepareEvents {
        on_phase: Box::new(|phase: RuntimePhase| tracing::info!("rebuild: phase {phase}")),
        on_progress: Box::new(|msg: &str, done: u64, total: Option<u64>| {
            tracing::info!("rebuild: {msg} ({done}/{total:?})")
        }),
        on_output: Box::new(|stream: OutputStream, data: &[u8]| {
            tracing::info!(
                "rebuild {stream:?}: {}",
                crate::runtime::scrub_credentials(&String::from_utf8_lossy(data))
            )
        }),
    };

    match device.transport {
        TransportKind::Serial => Err(not_supported()),
        TransportKind::Local => {
            let host: Arc<dyn RuntimeHost + Send + Sync> =
                Arc::new(LocalHost::new(local_root(config_dir))?);
            let ready = prepare::prepare_runtime(
                host.clone(),
                catalog,
                &project.python_version,
                config_dir,
                network,
                &cancel,
                &mut events,
            )
            .await?;
            manager::rebuild_environment(
                host,
                leases,
                &ready,
                &project,
                workspace_dir,
                catalog,
                config_dir,
                network,
                "manage-rebuild",
                &cancel,
                &mut events,
            )
            .await
        }
        TransportKind::Ssh => {
            let conn = crate::ssh::client::SshConnection::connect(device, config_dir).await?;
            let remote = crate::ssh::filesync::resolve_path(&conn, &temp_workspace(device)).await?;
            let host: Arc<dyn RuntimeHost + Send + Sync> =
                Arc::new(SshHost::from_arc(conn.handle.clone(), remote_root()));
            let result = match upload_ssh_workspace(&conn, workspace_dir, &remote).await {
                Ok(()) => {
                    rebuild_prepared(
                        host.clone(),
                        config_dir,
                        &project,
                        &remote,
                        catalog,
                        network,
                        leases,
                        &cancel,
                        &mut events,
                    )
                    .await
                }
                Err(e) => Err(e),
            };
            let _ = host.remove(&remote).await;
            result
        }
        TransportKind::Wsl => {
            let config = device
                .wsl
                .clone()
                .ok_or_else(|| RunnerError::InvalidInput("WSL configuration is required".into()))?;
            let wsl_host = WslHost::open(config, &remote_root()).await?;
            let remote = wsl_host.resolve_path(&temp_workspace(device)).await?;
            let host: Arc<dyn RuntimeHost + Send + Sync> = Arc::new(wsl_host);
            let result = match upload_wsl_workspace(&host, workspace_dir, &remote).await {
                Ok(()) => {
                    rebuild_prepared(
                        host.clone(),
                        config_dir,
                        &project,
                        &remote,
                        catalog,
                        network,
                        leases,
                        &cancel,
                        &mut events,
                    )
                    .await
                }
                Err(e) => Err(e),
            };
            let _ = host.remove(&remote).await;
            result
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn rebuild_prepared(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    config_dir: &Path,
    project: &crate::runtime::project::PythonProject,
    remote_workspace: &str,
    catalog: &RuntimeCatalog,
    network: &NetworkConfig,
    leases: &LeaseSet,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
) -> Result<PreparedEnvironment> {
    let ready = prepare::prepare_runtime(
        host.clone(),
        catalog,
        &project.python_version,
        config_dir,
        network,
        cancel,
        events,
    )
    .await?;
    manager::rebuild_environment(
        host,
        leases,
        &ready,
        project,
        remote_workspace,
        catalog,
        config_dir,
        network,
        "manage-rebuild",
        cancel,
        events,
    )
    .await
}

fn temp_workspace(device: &DeviceProfile) -> String {
    format!(
        "{}/env-rebuild-{}",
        device.workspace_root.trim_end_matches('/'),
        uuid::Uuid::new_v4().simple()
    )
}

async fn upload_ssh_workspace(
    conn: &crate::ssh::client::SshConnection,
    workspace_dir: &str,
    remote: &str,
) -> Result<()> {
    let sftp = crate::ssh::filesync::open_sftp(conn).await?;
    crate::ssh::filesync::upload_dir(&sftp, Path::new(workspace_dir), remote).await?;
    Ok(())
}

/// WSL 工作区上传：collect 后逐文件 write_file（目录条目显式 mkdir -p）
pub(crate) async fn upload_wsl_workspace(
    host: &Arc<dyn RuntimeHost + Send + Sync>,
    workspace_dir: &str,
    remote: &str,
) -> Result<()> {
    let dir = workspace_dir.to_string();
    let files = tokio::task::spawn_blocking(move || crate::wsl::filesync::collect(Path::new(&dir)))
        .await
        .map_err(|e| RunnerError::TaskFailed(e.to_string()))??;
    host.mkdir_all(remote).await?;
    for entry in &files {
        let target = host.join(remote, &entry.path);
        match &entry.data {
            None => host.mkdir_all(&target).await?,
            Some(data) => {
                if let Some((parent, _)) = target.rsplit_once('/') {
                    host.mkdir_all(parent).await?;
                }
                host.write_file(&target, data, entry.mode).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_are_absolute_or_home_relative() {
        assert!(remote_root().starts_with("~/"));
        assert!(remote_root().ends_with(crate::runtime::RUNTIME_DIR));
        let local = local_root(Path::new("/tmp/rr-config"));
        assert!(local.ends_with("runtime-v1"));
    }

    #[tokio::test]
    async fn serial_is_rejected_before_any_port_access() {
        let device = DeviceProfile {
            id: "d1".into(),
            name: "serial".into(),
            is_default: false,
            transport: TransportKind::Serial,
            serial: Some(crate::device::SerialConfig {
                port: "COM99".into(),
                baud_rate: 115200,
            }),
            wsl: None,
            local: None,
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: crate::device::AuthMethod::Key { key_path: None },
            workspace_root: "/tmp/devrunner/workspaces".into(),
        };
        let config = std::env::temp_dir().join(format!("rr-manage-{}", uuid::Uuid::new_v4()));
        let err = open_host(&device, &config)
            .await
            .err()
            .expect("serial must be rejected");
        assert!(err.to_string().contains(code::NOT_SUPPORTED));
        let err = rebuild_on_device(
            &device,
            &config,
            "/nonexistent",
            &LeaseSet::default(),
            &NetworkConfig::default(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains(code::NOT_SUPPORTED));
    }
}
