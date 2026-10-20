//! Environment 远端锁：最终路径 + ready marker 事务的并发保护（00005-python-runtime.md）。
//!
//! 锁是 `locks/<env-id>` 目录（posix 原子 mkdir / 本地原子 create_dir），
//! 内含 lock.json（owner、开始时间、heartbeat epoch）。过期锁仅在 heartbeat
//! 长时间未更新后接管；owner 活跃时其他 Run 等待并接收进度。
use crate::error::{Result, RunnerError};
use crate::runtime::code;
use crate::runtime::host::{check_cancel, RuntimeHost};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// heartbeat 写入间隔与锁过期时间
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// 超过该时间未更新 heartbeat 的锁可被接管
const LOCK_EXPIRY: Duration = Duration::from_secs(90);
/// 等待锁的最长时间
const LOCK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    pub owner: String,
    pub started_at: String,
    pub heartbeat_unix: u64,
}

pub struct EnvironmentLock {
    path: String,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

impl EnvironmentLock {
    pub fn path(&self) -> &str {
        &self.path
    }
}

/// 锁文件内容；heartbeat 失败不覆盖旧内容（保留 last-good）
fn lock_json(owner: &str) -> Vec<u8> {
    let info = LockInfo {
        owner: owner.to_string(),
        started_at: chrono::Local::now().to_rfc3339(),
        heartbeat_unix: now_unix(),
    };
    serde_json::to_vec_pretty(&info).unwrap_or_default()
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn read_info(host: &dyn RuntimeHost, path: &str) -> Option<LockInfo> {
    let data = host.read_file(&host.join(path, "lock.json")).await.ok()?;
    serde_json::from_slice(&data).ok()
}

/// 获取环境锁；同一 Environment ID 的并发准备只构建一次。
/// `on_wait` 在等待期间周期性回调（调用方用于上报 waiting_environment_lock 进度）。
pub async fn acquire(
    host: Arc<dyn RuntimeHost + Send + Sync>,
    locks_root: &str,
    environment_id: &str,
    owner: &str,
    cancel: &AtomicBool,
    mut on_wait: impl FnMut(u32),
) -> Result<EnvironmentLock> {
    check_cancel(cancel)?;
    let path = host.join(locks_root, environment_id);
    // 父目录可能不存在（首次准备）；mkdir_all 幂等，锁本身的获取仍靠 mkdir 原子性
    host.mkdir_all(locks_root).await?;
    let deadline = tokio::time::Instant::now() + LOCK_TIMEOUT;
    let mut waited_rounds = 0u32;
    loop {
        check_cancel(cancel)?;
        if tokio::time::Instant::now() > deadline {
            return Err(RunnerError::managed(
                code::ENV_LOCK_TIMEOUT,
                format!(
                    "environment {environment_id} lock was not released within {}s",
                    LOCK_TIMEOUT.as_secs()
                ),
            ));
        }
        // mkdir 原子获取；失败则判过期
        if host.mkdir(&path).await? {
            host.write_file(&host.join(&path, "lock.json"), &lock_json(owner), 0o600)
                .await?;
            break;
        }
        // 锁被持有：检查 heartbeat 过期后接管
        match read_info(&*host, &path).await {
            Some(info)
                if now_unix().saturating_sub(info.heartbeat_unix) > LOCK_EXPIRY.as_secs() =>
            {
                tracing::warn!(
                    "taking over expired environment lock {path} from {}",
                    info.owner
                );
                host.remove(&path).await?;
                continue;
            }
            Some(_) => {}
            None => {
                // 无 lock.json：可能是持锁者正在写入，短暂等待后重试
            }
        }
        waited_rounds += 1;
        on_wait(waited_rounds);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    // heartbeat 后台任务：持锁期间周期性刷新
    let heartbeat_path = host.join(&path, "lock.json");
    let owner = owner.to_string();
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
            let data = lock_json(&owner);
            let _ = host.write_file(&heartbeat_path, &data, 0o600).await;
        }
    });
    Ok(EnvironmentLock {
        path,
        heartbeat: Some(heartbeat),
    })
}

/// 释放锁（删除锁目录）；持有者退出前必须调用
pub async fn release(host: &dyn RuntimeHost, lock: EnvironmentLock) {
    if let Some(task) = lock.heartbeat {
        task.abort();
    }
    let _ = host.remove(&lock.path).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::hosts::local::LocalHost;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn lock_acquire_release_and_contention() {
        let root = std::env::temp_dir().join(format!("rr-lock-{}", uuid::Uuid::new_v4()));
        let host = LocalHost::new(root.to_string_lossy().into_owned()).unwrap();
        let cancel = AtomicBool::new(false);
        let locks = host.join(host.root(), "locks");

        let first = acquire(
            Arc::new(host.clone()),
            &locks,
            "env1",
            "run-a",
            &cancel,
            |_| {},
        )
        .await
        .unwrap();
        // 第二把锁拿不到；heartbeat 新鲜 → 不接管
        let waits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let host2 = LocalHost::new(root.to_string_lossy().into_owned()).unwrap();
        let waits2 = waits.clone();
        let second = tokio::spawn({
            let host2 = host2.clone();
            let locks = locks.clone();
            async move {
                acquire(
                    Arc::new(host2.clone()),
                    &locks,
                    "env1",
                    "run-b",
                    &cancel,
                    |n| {
                        waits2.store(n, Ordering::Relaxed);
                    },
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!second.is_finished());
        assert!(waits.load(Ordering::Relaxed) > 0, "等待方应收到进度回调");

        release(&host, first).await;
        let second = second.await.unwrap().unwrap();
        release(&host2, second).await;
        assert!(!host.exists(&host.join(&locks, "env1")).await);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn expired_lock_is_taken_over() {
        let root = std::env::temp_dir().join(format!("rr-lock-{}", uuid::Uuid::new_v4()));
        let host = LocalHost::new(root.to_string_lossy().into_owned()).unwrap();
        let cancel = AtomicBool::new(false);
        let locks = host.join(host.root(), "locks");
        let path = host.join(&locks, "env-expired");
        host.mkdir_all(&locks).await.unwrap();
        host.mkdir(&path).await.unwrap();
        // 写一个过期的 lock.json
        let stale = LockInfo {
            owner: "crashed-run".into(),
            started_at: "2026-01-01T00:00:00+08:00".into(),
            heartbeat_unix: now_unix() - LOCK_EXPIRY.as_secs() - 10,
        };
        host.write_file(
            &host.join(&path, "lock.json"),
            &serde_json::to_vec(&stale).unwrap(),
            0o600,
        )
        .await
        .unwrap();
        let lock = acquire(
            Arc::new(host.clone()),
            &locks,
            "env-expired",
            "new-run",
            &cancel,
            |_| {},
        )
        .await
        .unwrap();
        let info = read_info(&host, &path).await.unwrap();
        assert_eq!(info.owner, "new-run");
        release(&host, lock).await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
