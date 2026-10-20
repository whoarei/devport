//! SSH 设备工作区：经标准 SFTP 子系统浏览 / 编辑设备上的目录（00004-workspace-and-sync.md）。
//!
//! 安全模型与本机工作区对齐：工作区根 canonicalize 一次（允许配置路径
//! 经过链接，操作落在真实目录上），根以下每一级组件都以 LSTAT 拒绝符号
//! 链接；相对路径组件复用 workspace::components 校验。
use crate::device::DeviceProfile;
use crate::ssh::client::SshConnection;
use crate::ssh::filesync::open_sftp;
use crate::workspace::{self, Document, Entry, EntryKind, FileError, Saved};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const READ_LIMIT: u64 = workspace::FILE_LIMIT as u64;
/// 递归删除的条目上限，与上传扫描一致
const DELETE_ENTRY_LIMIT: usize = 4096;

pub struct SshWorkspace {
    /// 保活连接；SFTP 子系统通道独立持有
    _conn: SshConnection,
    sftp: SftpSession,
    /// canonical 工作区根（已解析链接，无尾斜杠，根目录为 "/"）
    root: String,
}

fn invalid_path() -> FileError {
    FileError::new(
        "path",
        "仅可操作工作区内的普通文件或目录，不支持链接或重定向路径",
    )
}

fn map_err(error: SftpError) -> FileError {
    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => FileError::new("not_found", "文件或目录不存在"),
            StatusCode::PermissionDenied => FileError::new("permission", "没有文件读写权限"),
            _ => FileError::new("io", format!("远程文件操作失败：{}", status.error_message)),
        },
        other => FileError::new("io", format!("远程连接失败：{other}")),
    }
}

/// SFTP 文件句柄的 tokio IO 错误（write_all / shutdown）
fn io_err(error: std::io::Error) -> FileError {
    FileError::new("io", format!("远程文件写入失败：{error}"))
}

/// revision = 内容 + mtime + 大小 的哈希；任何写入或替换都会改变它
fn revision(data: &[u8], meta: &FileAttributes) -> String {
    let mut digest = Sha256::new();
    digest.update(data);
    digest.update(meta.len().to_le_bytes());
    if let Ok(mtime) = meta.modified() {
        if let Ok(secs) = mtime.duration_since(std::time::UNIX_EPOCH) {
            digest.update(secs.as_secs().to_le_bytes());
            digest.update(secs.subsec_nanos().to_le_bytes());
        }
    }
    format!("{:x}", digest.finalize())
}

fn conflict() -> FileError {
    FileError::new(
        "conflict",
        "文件已被其他程序修改。请复制需要保留的内容后重新加载，或取消保存",
    )
}

/// 拼接 root 与已校验的相对组件（root 为 "/" 时不产生双斜杠）
fn join(root: &str, parts: &[&str]) -> String {
    let mut path = root.trim_end_matches('/').to_string();
    for part in parts {
        path.push('/');
        path.push_str(part);
    }
    if path.is_empty() {
        "/".into()
    } else {
        path
    }
}

/// 尽力清理写入用的临时文件
async fn cleanup(sftp: &SftpSession, temp: String) {
    let _ = sftp.remove_file(temp).await;
}

impl SshWorkspace {
    pub async fn connect(
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        path: &str,
    ) -> Result<Self, FileError> {
        let conn = SshConnection::connect(device, config_dir)
            .await
            .map_err(|e| FileError::new("io", format!("连接设备失败：{e}")))?;
        Self::from_connection(conn, path).await
    }

    /// 在已有连接上打开（运行流程复用 run 的连接，避免二次建连）
    pub async fn from_connection(conn: SshConnection, path: &str) -> Result<Self, FileError> {
        let sftp = open_sftp(&conn)
            .await
            .map_err(|e| FileError::new("io", format!("打开 SFTP 子系统失败：{e}")))?;
        let root = sftp.canonicalize(path).await.map_err(map_err)?;
        let meta = sftp.metadata(&root).await.map_err(map_err)?;
        if !meta.is_dir() {
            return Err(FileError::new("path", "工作区路径不是目录"));
        }
        Ok(Self {
            _conn: conn,
            sftp,
            root,
        })
    }

    async fn lstat(&self, path: &str) -> Result<FileAttributes, FileError> {
        self.sftp.symlink_metadata(path).await.map_err(map_err)
    }

    /// 解析根以下的相对组件：每一级祖先必须是真实目录，目标本身不得是链接
    async fn resolve(&self, parts: &[&str]) -> Result<(String, FileAttributes), FileError> {
        for (i, part) in parts.iter().enumerate() {
            let path = join(&self.root, &parts[..=i]);
            let meta = self.lstat(&path).await?;
            if meta.is_symlink() {
                return Err(invalid_path());
            }
            if i + 1 < parts.len() && !meta.is_dir() {
                return Err(FileError::new("not_found", format!("目录不存在：{part}")));
            }
            if i + 1 == parts.len() {
                return Ok((path, meta));
            }
        }
        Err(invalid_path())
    }

