//! 远端（设备）工作区：浏览 / 编辑某台设备上的目录（00004-workspace-and-sync.md）。
//!
//! SSH 经标准 SFTP 子系统访问；WSL 经 helper 的 fs_* 文件服务消息（与
//! VS Code 的 server/agent 模型同构）。编辑会话是长连接，由 SessionStore
//! 持有（同一时刻只有一个打开的工作区）；运行流程不复用该会话——跨设备
//! 运行时另建连接做暂存下载（stage），同设备原地运行由 runner 直接处理。
pub mod ssh;
pub mod stage;
pub mod wsl;

use crate::device::{DeviceProfile, TransportKind};
use crate::workspace::{Document, Entry, EntryKind, FileError, Saved};
use crate::workspace_ref::WorkspaceRef;
use futures::future::BoxFuture;
use tokio::sync::{Mutex, MutexGuard};

pub(crate) enum RemoteWorkspace {
    Ssh(ssh::SshWorkspace),
    Wsl(wsl::WslWorkspace),
}

impl RemoteWorkspace {
    pub async fn open(
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        path: &str,
    ) -> Result<Self, FileError> {
        crate::workspace_ref::validate_device_path(path).map_err(|m| FileError::new("path", m))?;
        device
            .validate()
            .map_err(|e| FileError::new("io", format!("设备配置无效：{e}")))?;
        match device.transport {
            TransportKind::Ssh => Ok(Self::Ssh(
                ssh::SshWorkspace::connect(device, config_dir, path).await?,
            )),
            TransportKind::Wsl => Ok(Self::Wsl(
                wsl::WslWorkspace::connect(
                    device
                        .wsl
                        .as_ref()
                        .ok_or_else(|| FileError::new("io", "缺少 WSL 配置"))?,
                    path,
                )
                .await?,
            )),
            _ => Err(FileError::new(
                "unsupported",
                "该设备类型不支持作为工作区宿主",
            )),
        }
    }

    pub async fn list_dir(&mut self, subdir: &str) -> Result<Vec<Entry>, FileError> {
        match self {
            Self::Ssh(session) => session.list_dir(subdir).await,
            Self::Wsl(session) => session.list_dir(subdir).await,
        }
    }

    pub async fn read(&mut self, name: &str) -> Result<Document, FileError> {
        match self {
            Self::Ssh(session) => session.read(name).await,
            Self::Wsl(session) => session.read(name).await,
        }
    }

    /// 原始字节读取（暂存下载用；不做 UTF-8/编辑器限制，limit 由调用方给）
    pub async fn read_raw(&mut self, name: &str, limit: u64) -> Result<Vec<u8>, FileError> {
        match self {
            Self::Ssh(session) => session.read_raw(name, limit).await,
            Self::Wsl(session) => session.read_raw(name, limit).await,
        }
    }

    pub async fn write(
        &mut self,
        name: &str,
        data: &[u8],
        expected_revision: &str,
    ) -> Result<Saved, FileError> {
        match self {
            Self::Ssh(session) => session.write(name, data, expected_revision).await,
            Self::Wsl(session) => session.write(name, data, expected_revision).await,
        }
    }

    pub async fn create(&mut self, name: &str, kind: EntryKind) -> Result<(), FileError> {
        match self {
            Self::Ssh(session) => session.create(name, kind).await,
            Self::Wsl(session) => session.create(name, kind).await,
        }
    }

    pub async fn create_with_content(&mut self, name: &str, data: &[u8]) -> Result<(), FileError> {
        match self {
            Self::Ssh(session) => session.create_with_content(name, data).await,
            Self::Wsl(session) => session.create_with_content(name, data).await,
        }
    }

    pub async fn rename(&mut self, old_name: &str, new_name: &str) -> Result<(), FileError> {
        match self {
            Self::Ssh(session) => session.rename(old_name, new_name).await,
            Self::Wsl(session) => session.rename(old_name, new_name).await,
        }
    }

    pub async fn delete(&mut self, name: &str) -> Result<(), FileError> {
        match self {
            Self::Ssh(session) => session.delete(name).await,
            Self::Wsl(session) => session.delete(name).await,
        }
    }
}

/// 打开的远端工作区编辑会话（单槽：UI 同一时刻只有一个工作区）
#[derive(Default)]
pub struct SessionStore {
    inner: Mutex<Option<Slot>>,
}

struct Slot {
    key: WorkspaceRef,
    revision: String,
    session: RemoteWorkspace,
}

impl SessionStore {
    /// 取与 key 匹配的会话；不匹配或尚未建立则丢弃旧会话并重新连接
    async fn claim<'a>(
        &'a self,
        key: &WorkspaceRef,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
    ) -> Result<MutexGuard<'a, Option<Slot>>, FileError> {
        let mut guard = self.inner.lock().await;
        let revision = crate::workspace_run::device_revision(device);
        if !matches!(guard.as_ref(), Some(entry) if entry.key == *key && entry.revision == revision)
        {
            *guard = None;
            let (_, path) = key
                .device_ref()
                .ok_or_else(|| FileError::new("path", "不是设备工作区"))?;
            let session = RemoteWorkspace::open(device, config_dir, path).await?;
            *guard = Some(Slot {
                key: key.clone(),
                revision,
                session,
            });
        }
        Ok(guard)
    }

    /// 连接类错误后丢弃会话，下次操作重新连接
    pub async fn invalidate(&self, key: &WorkspaceRef) {
        let mut guard = self.inner.lock().await;
        if matches!(guard.as_ref(), Some(entry) if entry.key == *key) {
            *guard = None;
        }
    }

    /// 关闭当前会话（工作区关闭或切走）
    pub async fn close(&self) {
        *self.inner.lock().await = None;
    }

    /// 串行执行一个工作区操作；连接类错误（code=io）自动使会话失效
    pub(crate) async fn with<T>(
        &self,
        key: &WorkspaceRef,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        op: impl for<'a> FnOnce(&'a mut RemoteWorkspace) -> BoxFuture<'a, Result<T, FileError>>,
    ) -> Result<T, FileError> {
        let mut guard = self.claim(key, device, config_dir).await?;
        let session = &mut guard.as_mut().expect("claimed session").session;
        match op(session).await {
            Ok(value) => Ok(value),
            Err(error) => {
                if error.code == "io" {
                    drop(guard);
                    self.invalidate(key).await;
                }
                Err(error)
            }
        }
    }
}
