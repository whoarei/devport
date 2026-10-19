//! WSL 设备工作区：经 helper 的 fs_* 文件服务消息浏览 / 编辑发行版内目录（00029）。
//!
//! 与 VS Code-WSL 同构的 agent 模型：helper 进程在发行版内部执行文件操作，
//! dirfd + O_NOFOLLOW 把操作约束在工作区根内；协议帧经 wsl.exe 管道传输。
use crate::device::WslConfig;
use crate::workspace::{self, Document, Entry, EntryKind, FileError, Saved};
use crate::wsl::{helper_command, Bridge, Message};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;

const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// fs_create 内联内容上限（单控制帧 128 KiB 约束）
const CREATE_INLINE_LIMIT: usize = 48 * 1024;

pub struct WslWorkspace {
    bridge: Bridge,
}

fn io_error(error: impl std::fmt::Display) -> FileError {
    FileError::new("io", format!("WSL 文件服务失败：{error}"))
}

fn fs_error(code: String, message: String) -> FileError {
    let code: &'static str = match code.as_str() {
        "not_found" => "not_found",
        "permission" => "permission",
        "exists" => "exists",
        "conflict" => "conflict",
        "too_large" => "too_large",
        "path" => "path",
        _ => "io",
    };
    FileError::new(code, message)
}

impl WslWorkspace {
    pub async fn connect(config: &WslConfig, path: &str) -> Result<Self, FileError> {
        let bridge = Bridge::launch(helper_command(config).map_err(io_error)?)
            .await
            .map_err(io_error)?;
        let mut session = Self { bridge };
        session.ack(json!({"type":"fs_open","path":path})).await?;
        Ok(session)
    }

    async fn next(&mut self) -> Result<Message, FileError> {
        match tokio::time::timeout(IO_TIMEOUT, self.bridge.next()).await {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => Err(io_error(error)),
            Err(_) => Err(io_error("响应超时")),
        }
    }

    /// 发送请求并等待 ack / fs_error
    async fn ack(&mut self, request: Value) -> Result<(), FileError> {
        self.bridge.send(request).await.map_err(io_error)?;
        match self.next().await? {
            Message::Ack => Ok(()),
            Message::FsError { code, message } => Err(fs_error(code, message)),
            _ => Err(io_error("意外的文件服务响应")),
        }
    }

    pub async fn list_dir(&mut self, subdir: &str) -> Result<Vec<Entry>, FileError> {
        if !subdir.is_empty() {
            workspace::components(subdir)?;
        }
        self.bridge
            .send(json!({"type":"fs_list","path":subdir}))
            .await
            .map_err(io_error)?;
        let mut entries = Vec::new();
        loop {
            match self.next().await? {
                Message::FsEntry { name, dir, link } => {
                    if link || name == "." || name == ".." {
                        continue;
                    }
                    entries.push(Entry { name, is_dir: dir });
                }
                Message::FsDone => break,
                Message::FsError { code, message } => return Err(fs_error(code, message)),
                _ => return Err(io_error("意外的文件服务响应")),
            }
        }
        entries.sort_by(|a, b| (b.is_dir, a.name.as_str()).cmp(&(a.is_dir, b.name.as_str())));
        Ok(entries)
    }

    /// 读取文件内容与其 revision；limit 由 helper 侧严格执行
    async fn read_file(&mut self, name: &str, limit: u64) -> Result<(Vec<u8>, String), FileError> {
        workspace::components(name)?;
        self.bridge
            .send(json!({"type":"fs_read","path":name,"limit":limit}))
            .await
            .map_err(io_error)?;
        let (revision, size) = match self.next().await? {
            Message::FsFile { revision, size } => (revision, size),
            Message::FsError { code, message } => return Err(fs_error(code, message)),
            _ => return Err(io_error("意外的文件服务响应")),
        };
        let mut data = Vec::with_capacity(size.min(limit) as usize);
        loop {
            match self.next().await? {
                Message::FsChunk { data: chunk } => {
                    let chunk = STANDARD
                        .decode(&chunk)
                        .map_err(|_| io_error("无效的内容编码"))?;
                    data.extend_from_slice(&chunk);
                }
                Message::FsDone => break,
                Message::FsError { code, message } => return Err(fs_error(code, message)),
                _ => return Err(io_error("意外的文件服务响应")),
            }
        }
        if data.len() as u64 > limit {
            return Err(FileError::new("too_large", "文件超过大小上限"));
        }
        Ok((data, revision))
    }

    pub async fn read_raw(&mut self, name: &str, limit: u64) -> Result<Vec<u8>, FileError> {
        Ok(self.read_file(name, limit).await?.0)
    }

    pub async fn read(&mut self, name: &str) -> Result<Document, FileError> {
        let (data, revision) = self.read_file(name, workspace::FILE_LIMIT as u64).await?;
        workspace::decode_document(&data, revision)
    }

    pub async fn write(
        &mut self,
        name: &str,
        data: &[u8],
        expected_revision: &str,
    ) -> Result<Saved, FileError> {
        workspace::components(name)?;
        self.ack(json!({"type":"fs_write","path":name,"expected":expected_revision}))
            .await?;
        for chunk in data.chunks(48 * 1024) {
            self.ack(json!({"type":"fs_wchunk","data":STANDARD.encode(chunk)}))
                .await?;
        }
        self.bridge
            .send(json!({"type":"fs_wdone"}))
            .await
            .map_err(io_error)?;
        match self.next().await? {
            Message::FsSaved { revision } => Ok(Saved { revision }),
            Message::FsError { code, message } => Err(fs_error(code, message)),
            _ => Err(io_error("意外的文件服务响应")),
        }
    }

    pub async fn create(&mut self, name: &str, kind: EntryKind) -> Result<(), FileError> {
        workspace::components(name)?;
        let kind = match kind {
            EntryKind::File => "file",
            EntryKind::Dir => "dir",
        };
        self.ack(json!({"type":"fs_create","path":name,"kind":kind}))
            .await
    }

    pub async fn create_with_content(&mut self, name: &str, data: &[u8]) -> Result<(), FileError> {
        workspace::components(name)?;
        if data.len() > CREATE_INLINE_LIMIT {
            return Err(FileError::new("too_large", "内联创建内容超过上限"));
        }
        self.ack(json!({"type":"fs_create","path":name,"kind":"file","data":STANDARD.encode(data)}))
            .await
    }

    pub async fn rename(&mut self, old_name: &str, new_name: &str) -> Result<(), FileError> {
        workspace::components(old_name)?;
        workspace::components(new_name)?;
        self.ack(json!({"type":"fs_rename","from":old_name,"to":new_name}))
            .await
    }

    pub async fn delete(&mut self, name: &str) -> Result<(), FileError> {
        workspace::components(name)?;
        self.ack(json!({"type":"fs_delete","path":name})).await
    }
}