    /// 解析目标所在的父目录（必须真实存在且为目录）
    async fn resolve_parent<'a>(&self, parts: &[&'a str]) -> Result<(String, &'a str), FileError> {
        let (name, parents) = parts.split_last().ok_or_else(invalid_path)?;
        for (i, _) in parents.iter().enumerate() {
            let path = join(&self.root, &parents[..=i]);
            let meta = self.lstat(&path).await?;
            if meta.is_symlink() {
                return Err(invalid_path());
            }
            if !meta.is_dir() {
                return Err(FileError::new("not_found", "目录不存在"));
            }
        }
        Ok((join(&self.root, parents), name))
    }

    pub async fn list_dir(&self, subdir: &str) -> Result<Vec<Entry>, FileError> {
        let parts = if subdir.is_empty() {
            Vec::new()
        } else {
            workspace::components(subdir)?
        };
        let path = join(&self.root, &parts);
        if !parts.is_empty() {
            let meta = self.lstat(&path).await?;
            if meta.is_symlink() || !meta.is_dir() {
                return Err(invalid_path());
            }
        }
        let mut entries = Vec::new();
        for item in self.sftp.read_dir(&path).await.map_err(map_err)? {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            if meta.is_symlink() || (!meta.is_dir() && !meta.is_regular()) {
                continue;
            }
            entries.push(Entry {
                name,
                is_dir: meta.is_dir(),
            });
        }
        entries.sort_by(|a, b| (b.is_dir, a.name.as_str()).cmp(&(a.is_dir, b.name.as_str())));
        Ok(entries)
    }

    /// 读取原始字节（暂存下载用；limit 由调用方按 transport 策略给）
    pub async fn read_raw(&self, name: &str, limit: u64) -> Result<Vec<u8>, FileError> {
        let parts = workspace::components(name)?;
        let (path, meta) = self.resolve(&parts).await?;
        if !meta.is_regular() {
            return Err(invalid_path());
        }
        if meta.len() > limit {
            return Err(FileError::new("too_large", "文件超过大小上限"));
        }
        let data = self.sftp.read(&path).await.map_err(map_err)?;
        if data.len() as u64 > limit {
            return Err(FileError::new("too_large", "文件超过大小上限"));
        }
        Ok(data)
    }

    pub async fn read(&self, name: &str) -> Result<Document, FileError> {
        let parts = workspace::components(name)?;
        let (path, meta) = self.resolve(&parts).await?;
        if !meta.is_regular() {
            return Err(invalid_path());
        }
        if meta.len() > READ_LIMIT {
            return Err(FileError::new(
                "too_large",
                "编辑器最多支持 1 MiB，请使用外部编辑器",
            ));
        }
        let data = self.sftp.read(&path).await.map_err(map_err)?;
        if data.len() as u64 > READ_LIMIT {
            return Err(FileError::new(
                "too_large",
                "编辑器最多支持 1 MiB，请使用外部编辑器",
            ));
        }
        workspace::decode_document(&data, revision(&data, &meta))
    }

    /// 覆盖写入：临时文件 + 校验未变更 + rename（服务端不支持覆盖式 rename 时
    /// 退化为先删后改名，存在极短的缺文件窗口）。
    pub async fn write(
        &self,
        name: &str,
        data: &[u8],
        expected_revision: &str,
    ) -> Result<Saved, FileError> {
        let parts = workspace::components(name)?;
        let (path, meta) = self.resolve(&parts).await?;
        if !meta.is_regular() {
            return Err(invalid_path());
        }
        let original = self.sftp.read(&path).await.map_err(map_err)?;
        if revision(&original, &meta) != expected_revision {
            return Err(conflict());
        }
        let temp = format!(
            "{}/.rr-edit-{}.tmp",
            path.rsplit_once('/').map(|(d, _)| d).unwrap_or(""),
            uuid::Uuid::new_v4()
        );
        let written = async {
            let mut file = self
                .sftp
                .open_with_flags(
                    &temp,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(map_err)?;
            for chunk in data.chunks(64 * 1024) {
                file.write_all(chunk).await.map_err(io_err)?;
            }
            file.shutdown().await.map_err(io_err)?;
            let mut permissions = FileAttributes::default();
            permissions.permissions = meta.permissions;
            self.sftp
                .set_metadata(&temp, permissions)
                .await
                .map_err(map_err)?;
            Ok::<_, FileError>(())
        };
        if let Err(error) = written.await {
            cleanup(&self.sftp, temp).await;
            return Err(error);
        }
        // 替换前复查原文件未被并发修改
        let check = async {
            let latest_meta = self.lstat(&path).await?;
            let latest = self.sftp.read(&path).await.map_err(map_err)?;
            Ok::<_, FileError>(revision(&latest, &latest_meta) == expected_revision)
        };
        match check.await {
            Ok(true) => {}
            Ok(false) => {
                cleanup(&self.sftp, temp).await;
                return Err(conflict());
            }
            Err(error) => {
                cleanup(&self.sftp, temp).await;
                return Err(if error.code == "not_found" {
                    conflict()
                } else {
                    error
                });
            }
        }
        if let Err(first) = self.sftp.rename(&temp, &path).await {
            // OpenSSH 服务端的标准 RENAME 不覆盖已存在目标：先删后改名
            self.sftp.remove_file(&path).await.map_err(map_err)?;
            if let Err(error) = self.sftp.rename(&temp, &path).await {
                cleanup(&self.sftp, temp).await;
                return Err(map_err(error));
            }
            let _ = first;
        }
        // 替换后复读，确认内容与新 revision
        let (path, meta) = self.resolve(&parts).await?;
        let data = self.sftp.read(&path).await.map_err(map_err)?;
        let saved = workspace::decode_document(&data, revision(&data, &meta))?;
        Ok(Saved {
            revision: saved.revision,
        })
    }

    pub async fn create(&self, name: &str, kind: EntryKind) -> Result<(), FileError> {
        self.create_inner(name, kind, None).await
    }

    pub async fn create_with_content(&self, name: &str, data: &[u8]) -> Result<(), FileError> {
        self.create_inner(name, EntryKind::File, Some(data)).await
    }

    async fn create_inner(
        &self,
        name: &str,
        kind: EntryKind,
        data: Option<&[u8]>,
    ) -> Result<(), FileError> {
        let parts = workspace::components(name)?;
        let (dir, leaf) = self.resolve_parent(&parts).await?;
        let path = join(&dir, &[leaf]);
        if self.lstat(&path).await.is_ok() {
            return Err(FileError::new(
                "exists",
                format!("同名文件或目录已存在：{leaf}"),
            ));
        }
        match kind {
            EntryKind::Dir => {
                self.sftp.create_dir(&path).await.map_err(map_err)?;
            }
            EntryKind::File => {
                let mut file = self
                    .sftp
                    .open_with_flags(
                        &path,
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    )
                    .await
                    .map_err(map_err)?;
                if let Some(data) = data {
                    for chunk in data.chunks(64 * 1024) {
                        file.write_all(chunk).await.map_err(io_err)?;
                    }
                }
                file.shutdown().await.map_err(io_err)?;
            }
        }
        Ok(())
    }

    pub async fn rename(&self, old_name: &str, new_name: &str) -> Result<(), FileError> {
        let old_parts = workspace::components(old_name)?;
        let new_parts = workspace::components(new_name)?;
        if old_parts == new_parts {
            return Ok(());
        }
        if new_parts.starts_with(old_parts.as_slice()) {
            return Err(FileError::new("path", "不能把目录重命名到自身内部"));
        }
        let (source, _) = self.resolve(&old_parts).await?;
        let (dir, leaf) = self.resolve_parent(&new_parts).await?;
        let target = join(&dir, &[leaf]);
        if self.lstat(&target).await.is_ok() {
            return Err(FileError::new("exists", format!("目标已存在：{leaf}")));
        }
        self.sftp.rename(&source, &target).await.map_err(map_err)?;
        Ok(())
    }

    pub async fn delete(&self, name: &str) -> Result<(), FileError> {
        let parts = workspace::components(name)?;
        let (path, meta) = self.resolve(&parts).await?;
        if !meta.is_dir() {
            self.sftp.remove_file(&path).await.map_err(map_err)?;
            return Ok(());
        }
        // 递归删除：深度优先，链接按普通条目移除（remove_file 作用于链接自身）
        let mut budget = DELETE_ENTRY_LIMIT;
        let mut stack = vec![(path.clone(), false)];
        while let Some((current, visited)) = stack.pop() {
            if !visited {
                stack.push((current.clone(), true));
                let read = self.sftp.read_dir(&current).await.map_err(map_err)?;
                for item in read {
                    budget = budget
                        .checked_sub(1)
                        .ok_or_else(|| FileError::new("io", "删除条目超过上限"))?;
                    let child = item.path();
                    let meta = item.metadata();
                    if meta.is_dir() && !meta.is_symlink() {
                        stack.push((child, false));
                    } else {
                        self.sftp.remove_file(&child).await.map_err(map_err)?;
                    }
                }
            } else {
                self.sftp.remove_dir(&current).await.map_err(map_err)?;
            }
        }
        let _ = path;
        Ok(())
    }

    /// 同设备原地运行的入口检查：入口必须存在、是普通文件、不是链接；
    /// 返回 canonical 工作区根（供 cd 使用）。
    pub async fn check_script_entry(&self, entry: &str) -> Result<(), FileError> {
        let parts = workspace::components(entry)
            .map_err(|_| FileError::new("path", "入口必须是工作区内的相对路径"))?;
        let (_, meta) = self.resolve(&parts).await?;
        if !meta.is_regular() {
            return Err(FileError::new("path", "入口必须是工作区内的普通文件"));
        }
        Ok(())
    }

    pub fn root(&self) -> &str {
        &self.root
    }
}
