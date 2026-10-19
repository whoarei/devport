//! 缓存管理：lease、环境/Runtime 列表、删除、重建与清理（00027 §16）。
//!
//! GC/删除必须验证路径仍位于专用根目录内且不跟随链接；持 lease 的
//! Environment 不可删除（活跃 Run 保护）。
use crate::error::{Result, RunnerError};
use crate::runtime::catalog::RuntimeCatalog;
use crate::runtime::code;
use crate::runtime::host::RuntimeHost;
use crate::runtime::manifest::{
    EnvironmentManifest, MANIFEST_NAME, PREPARING_MARKER, READY_MARKER,
};
use crate::runtime::prepare::{self, NetworkConfig, PrepareEvents};
use crate::runtime::{ProjectEnvironmentInfo, RuntimeReady};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// 环境准备和活跃 Run 共用的实例 lease（进程内）。
#[derive(Default, Debug)]
pub struct LeaseSet {
    leased: Arc<Mutex<HashMap<String, usize>>>,
    maintenance: tokio::sync::Mutex<()>,
}

/// Held from before an instance is inspected/created through its launch handoff.
#[derive(Debug)]
pub struct EnvironmentLease {
    leased: Arc<Mutex<HashMap<String, usize>>>,
    id: String,
}
impl Drop for EnvironmentLease {
    fn drop(&mut self) {
        let mut leased = self.leased.lock();
        if let Some(count) = leased.get_mut(&self.id) {
            *count -= 1;
            if *count == 0 {
                leased.remove(&self.id);
            }
        }
    }
}

impl LeaseSet {
    pub async fn acquire(
        &self,
        environment_id: &str,
        cancel: &AtomicBool,
    ) -> Result<Arc<EnvironmentLease>> {
        // Register atomically with respect to a cleanup's check and removal.
        let _maintenance = tokio::select! {
            biased;
            _ = crate::runtime::host::cancelled(cancel) => return Err(crate::runtime::host::canceled_error()),
            guard = self.maintenance.lock() => guard,
        };
        self.lease(environment_id);
        Ok(Arc::new(EnvironmentLease {
            leased: self.leased.clone(),
            id: environment_id.into(),
        }))
    }
    pub fn lease(&self, environment_id: &str) {
        *self
            .leased
            .lock()
            .entry(environment_id.to_string())
            .or_default() += 1;
    }

    pub fn release(&self, environment_id: &str) {
        let mut leased = self.leased.lock();
        if let Some(count) = leased.get_mut(environment_id) {
            *count -= 1;
            if *count == 0 {
                leased.remove(environment_id);
            }
        }
    }

    pub fn is_leased(&self, environment_id: &str) -> bool {
        self.leased.lock().contains_key(environment_id)
    }
}

/// 校验 environment id 形态（hex，路径段安全）
fn valid_env_id(id: &str) -> bool {
    id.len() == crate::runtime::envid::ENV_ID_LEN && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 确保 path 位于 root 内（防御性 containment；调用方构造的路径也必须过这一关）
fn ensure_inside(root: &str, path: &str) -> Result<()> {
    let normalize = |s: &str| s.replace('\\', "/");
    let (root, path) = (normalize(root), normalize(path));
    let root = root.trim_end_matches('/');
    if path == root || path.starts_with(&format!("{root}/")) {
        Ok(())
    } else {
        Err(RunnerError::managed(
            code::CLEANUP,
            format!("refusing to touch path outside runtime root: {path}"),
        ))
    }
}

/// 列出全部项目环境（含未完成的；manifest 不可解析时 manifest=None）
pub async fn list_environments(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    leases: &LeaseSet,
) -> Result<Vec<ProjectEnvironmentInfo>> {
    let root = resolve_or_local_root(&host).await;
    let envs_root = host.join(&root, "envs");
    let mut out = Vec::new();
    for id in host.list(&envs_root).await? {
        if !valid_env_id(&id) {
            continue;
        }
        let env_dir = host.join(&envs_root, &id);
        let manifest = match host.read_file(&host.join(&env_dir, MANIFEST_NAME)).await {
            Ok(data) => EnvironmentManifest::parse(&data).ok(),
            Err(_) => None,
        };
        out.push(ProjectEnvironmentInfo {
            ready: host.exists(&host.join(&env_dir, READY_MARKER)).await,
            leased: leases.is_leased(&id),
            path: env_dir.clone(),
            id,
            manifest,
        });
    }
    out.sort_by(|a, b| {
        let at = a
            .manifest
            .as_ref()
            .map(|m| m.last_used_at.as_str())
            .unwrap_or("");
        let bt = b
            .manifest
            .as_ref()
            .map(|m| m.last_used_at.as_str())
            .unwrap_or("");
        bt.cmp(at)
    });
    Ok(out)
}

async fn resolve_or_local_root(host: &Arc<dyn RuntimeHost + Send + Sync>) -> String {
    if host.root().starts_with("~/") {
        let cancel = AtomicBool::new(false);
        prepare::resolve_root(host, &cancel)
            .await
            .unwrap_or_else(|_| host.root().to_string())
    } else {
        host.root().to_string()
    }
}

/// 删除环境：校验 id、containment、非 lease；目录整体移除（不跟随链接）
pub async fn delete_environment(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    leases: &LeaseSet,
    environment_id: &str,
) -> Result<()> {
    let _maintenance = leases.maintenance.lock().await;
    if !valid_env_id(environment_id) {
        return Err(RunnerError::InvalidInput(format!(
            "invalid environment id {environment_id:?}"
        )));
    }
    if leases.is_leased(environment_id) {
        return Err(RunnerError::managed(
            code::CLEANUP,
            format!("environment {environment_id} is being prepared or used by an active run"),
        ));
    }
    let root = resolve_or_local_root(&host).await;
    let envs_root = host.join(&root, "envs");
    let env_dir = host.join(&envs_root, environment_id);
    ensure_inside(&root, &env_dir)?;
    if !host.exists(&env_dir).await {
        return Err(RunnerError::managed(
            code::CLEANUP,
            format!("environment {environment_id} does not exist"),
        ));
    }
    host.remove(&env_dir).await?;
    Ok(())
}

/// 重建环境：创建新一代实例并更新配方绑定，已有实例保持在原路径。
pub async fn rebuild_environment(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    leases: &LeaseSet,
    ready: &RuntimeReady,
    project: &crate::runtime::project::PythonProject,
    workspace_dir: &str,
    catalog: &RuntimeCatalog,
    _cache_dir: &std::path::Path,
    network: &NetworkConfig,
    owner: &str,
    cancel: &AtomicBool,
    events: &mut PrepareEvents,
    verify_inputs: Option<&prepare::InputVerifier>,
) -> Result<crate::runtime::PreparedEnvironment> {
    // Rebinding to a new generation leaves every leased instance at its final path.
    prepare::prepare_generation(
        host,
        ready,
        project,
        workspace_dir,
        catalog,
        network,
        owner,
        cancel,
        events,
        true,
        verify_inputs,
        leases,
    )
    .await
}

/// 清理：1) quarantine 过期内容 2) 未完成环境（.preparing/无 .ready，非 lease）
/// 3) `uv cache prune`（若 uv 已部署）。有 lease 的环境不动。
pub async fn clean_cache(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    leases: &LeaseSet,
    catalog: &RuntimeCatalog,
    cancel: &AtomicBool,
) -> Result<u64> {
    let _maintenance = leases.maintenance.lock().await;
    let root = resolve_or_local_root(&host).await;
    let mut removed = 0u64;

    // 1. quarantine 全清（隔离区内容本就不可再用）
    let quarantine = host.join(&root, "quarantine");
    for name in host.list(&quarantine).await? {
        let path = host.join(&quarantine, &name);
        ensure_inside(&root, &path)?;
        host.remove(&path).await?;
        removed += 1;
    }

    // 2. 未完成环境
    let envs_root = host.join(&root, "envs");
    for id in host.list(&envs_root).await? {
        if !valid_env_id(&id) || leases.is_leased(&id) {
            continue;
        }
        let env_dir = host.join(&envs_root, &id);
        ensure_inside(&root, &env_dir)?;
        let ready_marker = host.join(&env_dir, READY_MARKER);
        let preparing = host.join(&env_dir, PREPARING_MARKER);
        let incomplete = host.exists(&preparing).await || !host.exists(&ready_marker).await;
        if incomplete {
            host.remove(&env_dir).await?;
            removed += 1;
        }
    }

    drop(_maintenance);
    // 3. uv dependency cache prune（best effort，uv 未部署时跳过）
    let uv_path = host.join(
        &host.join(
            &host.join(&host.join(&root, "tools"), "uv"),
            &catalog.uv_version,
        ),
        &host.binary_name("uv"),
    );
    if host.exists(&uv_path).await {
        let env = vec![
            ("UV_CACHE_DIR".into(), host.join(&root, "cache")),
            ("UV_NO_SYSTEM_CONFIG".into(), "1".into()),
        ];
        let _ = host
            .exec(
                &[uv_path, "cache".into(), "prune".into(), "--ci".into()],
                &env,
                None,
                None,
                cancel,
            )
            .await;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::hosts::local::LocalHost;

    fn host() -> (Arc<dyn RuntimeHost + Send + Sync>, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("rr-mgr-{}", uuid::Uuid::new_v4()));
        (
            Arc::new(LocalHost::new(root.to_string_lossy().into_owned()).unwrap()),
            root,
        )
    }

    #[tokio::test]
    async fn preparation_can_cancel_while_waiting_for_cache_maintenance() {
        let leases = Arc::new(LeaseSet::default());
        let cancel = Arc::new(AtomicBool::new(false));
        let maintenance = leases.maintenance.lock().await;
        let waiting_leases = leases.clone();
        let waiting_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            waiting_leases
                .acquire(&"e".repeat(32), &waiting_cancel)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert!(!leases.is_leased(&"e".repeat(32)));
        drop(maintenance);
    }

    #[tokio::test]
    async fn delete_validates_id_containment_and_lease() {
        let (host, root) = host();
        let leases = LeaseSet::default();
        // 构造一个假环境目录
        let envs = host.join(host.root(), "envs");
        let id = "a".repeat(32);
        host.mkdir_all(&host.join(&envs, &id)).await.unwrap();

        assert!(delete_environment(host.clone(), &leases, "../escape")
            .await
            .is_err());
        assert!(delete_environment(host.clone(), &leases, "zzz")
            .await
            .is_err());
        leases.lease(&id);
        let err = delete_environment(host.clone(), &leases, &id)
            .await
            .unwrap_err();
        assert!(err.to_string().contains(code::CLEANUP));
        leases.release(&id);
        delete_environment(host.clone(), &leases, &id)
            .await
            .unwrap();
        assert!(!host.exists(&host.join(&envs, &id)).await);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn clean_cache_removes_quarantine_and_incomplete_but_keeps_leased() {
        let (host, root) = host();
        let leases = LeaseSet::default();
        let root_str = host.root().to_string();
        let envs = host.join(&root_str, "envs");
        let quarantine = host.join(&root_str, "quarantine");

        host.mkdir_all(&quarantine).await.unwrap();
        host.mkdir_all(&host.join(&quarantine, "stale-env"))
            .await
            .unwrap();

        let incomplete = "b".repeat(32);
        let complete = "c".repeat(32);
        let leased = "d".repeat(32);
        for (id, ready) in [(&incomplete, false), (&complete, true), (&leased, false)] {
            let dir = host.join(&envs, id);
            host.mkdir_all(&dir).await.unwrap();
            host.write_file(&host.join(&dir, PREPARING_MARKER), b"", 0o600)
                .await
                .unwrap();
            if ready {
                host.write_file(&host.join(&dir, READY_MARKER), b"", 0o600)
                    .await
                    .unwrap();
                host.remove(&host.join(&dir, PREPARING_MARKER))
                    .await
                    .unwrap();
            }
        }
        leases.lease(&leased);

        let catalog = RuntimeCatalog::embedded().unwrap().clone();
        let cancel = AtomicBool::new(false);
        let removed = clean_cache(host.clone(), &leases, &catalog, &cancel)
            .await
            .unwrap();
        assert_eq!(removed, 2, "quarantine + incomplete");
        assert!(!host.exists(&host.join(&quarantine, "stale-env")).await);
        assert!(!host.exists(&host.join(&envs, &incomplete)).await);
        assert!(host.exists(&host.join(&envs, &complete)).await);
        assert!(host.exists(&host.join(&envs, &leased)).await);

        let listed = list_environments(host.clone(), &leases).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().find(|e| e.id == leased).unwrap().leased);
        std::fs::remove_dir_all(root).unwrap();
    }
}
